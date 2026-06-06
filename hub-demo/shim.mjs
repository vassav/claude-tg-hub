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
    hub.write(JSON.stringify({ t: 'register', sessionId: SESSION_ID, token: HUB_TOKEN, cwd: process.cwd() }) + '\n');
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
        'The user reaches you over Telegram and does NOT see this terminal. Their messages arrive as',
        '<channel source="hub" chat_id="..." message_id="..." user="..." ts="...">…</channel> blocks.',
        'To say ANYTHING to the user you MUST call the `reply` tool, passing chat_id from the inbound',
        '<channel> block. Your normal/transcript output never reaches them.',
        'Always send a `reply` when you finish a request (so their phone pings), and send brief interim',
        'replies during long tasks. If you need input, ask via `reply` and wait for their next message.',
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
    toEngine({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `unknown tool: ${params?.name}` }], isError: true } });
    return;
  }
  if (method && method.includes('permission_request')) {
    const p = params || {};
    sendHub({ t: 'permission_request', sessionId: SESSION_ID, request_id: p.request_id, tool_name: p.tool_name, description: p.description, input_preview: p.input_preview });
    return;
  }
  if (id !== undefined) toEngine({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

if (JOIN) connectHub();
log('shim start', { SESSION_ID, HUB_PORT, JOIN, ppid: process.ppid });
