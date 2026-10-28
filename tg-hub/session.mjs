// Shared session spawner: launches a Claude session in a PTY with our channel
// attached, auto-confirming startup prompts. Optional resumeId continues a past
// conversation (claude --resume <id>). Used by both launch.mjs and hub.mjs.
import pty from 'node-pty';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, appendFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const NPM_CLAUDE = process.platform === 'win32'
  ? 'C:\\Users\\vsavinov\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  : 'claude';
// The engine binary. CLAUDE_BIN wins; otherwise the newest VS Code extension's bundled
// one — it updates with the extension, while the npm global goes stale (2.1.216 here
// knew no Opus 5.5 and resolved `opus` to 4.x). Resolved per spawn, so an extension
// update reaches the next session without restarting the hub.
export function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const root = join(homedir(), '.vscode', 'extensions');
    const ver = n => (/^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(n) || []).slice(1).map(Number);
    const newer = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    for (const d of readdirSync(root).filter(n => ver(n).length === 3).sort(newer)) {
      const p = join(root, d, 'resources', 'native-binary', exe);
      if (existsSync(p)) return p;
    }
  } catch {}
  return NPM_CLAUDE;
}

// id          — our hub-side key for the shim (SESSION_ID); for managed sessions
//               this equals the claude conversation UUID
// cwd         — working dir for the claude session
// resumeId    — optional claude session_id to resume (--resume)
// sessionUuid — for NEW sessions, force claude's conversation id (--session-id)
//               so the hub records it and can always resume the session later
// shimPath    — absolute path to shim.mjs
// tmpDir      — scratch dir for per-session mcp.json + logs
// extraMcpServers   — optional extra mcpServers (consumer tools) merged next to `hub`
// extraAllowedTools — optional string|string[] appended to --allowedTools; empty by
//                     default so extra tools are NOT auto-allowed (they go through approval)
export function spawnSession({ id, cwd, resumeId, sessionUuid, shimPath, tmpDir, hubPort, hubToken, extraMcpServers, extraAllowedTools }) {
  // Variant A: hub-launched sessions on stream-json via the headless client
  // (control-protocol capable). Opt-in via HUB_STREAM=1 during bring-up; channels
  // (below) stays the default until the stream path is verified live.
  if (process.env.HUB_STREAM === '1')
    return spawnStreamSession({ id, cwd, resumeId, sessionUuid, tmpDir, hubPort, hubToken, extraMcpServers, extraAllowedTools });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const mcp = join(tmpDir, id + '.mcp.json');
  const shimLog = join(tmpDir, id + '.shim.log');
  const ptyLog = join(tmpDir, id + '.pty.log');

  writeFileSync(mcp, JSON.stringify({
    mcpServers: { hub: { command: 'node', args: [shimPath], env: { SESSION_ID: id, HUB_PORT: String(hubPort), HUB_TOKEN: hubToken, SHIM_LOG: shimLog } }, ...(extraMcpServers || {}) },
  }));

  const baseAllowed = 'mcp__hub__reply,mcp__hub__set_title';
  const extra = Array.isArray(extraAllowedTools) ? extraAllowedTools.join(',') : (extraAllowedTools || '');
  const allowed = extra ? `${baseAllowed},${extra}` : baseAllowed;
  const args = ['--mcp-config', mcp, '--strict-mcp-config', '--dangerously-load-development-channels', 'server:hub', '--allowedTools', allowed];
  if (resumeId) args.push('--resume', resumeId);
  else if (sessionUuid) args.push('--session-id', sessionUuid); // hub controls the conversation UUID → always resumable

  const childEnv = { ...process.env };
  delete childEnv.HUB_BOT_TOKEN; // sessions don't need the bot secret

  try { writeFileSync(ptyLog, ''); } catch {}
  try { rmSync(shimLog, { force: true }); } catch {} // so existsSync is true only once the NEW shim starts

  const p = pty.spawn(claudeBin(), args, { name: 'xterm-256color', cols: 120, rows: 40, cwd, env: childEnv });
  p.onData(d => { try { appendFileSync(ptyLog, d); } catch {} });

  // Auto-confirm startup prompts (folder trust, dev-channels warning) by pressing
  // Enter on a timer; stop once the shim's log appears (past prompts, MCP loaded).
  let n = 0;
  const iv = setInterval(() => {
    if (existsSync(shimLog)) { clearInterval(iv); return; }
    p.write('\r');
    if (++n >= 25) clearInterval(iv);
  }, 1200);

  return p;
}

// Has to outweigh the session's own history: one resumed from before the bridge took over
// replies had read "hub not joined" and "server disconnected", and a softer wording lost.
const STREAM_PROMPT = [
  'This session is driven from Telegram through tg-hub. User turns are messages typed in a Telegram chat.',
  'Every text answer you write here IS delivered to that chat, right now, by the bridge that runs this',
  'session — this does not depend on any MCP server or tool, the hub server included, and it is true even',
  'while servers are (re)connecting. So never tell the user you cannot write to them in Telegram: you are',
  'doing it with this very answer. There is no reply or set_title tool and none is needed; the session is',
  'named for you. Anything earlier in this conversation saying the hub disconnected or "hub not joined" is',
  'about those two tools only and is outdated. To send a file or picture use the hub send_file tool; for a',
  'standalone ping, notify. The user may not be at this computer.',
].join(' ');

// Variant A: spawn `node headless.mjs <claude> <stream-json args>`. The headless
// client spawns claude in stream-json (pipes, no PTY, no channels/shim), does the
// initialize handshake and bridges the session into the hub — so control-protocol
// commands (/context, /rc, /limits, /interrupt) work like the VSCode panel.
function spawnStreamSession({ id, cwd, resumeId, sessionUuid, tmpDir, hubPort, hubToken, extraMcpServers, extraAllowedTools }) {
  mkdirSync(cwd, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const sjArgs = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio', '--include-partial-messages', '--replay-user-messages'];
  // Optional consumer MCP servers (no `hub` server here — the headless client IS the bridge).
  if (extraMcpServers && Object.keys(extraMcpServers).length) {
    const mcp = join(tmpDir, id + '.mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: { ...extraMcpServers } }));
    sjArgs.push('--mcp-config', mcp, '--strict-mcp-config');
  }
  const extra = Array.isArray(extraAllowedTools) ? extraAllowedTools.join(',') : (extraAllowedTools || '');
  if (extra) sjArgs.push('--allowedTools', extra); // default empty → all tools gated via approval
  // The model can't tell on its own that its plain text reaches Telegram: here it has no
  // reply tool (the bridge mirrors answers), and a session from before that change was told
  // the hub server "disconnected" — it then insisted it couldn't write to the user at all.
  sjArgs.push('--append-system-prompt', STREAM_PROMPT);
  if (resumeId) sjArgs.push('--resume', resumeId);
  else if (sessionUuid) sjArgs.push('--session-id', sessionUuid);

  const childEnv = { ...process.env, SESSION_ID: id, HUB_PORT: String(hubPort), HUB_TOKEN: hubToken };
  delete childEnv.HUB_BOT_TOKEN; // sessions don't need the bot secret (HUB_OWNER_ID stays for reply fallback)

  const headless = join(HERE, 'panel', 'headless.mjs');
  return spawn(process.execPath, [headless, claudeBin(), ...sjArgs], { stdio: ['ignore', 'inherit', 'inherit'], cwd, env: childEnv });
}
