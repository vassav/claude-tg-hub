// Mock stream-json engine for smoke-browser: records mcp_set_servers maps to
// $MOCKENG_OUT (one JSON line per request), echoes injected user turns as
// assistant text so the smoke can assert what actually reached the engine.
import { appendFileSync } from 'node:fs';
const OUT = process.env.MOCKENG_OUT;
const send = o => process.stdout.write(JSON.stringify(o) + '\n');
send({ type: 'system', subtype: 'init', session_id: process.env.MOCKENG_SID || 'mock-sid', cwd: process.cwd() });
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) handle(l); } });
function handle(line) {
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o.type === 'control_request') {
    if (o.request?.subtype === 'mcp_set_servers' && OUT) appendFileSync(OUT, JSON.stringify(o.request.servers || {}) + '\n');
    send({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
  } else if (o.type === 'user') {
    const t = (o.message?.content || []).map(b => b.text || '').join('');
    send({ type: 'assistant', session_id: 'mock-sid', message: { role: 'assistant', content: [{ type: 'text', text: 'ECHO:' + t }] } });
  }
}
