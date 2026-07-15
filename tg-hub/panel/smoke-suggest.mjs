// Smoke: "don't ask again" — prove updatedPermissions actually sticks.
//   • mock hub + real headless.mjs + real claude, two file writes in one turn
//   • assert the FIRST approval carries the engine's permission_suggestions
//   • answer it with {behavior:'allow', suggestion:0} (engine sends
//     {setMode:'acceptEdits', destination:'session'} for edits)
//   • assert the SECOND write raises NO approval at all — that is the proof the
//     rule was applied session-wide rather than silently dropped.
// Run from repo root:  node tg-hub/panel/smoke-suggest.mjs
import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE = process.env.CLAUDE_BIN || (process.platform === 'win32'
  ? 'C:\\Users\\vsavinov\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  : 'claude');
const CWD = join(process.env.TEMP || '/tmp', 'smoke-suggest-' + process.pid);
rmSync(CWD, { recursive: true, force: true }); mkdirSync(CWD, { recursive: true });

const PORT = 8793, TOKEN = 'smoke', SID = randomUUID();
const PROMPT = 'Создай в текущей папке два файла инструментом Write: сначала a.txt с текстом AAA, '
  + 'затем b.txt с текстом BBB. Создай ОБА. Потом напиши ровно одно слово: ГОТОВО.';
const got = { registered: false, perms: [], suggestions: null, replies: [] };
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
        got.registered = true;
        console.log('[mockhub] register', m.sessionId, 'kind=' + m.kind);
        sock.write(JSON.stringify({ t: 'inbound', content: PROMPT, meta: { chat_id: 'TEST' } }) + '\n');

      } else if (m.t === 'permission_request') {
        got.perms.push({ tool: m.tool_name, suggestions: m.suggestions || null });
        console.log('[mockhub] PERM #' + got.perms.length, m.tool_name, '| suggestions:', JSON.stringify(m.suggestions || null));
        if (got.perms.length === 1) {
          got.suggestions = m.suggestions || null;
          if (got.suggestions?.length) {
            console.log('[mockhub] -> allow + suggestion[0] (should stop further edit prompts)');
            sock.write(JSON.stringify({ t: 'permission_decision', request_id: m.request_id, behavior: 'allow', suggestion: 0 }) + '\n');
          } else {
            console.log('[mockhub] !! no suggestions offered -> plain allow');
            sock.write(JSON.stringify({ t: 'permission_decision', request_id: m.request_id, behavior: 'allow' }) + '\n');
          }
        } else {
          console.log('[mockhub] -> plain allow (this one should NOT have been asked)');
          sock.write(JSON.stringify({ t: 'permission_decision', request_id: m.request_id, behavior: 'allow' }) + '\n');
        }

      } else if (m.t === 'reply') {
        const txt = String(m.text || ''); got.replies.push(txt);
        console.log('[mockhub] REPLY:', JSON.stringify(txt).slice(0, 120));
        if (/ГОТОВО/i.test(txt)) setTimeout(() => finish('model finished'), 1200);
      }
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio', '--include-partial-messages', '--replay-user-messages', '--session-id', SID];
  const env = { ...process.env, SESSION_ID: SID, HUB_PORT: String(PORT), HUB_TOKEN: TOKEN, HUB_OWNER_ID: 'TEST' };
  console.log('[smoke] cwd', CWD);
  child = spawn(process.execPath, [join(HERE, 'headless.mjs'), CLAUDE, ...args], { stdio: ['ignore', 'inherit', 'inherit'], env, cwd: CWD });
  child.on('exit', (c, s) => console.log('[smoke] headless exit', c, s));
});

const timer = setTimeout(() => finish('timeout'), 150000);
function finish(why) {
  clearTimeout(timer);
  const a = existsSync(join(CWD, 'a.txt')), b = existsSync(join(CWD, 'b.txt'));
  const offered = !!got.suggestions?.length;
  console.log('\n===== SUGGESTION SMOKE =====', why);
  console.log('registered        :', got.registered);
  console.log('suggestions offered:', offered, JSON.stringify(got.suggestions));
  console.log('approvals asked   :', got.perms.length, '(want exactly 1 — the 2nd write must not ask)');
  console.log('files written     : a.txt=' + a, 'b.txt=' + b);
  const pass = got.registered && offered && got.perms.length === 1 && a && b;
  console.log('VERDICT           :', pass ? 'PASS' : 'FAIL');
  try { child?.kill(); } catch {}
  try { server.close(); } catch {}
  setTimeout(() => process.exit(pass ? 0 : 1), 300);
}
