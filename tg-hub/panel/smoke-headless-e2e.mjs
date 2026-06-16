// Phase-2 e2e smoke: stand up a MOCK hub, spawn the real headless.mjs against it,
// and verify the full bridge end-to-end WITHOUT touching the real hub/sessions:
//   • headless registers (kind:'stream')
//   • a {t:'command',name:'context'} round-trips (control-protocol, no model turn)
//   • a {t:'inbound'} runs a real (tiny) model turn → assistant text mirrored back as reply
//   • any tool approval auto-allowed
// Run from repo root:  node tg-hub/panel/smoke-headless-e2e.mjs
import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');               // repo root (a trusted folder for claude)
const CLAUDE = process.env.CLAUDE_BIN || (process.platform === 'win32'
  ? 'C:\\Users\\vsavinov\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  : 'claude');
const PORT = 8790, TOKEN = 'smoke', SID = randomUUID();
const got = { registered: false, kind: null, contextReply: false, turnReply: false, perms: 0, replies: [] };
let child = null;

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
        sock.write(JSON.stringify({ t: 'command', name: 'context', chat_id: 'TEST' }) + '\n');     // token-free
        sock.write(JSON.stringify({ t: 'inbound', content: 'Ответь ровно одним словом: привет', meta: { chat_id: 'TEST' } }) + '\n');
      } else if (m.t === 'reply') {
        const txt = String(m.text || ''); got.replies.push(txt);
        console.log('[mockhub] REPLY:', JSON.stringify(txt).slice(0, 160));
        if (txt.startsWith('🧮')) got.contextReply = true; else got.turnReply = true;
        if (got.contextReply && got.turnReply) finish('got context + turn replies');
      } else if (m.t === 'permission_request') {
        got.perms++; console.log('[mockhub] PERM', m.tool_name);
        sock.write(JSON.stringify({ t: 'permission_decision', request_id: m.request_id, behavior: 'allow' }) + '\n');
      } else if (m.t === 'title') { console.log('[mockhub] title', m.title); }
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio', '--include-partial-messages', '--replay-user-messages', '--session-id', SID];
  const env = { ...process.env, SESSION_ID: SID, HUB_PORT: String(PORT), HUB_TOKEN: TOKEN, HUB_OWNER_ID: 'TEST' };
  console.log('[smoke] spawning headless.mjs (sid ' + SID.slice(0, 8) + ') against mock hub :' + PORT);
  child = spawn(process.execPath, [join(HERE, 'headless.mjs'), CLAUDE, ...args], { stdio: ['ignore', 'inherit', 'inherit'], env, cwd: ROOT });
  child.on('exit', (c, s) => console.log('[smoke] headless exit', c, s));
});

const timer = setTimeout(() => finish('timeout'), 75000);
function finish(why) {
  clearTimeout(timer);
  console.log('\n===== E2E RESULT =====', why);
  console.log('registered      :', got.registered, '(kind=' + got.kind + ')');
  console.log('context command :', got.contextReply);
  console.log('conversation    :', got.turnReply);
  console.log('approvals seen  :', got.perms);
  console.log('VERDICT         :', (got.registered && got.kind === 'stream' && got.contextReply && got.turnReply) ? 'PASS' : 'PARTIAL/FAIL');
  try { child?.kill(); } catch {}
  try { server.close(); } catch {}
  setTimeout(() => process.exit(0), 300);
}
