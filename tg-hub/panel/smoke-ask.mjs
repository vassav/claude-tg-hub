// Phase-1 smoke: prove AskUserQuestion round-trips through the hub IPC as real options
// and that our updatedInput.answers actually reaches the engine.
//   • mock hub + real headless.mjs + real claude (no Telegram, no real hub)
//   • assert the permission_request carries `ask` with 2+ options (not just Allow/Deny)
//   • answer with INDICES ({behavior:'allow', answers:[[1]]})
//   • assert the model's later reply echoes the label of the option we picked —
//     the tool only echoes answers it found in its own input, so seeing that label
//     is proof updatedInput.answers landed.
// Run from repo root:  node tg-hub/panel/smoke-ask.mjs        (allow + answers)
//                      node tg-hub/panel/smoke-ask.mjs --deny (deny + reason)
import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLAUDE = process.env.CLAUDE_BIN || (process.platform === 'win32'
  ? 'C:\\Users\\vsavinov\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  : 'claude');
const DENY = process.argv.includes('--deny');
const PORT = 8792, TOKEN = 'smoke', SID = randomUUID();
const DENY_MSG = 'User cancelled the question in Telegram.';
const ASK = 'Задай мне через инструмент AskUserQuestion ровно один вопрос: "Какой цвет?" с двумя вариантами: '
  + '"Красный" и "Синий". Как только получишь мой ответ, напиши ровно одну строку вида ВЫБРАНО=<вариант> '
  + 'и больше ничего не делай. Никаких других инструментов не вызывай.';

const got = { registered: false, ask: null, picked: null, echoed: false, replies: [], otherPerms: [] };
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
        sock.write(JSON.stringify({ t: 'inbound', content: ASK, meta: { chat_id: 'TEST' } }) + '\n');

      } else if (m.t === 'permission_request') {
        if (!m.ask) {                                  // any other tool -> just let it through
          got.otherPerms.push(m.tool_name);
          console.log('[mockhub] PERM (no ask)', m.tool_name, '-> allow');
          sock.write(JSON.stringify({ t: 'permission_decision', request_id: m.request_id, behavior: 'allow' }) + '\n');
          continue;
        }
        got.ask = m.ask;
        const q = m.ask.questions[0];
        console.log('[mockhub] ASK:', JSON.stringify({ question: q.question, header: q.header, multiSelect: q.multiSelect, options: q.options.map(o => o.label) }));
        if (DENY) {
          console.log('[mockhub] -> deny with reason');
          sock.write(JSON.stringify({ t: 'permission_decision', request_id: m.request_id, behavior: 'deny', message: DENY_MSG }) + '\n');
        } else {
          got.picked = q.options[1].label;             // pick the SECOND option by index
          console.log('[mockhub] -> allow, answers=[[1]] (label ' + JSON.stringify(got.picked) + ')');
          sock.write(JSON.stringify({ t: 'permission_decision', request_id: m.request_id, behavior: 'allow', answers: [[1]] }) + '\n');
        }

      } else if (m.t === 'reply') {
        const txt = String(m.text || ''); got.replies.push(txt);
        console.log('[mockhub] REPLY:', JSON.stringify(txt).slice(0, 200));
        if (got.picked && txt.includes(got.picked)) { got.echoed = true; finish('model echoed the picked label'); }
        if (DENY && got.ask) finish('model replied after deny');
      }
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio', '--include-partial-messages', '--replay-user-messages', '--session-id', SID];
  const env = { ...process.env, SESSION_ID: SID, HUB_PORT: String(PORT), HUB_TOKEN: TOKEN, HUB_OWNER_ID: 'TEST' };
  console.log('[smoke] mode=' + (DENY ? 'deny' : 'allow') + '; spawning headless.mjs (sid ' + SID.slice(0, 8) + ') against mock hub :' + PORT);
  child = spawn(process.execPath, [join(HERE, 'headless.mjs'), CLAUDE, ...args], { stdio: ['ignore', 'inherit', 'inherit'], env, cwd: ROOT });
  child.on('exit', (c, s) => console.log('[smoke] headless exit', c, s));
});

const timer = setTimeout(() => finish('timeout'), 120000);
function finish(why) {
  clearTimeout(timer);
  const q = got.ask?.questions?.[0];
  const askOk = !!q && q.options.length >= 2 && q.options.every(o => o.label);
  console.log('\n===== ASK SMOKE RESULT =====', why);
  console.log('registered       :', got.registered);
  console.log('ask w/ options   :', askOk, q ? '(' + q.options.map(o => o.label).join(' | ') + ')' : '');
  if (!DENY) {
    console.log('picked label     :', JSON.stringify(got.picked));
    console.log('echoed in reply  :', got.echoed, '  <- proves updatedInput.answers reached the engine');
  }
  if (got.otherPerms.length) console.log('other approvals  :', got.otherPerms.join(', '));
  const pass = got.registered && askOk && (DENY ? got.replies.length > 0 : got.echoed);
  console.log('VERDICT          :', pass ? 'PASS' : 'FAIL');
  try { child?.kill(); } catch {}
  try { server.close(); } catch {}
  setTimeout(() => process.exit(pass ? 0 : 1), 300);
}
