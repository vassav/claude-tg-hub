// e2e smoke for Task 3: spawnSession({ ..., extraMcpServers }) — a CONSUMER MCP
// server's tool must (a) be visible to the session, (b) NOT be auto-allowed (it
// goes through permission approval -> Telegram buttons), (c) execute on approve.
//
// Self-contained: stands up a MOCK hub (TCP), spawns a real session via the real
// spawnSession (HUB_STREAM=1 -> stream/headless path, matching the live hub), wires
// a mock stdio-MCP server as the consumer tool, then drives one tool-call turn:
//   register -> inbound("call mcp__mock__ping") -> permission_request(approve) -> reply contains TOKEN
// Run from repo root:  node tg-hub/panel/smoke-extra-mcp.mjs
import net from 'node:net';
import { spawnSession } from '../session.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');                 // repo root — a trusted folder for claude
const MOCK = join(HERE, 'mock-mcp.mjs');
const TOKEN = 'MOCK-OK-7F3A9';
const PORT = 8791, HUBTOKEN = 'smoke3', SID = randomUUID();
const TMP = join(tmpdir(), 'hubsessions-smoke3');

process.env.HUB_STREAM = '1';                        // force the stream/headless path
process.env.HUB_OWNER_ID = 'TEST';

const got = { registered: false, kind: null, permTool: null, perms: 0, toolResult: false, replies: [] };
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
        got.registered = true; got.kind = m.kind;
        console.log('[mockhub] register', m.sessionId, 'kind=' + m.kind, 'cwd=' + m.cwd);
        if (!injected) { injected = true; setTimeout(() => {
          console.log('[mockhub] -> inbound: call mcp__mock__ping');
          sock.write(JSON.stringify({ t: 'inbound', content:
            'Вызови инструмент mcp__mock__ping (без аргументов). В ответе приведи РОВНО тот текст, что он вернёт — ничего больше.',
            meta: { chat_id: 'TEST' } }) + '\n');
        }, 5000); }
      } else if (m.t === 'permission_request') {
        got.perms++; got.permTool = m.tool_name;
        console.log('[mockhub] PERM', m.tool_name, '| preview:', JSON.stringify(m.input_preview || '').slice(0, 80));
        sock.write(JSON.stringify({ t: 'permission_decision', request_id: m.request_id, behavior: 'allow' }) + '\n');
      } else if (m.t === 'reply') {
        const txt = String(m.text || ''); got.replies.push(txt);
        console.log('[mockhub] REPLY:', JSON.stringify(txt).slice(0, 160));
        if (txt.includes(TOKEN)) { got.toolResult = true; finish('got tool result in reply'); }
      } else if (m.t === 'title') { console.log('[mockhub] title', m.title); }
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[smoke3] spawnSession sid', SID.slice(0, 8), '| extraMcpServers={ mock: node mock-mcp.mjs }');
  child = spawnSession({
    id: SID, cwd: ROOT, resumeId: null, sessionUuid: SID,
    tmpDir: TMP, hubPort: PORT, hubToken: HUBTOKEN,
    extraMcpServers: { mock: { command: process.execPath, args: [MOCK], env: { MOCK_TOKEN: TOKEN } } },
    // extraAllowedTools intentionally omitted -> mcp__mock__ping is NOT auto-allowed -> must hit approval
  });
  child.on?.('exit', (c, s) => console.log('[smoke3] session exit', c, s));
});

const timer = setTimeout(() => finish('timeout'), 90000);
let done = false;
function finish(why) {
  if (done) return; done = true;
  clearTimeout(timer);
  console.log('\n===== EXTRA-MCP RESULT =====', why);
  console.log('registered        :', got.registered, '(kind=' + got.kind + ')');
  console.log('approval requested :', got.perms > 0, '(tool=' + got.permTool + ')');
  console.log('tool executed      :', got.toolResult, '(token echoed back)');
  console.log('VERDICT            :', (got.registered && got.perms > 0 && got.toolResult) ? 'PASS' : 'PARTIAL/FAIL');
  try { child?.kill?.(); } catch {}
  try { server.close(); } catch {}
  setTimeout(() => process.exit(0), 300);
}
