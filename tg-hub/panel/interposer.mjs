// Path 3: VSCode panel <-> Telegram hub bridge (stdio interposer).
// Spawned by panel-wrapper.exe as:  node interposer.mjs <claudeExe> <...claudeArgs>
//
// It sits on the panel's stream-json stdio: forwards BYTES verbatim in BOTH
// directions (so the panel keeps working untouched) AND bridges the session into
// the hub:
//   3b mirror  : engine {type:"assistant"} text  -> hub reply       -> Telegram
//   3c inject  : hub inbound (Telegram message)   -> {type:"user"}   -> engine stdin
//   3d approve : engine can_use_tool control_request -> hub buttons  -> control_response
//                (when a TG user is bound, the request is INTERCEPTED — suppressed from the
//                 panel so no dialog is left dangling in the VSCode UI — and answered solely
//                 from Telegram; with no TG user bound it passes through to the panel as usual)
//
// Hub IPC reuses the channel-shim contract (register/reply/title/permission_request
// <-> inbound/permission_decision/stop), so the panel session shows up in /sessions
// and routes like any other. It registers as a *non-managed* session, so the durable
// registry never tries to resume it (VSCode owns its lifecycle).
//
// Mirroring stays silent until a Telegram user actually messages this session
// (boundChatId is set on the first inbound) — a purely-local panel never spams TG.
// Set PANEL_BRIDGE=0 to disable the bridge and run pure observe-only.
//
// Everything is also logged: brief summary to panel-interposer.log, full untruncated
// JSON lines to panel-interposer-{in,out}.jsonl.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

// ── logging ──────────────────────────────────────────────────────────────────
const LOG = process.env.PANEL_INTERPOSER_LOG || join(tmpdir(), 'panel-interposer.log');
const FULL_IN = process.env.PANEL_INTERPOSER_IN || join(tmpdir(), 'panel-interposer-in.jsonl');
const FULL_OUT = process.env.PANEL_INTERPOSER_OUT || join(tmpdir(), 'panel-interposer-out.jsonl');
function raw(s) { try { appendFileSync(LOG, s); } catch {} }
function full(dir, line) { try { appendFileSync(dir.startsWith('IN') ? FULL_IN : FULL_OUT, line + '\n'); } catch {} }
function log(tag, data) { raw(`[${new Date().toISOString()}] ${tag}${data === undefined ? '' : ' ' + (typeof data === 'string' ? data : safeStr(data))}\n`); }
function safeStr(v) { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } }
function brief(o) {
  const t = o.type || o.method || '?';
  let x = '';
  try {
    if (o.type === 'user' && o.message) x = 'content=' + JSON.stringify(o.message.content).slice(0, 220);
    else if (o.type === 'assistant' && o.message) x = 'content=' + JSON.stringify(o.message.content).slice(0, 220);
    else if (o.type === 'stream_event') x = 'event=' + (o.event?.type || '') + ' ' + JSON.stringify(o.event?.delta || o.event?.content_block || o.event?.message || '').slice(0, 120);
    else if (o.type === 'result') x = JSON.stringify(o).slice(0, 200);
    else if (o.type === 'control_request' || o.type === 'control_response' || o.subtype || o.request) x = JSON.stringify(o).slice(0, 400);
    else x = JSON.stringify(o).slice(0, 200);
  } catch { x = '(unstringifiable)'; }
  return `${t} :: ${x}`;
}
function logLine(dir, line) {
  let summary;
  try { summary = brief(JSON.parse(line)); } catch { summary = '(non-json) ' + line.slice(0, 200); }
  raw(`[${new Date().toISOString()}] ${dir} ${summary}\n`);
  full(dir, line);
}

// ── hub discovery + client (mirror of shim.mjs) ──────────────────────────────
const BRIDGE = process.env.PANEL_BRIDGE !== '0';
function discover() {
  let port = Number(process.env.HUB_PORT) || 0;
  let token = process.env.HUB_TOKEN || '';
  if (!port || !token) {
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), '.claude', 'channels', 'hub', 'hub.json'), 'utf8'));
      if (!port) port = Number(cfg.port) || 0;
      if (!token) token = cfg.token || '';
    } catch {}
  }
  return { port: port || 8799, token: token || 'dev' };
}
const { port: HUB_PORT, token: HUB_TOKEN } = discover();

let hub = null, hubBuf = '', hubReady = false, queue = [], registered = false;
let sessionId = null, cwd = process.cwd(), boundChatId = '';

function connectHub() {
  hub = net.connect({ host: '127.0.0.1', port: HUB_PORT }, () => {
    hubReady = true;
    tryRegister();
    for (const m of queue) hub.write(JSON.stringify(m) + '\n');
    queue = [];
    log('hub connected', { HUB_PORT });
  });
  hub.setEncoding('utf8');
  hub.on('data', d => { hubBuf += d; let i; while ((i = hubBuf.indexOf('\n')) >= 0) { const line = hubBuf.slice(0, i); hubBuf = hubBuf.slice(i + 1); if (line.trim()) { try { onHub(JSON.parse(line)); } catch (e) { log('hub parse err', String(e)); } } } });
  hub.on('error', e => log('hub error', String(e)));
  hub.on('close', () => { hubReady = false; registered = false; log('hub closed; retry 2s'); setTimeout(connectHub, 2000); });
}
function sendHub(m) { if (!BRIDGE) return; if (hubReady && hub) hub.write(JSON.stringify(m) + '\n'); else queue.push(m); }
function tryRegister() {
  if (registered || !hubReady || !sessionId) return;
  registered = true;
  hub.write(JSON.stringify({ t: 'register', sessionId, token: HUB_TOKEN, cwd, ppid: child?.pid || process.pid }) + '\n');
  log('registered with hub', { sessionId, cwd });
}
function onHub(m) {
  log('HUB->', m);
  if (m.t === 'inbound') {
    boundChatId = String(m.meta?.chat_id || boundChatId || '');
    injectUser(String(m.content ?? ''));
  } else if (m.t === 'permission_decision') {
    resolveApproval(m.request_id, m.behavior);
  } else if (m.t === 'stop') {
    log('stop -> killing engine child', { pid: child?.pid });
    try { child.kill(); } catch {}
    setTimeout(() => process.exit(0), 300);
  }
}

// ── 3c: inject a Telegram message as a real user turn ────────────────────────
function injectUser(text) {
  if (!text) return;
  const msg = { type: 'user', uuid: randomUUID(), session_id: '', parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] } };
  try { child.stdin.write(JSON.stringify(msg) + '\n'); log('INJECT user', text.slice(0, 120)); }
  catch (e) { log('inject err', String(e)); }
}

// ── 3d: approvals (variant B — dual, first responder wins) ───────────────────
const approvals = new Map();    // realId(uuid) -> { synthId, input, toolUseId, resolved }
const synthToReal = new Map();  // synthId([a-z]{5}) -> realId  (hub's perm buttons key on [a-z]{5})
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
  if (!boundChatId) return;   // only route to TG once a remote user is engaged with this session
  const synthId = newSynthId();
  approvals.set(request_id, { synthId, input: req.input, toolUseId: req.tool_use_id, resolved: false });
  synthToReal.set(synthId, request_id);
  const tool = req.tool_name || req.display_name || 'tool';
  sendHub({ t: 'permission_request', sessionId, request_id: synthId,
    tool_name: tool,
    description: req.description || '',
    input_preview: toolPreview(tool, req.input) });
  log('approval -> hub', { synthId, tool, request_id });
}
function resolveApproval(synthId, behavior) {
  const realId = synthToReal.get(synthId);
  if (!realId) return;
  const a = approvals.get(realId);
  if (!a || a.resolved) return;   // already answered (by the panel, or a prior verdict)
  a.resolved = true;
  const response = behavior === 'allow'
    ? { behavior: 'allow', updatedInput: a.input, updatedPermissions: [], toolUseID: a.toolUseId }
    : { behavior: 'deny', message: 'Denied via Telegram' };
  const ctl = { type: 'control_response', response: { subtype: 'success', request_id: realId, response } };
  try { child.stdin.write(JSON.stringify(ctl) + '\n'); log('INJECT verdict', { realId, behavior }); }
  catch (e) { log('verdict inject err', String(e)); }
}

// ── direction taps & forwarding ──────────────────────────────────────────────
const DROP = Symbol('drop');   // onOut returns this to suppress forwarding a line (intercept)
function makeTap(dir, onObj) {  // IN side: observe only; the byte-pipe does the forwarding
  let buf = '';
  return chunk => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      logLine(dir, l);
      let o; try { o = JSON.parse(l); } catch { continue; }
      try { onObj(o); } catch (e) { log('tap handler err', String(e)); }
    }
  };
}
// OUT side: forward each complete line to the extension UNLESS onOut intercepts it
// (returns DROP). Line-buffered (not blind-piped) so we can drop an intercepted can_use_tool.
function outForwarder() {
  let buf = '';
  return chunk => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!l.trim()) { process.stdout.write(l + '\n'); continue; }
      logLine('OUT <<', l);
      let o = null, drop = false;
      try { o = JSON.parse(l); } catch {}
      if (o) { try { drop = onOut(o) === DROP; } catch (e) { log('onOut err', String(e)); } }
      if (!drop) process.stdout.write(l + '\n');
    }
  };
}
function onOut(o) {                                   // engine -> extension
  // identity: learn session_id ASAP — the first system hook (hook_started) already
  // carries it — and register immediately, so the panel shows up in /sessions even
  // before its first turn (system/init only fires once a turn starts). cwd defaults
  // to the interposer's cwd (= the panel workspace) and is refined from system/init.
  if (!sessionId && o.session_id) { sessionId = o.session_id; tryRegister(); }
  if (o.type === 'system' && o.subtype === 'init') {
    if (o.cwd) cwd = o.cwd;
    tryRegister();
    return;
  }
  // engine-generated session title -> name the hub session
  if (o.type === 'control_response' && o.response?.response?.title) {
    sendHub({ t: 'title', sessionId, title: String(o.response.response.title).slice(0, 60) });
    return;
  }
  // tool approval request: when a TG user is bound, INTERCEPT it (route to Telegram,
  // suppress the panel's own dialog so nothing is left dangling in the VSCode UI);
  // with no TG user bound, let it pass through for the panel to approve locally.
  if (o.type === 'control_request' && o.request?.subtype === 'can_use_tool') {
    if (boundChatId) { offerApproval(o.request, o.request_id); return DROP; }
    return;
  }
  // 3b mirror: assistant text -> Telegram (only once a TG user is bound)
  if (o.type === 'assistant' && o.message?.content && boundChatId) {
    for (const b of o.message.content) {
      if (b.type === 'text' && b.text?.trim()) sendHub({ t: 'reply', sessionId, chat_id: boundChatId, text: b.text });
    }
    return;
  }
}
function onIn(o) {                                    // extension -> engine
  // variant B: if the panel answered an approval first, stop waiting on TG for it
  if (o.type === 'control_response' && o.response?.request_id && approvals.has(o.response.request_id)) {
    const a = approvals.get(o.response.request_id);
    if (a && !a.resolved) { a.resolved = true; log('approval resolved by panel', { realId: o.response.request_id }); }
  }
}

// ── spawn + wire ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);          // [claudeExe, ...claudeArgs]
const exe = args[0], rest = args.slice(1);
raw(`\n[${new Date().toISOString()}] ===== INTERPOSER START (bridge=${BRIDGE}) =====\n  exe=${exe}\n  args=${JSON.stringify(rest)}\n  hub=${HUB_PORT}\n`);

const child = spawn(exe, rest, { stdio: ['pipe', 'pipe', 'inherit'] });   // stderr passes straight through

// Transparent byte forwarding (pipe handles backpressure) + a separate tap that
// only observes/bridges. Our own writes to child.stdin (inject/verdict) interleave
// at line boundaries with the piped extension bytes.
process.stdin.pipe(child.stdin);
process.stdin.on('data', makeTap('IN  >>', onIn));
// OUT is NOT blind-piped: outForwarder forwards line-by-line so it can DROP an
// intercepted can_use_tool (keeps the panel UI clean when a TG user is bound).
child.stdout.on('data', outForwarder());

process.stdin.on('end', () => { try { child.stdin.end(); } catch {} });
child.on('exit', (code, sig) => { raw(`[${new Date().toISOString()}] ===== EXIT code=${code} sig=${sig} =====\n`); try { hub?.end(); } catch {} process.exit(code == null ? 0 : code); });
child.on('error', e => { raw(`[${new Date().toISOString()}] CHILD_ERROR ${e?.message || e}\n`); process.exit(1); });

if (BRIDGE) connectHub();
