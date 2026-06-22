#!/usr/bin/env node
// Per-session channel-shim. MCP "channel" server over stdio to the engine,
// bridged over TCP to the hub daemon. Zero deps (node builtins only).
//
// Works for BOTH:
//   • hub-managed sessions  (launcher sets SESSION_ID / HUB_PORT / HUB_TOKEN)
//   • user-launched sessions (plugin, no env) — self-discovers the hub and
//     self-assigns a session id. Joins the hub only when intended (SESSION_ID
//     from the launcher, or HUB_JOIN=1 in the user's shell), so a plain session
//     that merely has the plugin enabled stays passive and doesn't register.
import net from 'node:net';
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

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
const SESSION_ID = process.env.SESSION_ID || (basename(process.cwd()) + '-' + process.pid);
const JOIN = !!(process.env.SESSION_ID || process.env.HUB_JOIN); // only attach to the hub when intended
const LOG = process.env.SHIM_LOG || '';

function log(tag, data) { if (!LOG) return; try { appendFileSync(LOG, `[${new Date().toISOString()}][${SESSION_ID}] ${tag} ${data === undefined ? '' : JSON.stringify(data)}\n`); } catch {} }
function toEngine(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); log('ENGINE<-', msg); }

// ── hub TCP client (only if JOIN) ────────────────────────────────────────────
let hub = null, hubBuf = '', hubReady = false, queue = [];
function connectHub() {
  hub = net.connect({ host: '127.0.0.1', port: HUB_PORT }, () => {
    hubReady = true;
    hub.write(JSON.stringify({ t: 'register', sessionId: SESSION_ID, token: HUB_TOKEN, cwd: process.cwd(), ppid: process.ppid }) + '\n');
    for (const m of queue) hub.write(JSON.stringify(m) + '\n');
    queue = [];
    log('hub connected');
  });
  hub.setEncoding('utf8');
  hub.on('data', d => { hubBuf += d; let i; while ((i = hubBuf.indexOf('\n')) >= 0) { const line = hubBuf.slice(0, i); hubBuf = hubBuf.slice(i + 1); if (line.trim()) { try { onHub(JSON.parse(line)); } catch (e) { log('hub parse err', String(e)); } } } });
  hub.on('error', e => log('hub error', String(e)));
  hub.on('close', () => { hubReady = false; log('hub closed; retry 2s'); setTimeout(connectHub, 2000); });
}
function sendHub(m) { if (!JOIN) return; if (hubReady && hub) hub.write(JSON.stringify(m) + '\n'); else queue.push(m); }
// Standalone Telegram notification to the hub's home chat. Unlike sendHub (gated by
// JOIN, rides the persistent channel link), this opens a ONE-SHOT TCP to the hub —
// so it works even from a session that merely has the plugin loaded but hasn't
// joined the hub. The hub's {t:'notify'} branch delivers it via its single bot.
function notifyHub(text, chat_id) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port: HUB_PORT });
    let buf = '', done = false;
    const fin = v => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(v); };
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ t: 'notify', token: HUB_TOKEN, text, ...(chat_id ? { chat_id } : {}) }) + '\n'));
    sock.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { let r; try { r = JSON.parse(buf.slice(0, i)); } catch {} fin(r || { ok: false, error: 'bad response' }); } });
    sock.on('error', e => fin({ ok: false, error: 'hub not reachable: ' + (e.code || e.message) }));
    sock.on('close', () => fin({ ok: false, error: 'hub closed (token?)' }));
    setTimeout(() => fin({ ok: false, error: 'timeout (is the hub running?)' }), 5000);
  });
}
function onHub(m) {
  log('HUB->', m);
  if (m.t === 'inbound') toEngine({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: m.content, meta: m.meta || {} } });
  else if (m.t === 'permission_decision') toEngine({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission', params: { request_id: m.request_id, behavior: m.behavior } });
  else if (m.t === 'stop') {
    // We are a child of the claude process (process.ppid). Kill it to stop the
    // session — works for hub-managed AND user-launched sessions alike.
    log('STOP -> killing parent claude', { ppid: process.ppid });
    try { process.kill(process.ppid); } catch (e) { log('stop kill err', String(e)); }
    setTimeout(() => process.exit(0), 300);
  }
}

// ── engine → shim ────────────────────────────────────────────────────────────
let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { inBuf += c; let i; while ((i = inBuf.indexOf('\n')) >= 0) { const line = inBuf.slice(0, i); inBuf = inBuf.slice(i + 1); if (line.trim()) { try { handle(JSON.parse(line)); } catch (e) { log('engine parse err', String(e)); } } } });
process.stdin.on('end', () => { try { hub?.end(); } catch {} process.exit(0); });

function handle(msg) {
  log('ENGINE->', msg);
  const { id, method, params } = msg;
  if (method === 'initialize') {
    toEngine({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} },
      serverInfo: { name: 'tg-hub-shim', version: '0.0.3' },
      instructions: [
        'Some user messages arrive wrapped in <channel source="hub" chat_id="..." message_id="..." user="..." ts="...">…</channel>.',
        'These come from a REMOTE user on Telegram who is NOT at this computer and does NOT see this window, panel, or terminal.',
        'The ONLY way to answer a <channel> message is to call the `reply` tool with the chat_id from its tag —',
        'anything you display locally (panel/terminal/transcript) does NOT reach them.',
        'So for EVERY <channel> message you MUST call `reply` with your answer (even if you also respond locally);',
        'send brief interim `reply`s during long tasks and a final `reply` when done so their phone pings.',
        'If you need input, ask via `reply` and wait for their next <channel> message.',
        'Right after handling the FIRST <channel> message of a new conversation, also call `set_title` ONCE with',
        "a short (≤40 chars) title summarizing it, in the user's language. Do not announce set_title.",
      ].join(' '),
    }});
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    toEngine({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'reply',
      description: 'Send a message to the user over Telegram. Pass chat_id from the inbound <channel> tag and the text to send.',
      inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'] },
    }, {
      name: 'set_title',
      description: 'Name this session with a short title (≤40 chars) summarizing what it is about. Call once after the first user message; not shown in chat.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    }, {
      name: 'notify',
      description: 'Send a standalone notification to the user on Telegram via the hub. Unlike `reply` (which answers an inbound <channel> message and needs its chat_id), `notify` needs no chat_id and works even if this session is NOT attached to the hub — use it to ping the user when a long task finishes or needs their attention.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Message text; Markdown is rendered.' }, chat_id: { type: 'string', description: 'Optional target chat; defaults to the hub home chat.' } }, required: ['text'] },
    }] }});
    return;
  }
  if (method === 'tools/call') {
    const a = params?.arguments || {};
    if (params?.name === 'reply') {
      sendHub({ t: 'reply', sessionId: SESSION_ID, chat_id: String(a.chat_id || ''), text: String(a.text ?? '') });
      toEngine({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JOIN ? 'sent' : 'hub not joined' }] } });
      return;
    }
    if (params?.name === 'set_title') {
      sendHub({ t: 'title', sessionId: SESSION_ID, title: String(a.title ?? '') });
      toEngine({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JOIN ? 'session named' : 'hub not joined' }] } });
      return;
    }
    if (params?.name === 'notify') {
      const text = String(a.text ?? '').trim();
      if (!text) { toEngine({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'text is required' }], isError: true } }); return; }
      notifyHub(text, a.chat_id ? String(a.chat_id) : undefined).then(r => {
        toEngine({ jsonrpc: '2.0', id, result: (r && r.ok)
          ? { content: [{ type: 'text', text: 'sent to Telegram' }] }
          : { content: [{ type: 'text', text: 'failed: ' + (r?.error || 'unknown') }], isError: true } });
      });
      return;
    }
    toEngine({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `unknown tool: ${params?.name}` }], isError: true } });
    return;
  }
  if (method && method.includes('permission_request')) {
    const p = params || {};
    // Our own channel tools (reply / set_title, under the 'hub' MCP server) are
    // internal plumbing — auto-allow them locally so they NEVER prompt the user,
    // regardless of --allowedTools or the claude version. Real actions
    // (Bash/Write/…) still go to Telegram for approval.
    if (String(p.tool_name || '').startsWith('mcp__hub__')) {
      toEngine({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission', params: { request_id: p.request_id, behavior: 'allow' } });
      log('auto-allowed own tool', p.tool_name);
      return;
    }
    sendHub({ t: 'permission_request', sessionId: SESSION_ID, request_id: p.request_id, tool_name: p.tool_name, description: p.description, input_preview: p.input_preview });
    return;
  }
  if (id !== undefined) toEngine({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

if (JOIN) connectHub();
log('shim start', { SESSION_ID, HUB_PORT, JOIN, ppid: process.ppid });
