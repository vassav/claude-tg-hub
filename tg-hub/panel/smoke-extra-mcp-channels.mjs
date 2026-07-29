// Task 3, CHANNELS path (the default, HUB_STREAM unset): same as smoke-extra-mcp
// but exercises the PTY+shim transport. The consumer tool mcp__mock__ping is NOT
// in --allowedTools, so shim.mjs routes its permission_request to the (mock) hub;
// on approve the engine runs it; the model relays the token via mcp__hub__reply.
//   register -> inbound -> permission_request(mcp__mock__ping, approve) -> reply contains TOKEN
// Run from repo root:  node tg-hub/panel/smoke-extra-mcp-channels.mjs
import net from 'node:net';
import { spawnSession } from '../session.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');                 // repo root — a trusted folder for claude
const SHIM = join(HERE, '..', 'shim.mjs');
const MOCK = join(HERE, 'mock-mcp.mjs');
const TOKEN = 'MOCK-OK-3C5B2';
const PORT = 8800, HUBTOKEN = 'smoke4', SID = randomUUID();
const TMP = join(tmpdir(), 'hubsessions-smoke4');

delete process.env.HUB_STREAM;                       // force the default channels path
process.env.HUB_OWNER_ID = 'TEST';

const got = { registered: false, permTool: null, perms: 0, toolResult: false, replies: [] };
let child = null, injected = false;

const server = net.createServer(sock => {
  let buf = ''; sock.setEncoding('utf8');
  sock.on('error', () => {});
  sock.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      if (m.t === 'register') {
        got.registered = true;
        console.log('[mockhub] register', m.sessionId, 'cwd=' + m.cwd);
        if (!injected) { injected = true; setTimeout(() => {
          console.log('[mockhub] -> inbound: call mcp__mock__ping then reply');
          sock.write(JSON.stringify({ t: 'inbound', content:
            'Вызови инструмент mcp__mock__ping (без аргументов). Затем через инструмент reply отправь РОВНО тот текст, что он вернул (ничего больше).',
            meta: { chat_id: 'TEST' } }) + '\n');
        }, 4000); }
      } else if (m.t === 'permission_request') {
        got.perms++; got.permTool = m.tool_name;
        console.log('[mockhub] PERM', m.tool_name, '| preview:', JSON.stringify(m.input_preview || '').slice(0, 80));
        sock.write(JSON.stringify({ t: 'permission_decision', request_id: m.request_id, behavior: 'allow' }) + '\n');
      } else if (m.t === 'reply') {
        const txt = String(m.text || ''); got.replies.push(txt);
        console.log('[mockhub] REPLY:', JSON.stringify(txt).slice(0, 160));
        if (txt.includes(TOKEN)) { got.toolResult = true; finish('got tool result via reply'); }
      } else if (m.t === 'title') { console.log('[mockhub] title', m.title); }
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[smoke4] spawnSession (channels) sid', SID.slice(0, 8), '| extraMcpServers={ mock }');
  child = spawnSession({
    id: SID, cwd: ROOT, resumeId: null, sessionUuid: SID, shimPath: SHIM,
    tmpDir: TMP, hubPort: PORT, hubToken: HUBTOKEN,
    extraMcpServers: { mock: { command: process.execPath, args: [MOCK], env: { MOCK_TOKEN: TOKEN } } },
    // extraAllowedTools omitted -> mcp__mock__ping must go through approval
  });
});

const timer = setTimeout(() => finish('timeout'), 130000);
let done = false;
function finish(why) {
  if (done) return; done = true;
  clearTimeout(timer);
  console.log('\n===== EXTRA-MCP (channels) RESULT =====', why);
  console.log('registered         :', got.registered);
  console.log('approval requested  :', got.perms > 0, '(tool=' + got.permTool + ')');
  console.log('tool executed       :', got.toolResult, '(token relayed via reply)');
  console.log('VERDICT             :', (got.registered && got.perms > 0 && got.toolResult) ? 'PASS' : 'PARTIAL/FAIL');
  try { child?.kill?.(); } catch {}
  try { server.close(); } catch {}
  setTimeout(() => process.exit(0), 300);
}
