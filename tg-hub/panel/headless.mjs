// Headless stream-json client for HUB-LAUNCHED sessions (variant A).
// Spawned by session.mjs as:  node headless.mjs <claudeExe> <...claudeArgs>
// (claudeArgs already include --input-format/--output-format stream-json etc.)
//
// Unlike the panel interposer (which sits BETWEEN the VSCode extension and the
// engine), here there is NO extension — this process IS the client. The engine
// still runs the agent/tool loop itself; we are the thin client that:
//   • does the startup handshake (initialize with EMPTY hooks → no hook_callback)
//   • injects Telegram messages as user-turns                  (hub inbound -> {type:user})
//   • mirrors assistant text to Telegram                       (engine assistant -> hub reply)
//   • routes tool approvals to Telegram buttons                (can_use_tool <-> control_response)
//   • runs panel commands on demand                            (hub command -> control_request)
//   • caches the 5-hour rate-limit from passive rate_limit_event
//
// Env: SESSION_ID (forced --session-id uuid), HUB_PORT, HUB_TOKEN, HUB_OWNER_ID.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createCommands } from './commands.mjs';

// ── config / logging ─────────────────────────────────────────────────────────
const SESSION_ID = process.env.SESSION_ID || ('headless-' + process.pid);
const HUB_PORT = Number(process.env.HUB_PORT) || 8799;
const HUB_TOKEN = process.env.HUB_TOKEN || 'dev';
const OWNER = String(process.env.HUB_OWNER_ID || '');
const LOG = process.env.HEADLESS_LOG || join(tmpdir(), 'headless-' + SESSION_ID + '.log');
function log(tag, data) { try { appendFileSync(LOG, `[${new Date().toISOString()}] ${tag}${data === undefined ? '' : ' ' + (typeof data === 'string' ? data : safeStr(data))}\n`); } catch {} }
function safeStr(v) { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } }

const args = process.argv.slice(2);            // [claudeExe, ...claudeArgs]
const exe = args[0], rest = args.slice(1);
let cwd = process.cwd(), boundChatId = '';

// ── hub TCP client (mirror of shim/interposer) ───────────────────────────────
let hub = null, hubBuf = '', hubReady = false, queue = [], registered = false;
function connectHub() {
  hub = net.connect({ host: '127.0.0.1', port: HUB_PORT }, () => {
    hubReady = true; tryRegister();
    for (const m of queue) hub.write(JSON.stringify(m) + '\n');
    queue = [];
    log('hub connected', { HUB_PORT });
  });
  hub.setEncoding('utf8');
  hub.on('data', d => { hubBuf += d; let i; while ((i = hubBuf.indexOf('\n')) >= 0) { const line = hubBuf.slice(0, i); hubBuf = hubBuf.slice(i + 1); if (line.trim()) { try { onHub(JSON.parse(line)); } catch (e) { log('hub parse err', String(e)); } } } });
  hub.on('error', e => log('hub error', String(e)));
  hub.on('close', () => { hubReady = false; registered = false; log('hub closed; retry 2s'); setTimeout(connectHub, 2000); });
}
function sendHub(m) { if (hubReady && hub) hub.write(JSON.stringify(m) + '\n'); else queue.push(m); }
function tryRegister() {
  if (registered || !hubReady) return;
  registered = true;
  // kind:'stream' → control-capable (panel-style commands available), unlike channels CLI sessions.
  hub.write(JSON.stringify({ t: 'register', sessionId: SESSION_ID, token: HUB_TOKEN, cwd, ppid: child?.pid || process.pid, kind: 'stream' }) + '\n');
  log('registered with hub', { SESSION_ID, cwd });
}
function onHub(m) {
  log('HUB->', m);
  if (m.t === 'inbound') {
    boundChatId = String(m.meta?.chat_id || boundChatId || OWNER || '');
    injectUser(String(m.content ?? ''));
  } else if (m.t === 'permission_decision') {
    resolveApproval(m.request_id, m.behavior);
  } else if (m.t === 'command') {
    cmds.handle(String(m.name || ''), String(m.chat_id || boundChatId || OWNER || ''));
  } else if (m.t === 'stop') {
    log('stop -> killing engine', { pid: child?.pid });
    try { child.kill(); } catch {}
    setTimeout(() => process.exit(0), 300);
  }
}

// ── write to engine ──────────────────────────────────────────────────────────
function toEngine(obj) { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) { log('engine write err', String(e)); } }
function injectUser(text) {
  if (!text) return;
  toEngine({ type: 'user', uuid: randomUUID(), session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } });
  log('INJECT user', text.slice(0, 120));
}

// shared control-protocol command logic (also used by the panel interposer)
const cmds = createCommands({ toEngine, sendHub, sessionId: SESSION_ID, owner: OWNER, injectUser });

// ── approvals (this client is the SOLE approver — always route to Telegram) ───
const approvals = new Map();    // realId -> { synthId, input, toolUseId, resolved }
const synthToReal = new Map();  // synthId([a-z]{5}) -> realId  (hub perm buttons key on [a-z]{5})
function newSynthId() { let s; do { s = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join(''); } while (synthToReal.has(s)); return s; }
function toolPreview(tool, input) {
  const i = input || {};
  if (tool === 'ExitPlanMode') return String(i.plan || '').slice(0, 2500);
  if (tool === 'Write') return `${i.file_path || ''}\n\n${String(i.content || '').slice(0, 800)}`;
  if (tool === 'Edit' || tool === 'MultiEdit') return String(i.file_path || '');
  if (tool === 'Bash') return String(i.command || '');
  if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') return safeStr(i.file_path || i.pattern || i.path || i).slice(0, 300);
  return safeStr(i).slice(0, 600);
}
function offerApproval(req, request_id) {
  const synthId = newSynthId();
  approvals.set(request_id, { synthId, input: req.input, toolUseId: req.tool_use_id, resolved: false });
  synthToReal.set(synthId, request_id);
  const tool = req.tool_name || req.display_name || 'tool';
  sendHub({ t: 'permission_request', sessionId: SESSION_ID, request_id: synthId, tool_name: tool, description: req.description || '', input_preview: toolPreview(tool, req.input) });
  log('approval -> hub', { synthId, tool, request_id });
}
function resolveApproval(synthId, behavior) {
  const realId = synthToReal.get(synthId);
  if (!realId) return;
  const a = approvals.get(realId);
  if (!a || a.resolved) return;
  a.resolved = true;
  const response = behavior === 'allow'
    ? { behavior: 'allow', updatedInput: a.input, updatedPermissions: [], toolUseID: a.toolUseId }
    : { behavior: 'deny', message: 'Denied via Telegram' };
  toEngine({ type: 'control_response', response: { subtype: 'success', request_id: realId, response } });
  log('INJECT verdict', { realId, behavior });
}

// ── engine output handler ─────────────────────────────────────────────────────
function onEngine(o) {
  // my own control-command responses (context/rc) — formatted + sent to Telegram
  if (o.type === 'control_response') {
    if (cmds.onControlResponse(o)) return;
    // engine-generated session title -> name the hub session
    if (o.response?.response?.title) { sendHub({ t: 'title', sessionId: SESSION_ID, title: String(o.response.response.title).slice(0, 60) }); return; }
    return;
  }
  // tool approval request -> Telegram buttons
  if (o.type === 'control_request' && o.request?.subtype === 'can_use_tool') { offerApproval(o.request, o.request_id); return; }
  // mirror assistant text
  if (o.type === 'assistant' && o.message?.content) {
    const to = boundChatId || OWNER;
    if (to) for (const b of o.message.content) if (b.type === 'text' && b.text?.trim()) sendHub({ t: 'reply', sessionId: SESSION_ID, chat_id: to, text: b.text });
    return;
  }
}

// ── spawn + wire ──────────────────────────────────────────────────────────────
log('===== HEADLESS START =====', { exe, rest, HUB_PORT, SESSION_ID });
// Strip hub-coordination env from the CLAUDE child: if the hub channel PLUGIN is
// globally enabled, its shim.mjs would otherwise inherit SESSION_ID/HUB_* and
// self-join the hub (a second, kind-less registration that fights ours and disrupts
// the turn). We are the only bridge — keep that shim passive. (We already captured
// these values into module consts above.)
const childEnv = { ...process.env };
for (const k of ['SESSION_ID', 'HUB_PORT', 'HUB_TOKEN', 'HUB_JOIN', 'HUB_BOT_TOKEN']) delete childEnv[k];
const child = spawn(exe, rest, { stdio: ['pipe', 'pipe', 'inherit'], cwd, env: childEnv });

// startup handshake: empty hooks so the engine never fires hook_callback (which we
// have no UI to answer); default permission mode (tools still gated via can_use_tool).
toEngine({ type: 'control_request', request_id: 'init-' + randomUUID().slice(0, 8), request: { subtype: 'initialize', hooks: {} } });
toEngine({ type: 'control_request', request_id: 'pm-' + randomUUID().slice(0, 8), request: { subtype: 'set_permission_mode', mode: 'default' } });

let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    try { onEngine(o); } catch (e) { log('onEngine err', String(e)); }
  }
});
child.on('exit', (code, sig) => { log('engine exit', { code, sig }); try { hub?.end(); } catch {} process.exit(code == null ? 0 : code); });
child.on('error', e => { log('spawn error', String(e?.message || e)); process.exit(1); });

connectHub();
