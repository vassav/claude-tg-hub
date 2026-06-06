// Shared session spawner: launches a Claude session in a PTY with our channel
// attached, auto-confirming startup prompts. Optional resumeId continues a past
// conversation (claude --resume <id>). Used by both launch.mjs and hub.mjs.
import pty from 'node-pty';
import { writeFileSync, mkdirSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE = process.env.CLAUDE_BIN
  || 'C:\\Users\\vsavinov\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

// id        — our hub-side label/key for the shim (SESSION_ID)
// cwd       — working dir for the claude session
// resumeId  — optional claude session_id to resume (--resume)
// shimPath  — absolute path to shim.mjs
// tmpDir    — scratch dir for per-session mcp.json + logs
export function spawnSession({ id, cwd, resumeId, shimPath, tmpDir, hubPort, hubToken }) {
  mkdirSync(cwd, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const mcp = join(tmpDir, id + '.mcp.json');
  const shimLog = join(tmpDir, id + '.shim.log');
  const ptyLog = join(tmpDir, id + '.pty.log');

  writeFileSync(mcp, JSON.stringify({
    mcpServers: { hub: { command: 'node', args: [shimPath], env: { SESSION_ID: id, HUB_PORT: String(hubPort), HUB_TOKEN: hubToken, SHIM_LOG: shimLog } } },
  }));

  const args = ['--mcp-config', mcp, '--strict-mcp-config', '--dangerously-load-development-channels', 'server:hub', '--allowedTools', 'mcp__hub__reply'];
  if (resumeId) args.push('--resume', resumeId);

  const childEnv = { ...process.env };
  delete childEnv.HUB_BOT_TOKEN; // sessions don't need the bot secret

  try { writeFileSync(ptyLog, ''); } catch {}
  try { rmSync(shimLog, { force: true }); } catch {} // so existsSync is true only once the NEW shim starts

  const p = pty.spawn(CLAUDE, args, { name: 'xterm-256color', cols: 120, rows: 40, cwd, env: childEnv });
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
