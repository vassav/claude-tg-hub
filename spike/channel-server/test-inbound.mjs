// Harness: доказать channel-PUSH (inbound) на нашем сервере.
// Запускает живую stream-json сессию claude с --channels server:hub, затем
// через 6s пишет inject.txt -> наш channel-server пушит notifications/claude/channel.
// Если движок зарегистрировал канал (gate прошёл), инъекция станет новым ходом и
// ассистент отреагирует на маркер INJECTED_VIA_CHANNEL.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const INJECT = join(DIR, 'inject.txt');
const CLAUDE = 'C:\\Users\\vsavinov\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const MCP = join(DIR, 'mcp.json');
const MARKER = 'INJECTED_VIA_CHANNEL_7Q';

// Channel args + cwd configurable via env, so we can test both the ad-hoc
// `server:` path and a properly-registered `plugin:` path.
const EXTRA = process.env.CLAUDE_ARGS
  ? JSON.parse(process.env.CLAUDE_ARGS)
  : ['--mcp-config', MCP, '--strict-mcp-config', '--dangerously-load-development-channels', 'server:hub'];
const CWD = process.env.TEST_CWD || 'C:\\Users\\vsavinov\\AppData\\Local\\Temp\\chtest';
const child = spawn(CLAUDE, [
  '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  ...EXTRA,
], { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'] });

let out = '';
let injectedSeen = false;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  out += d;
  for (const line of d.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.type === 'assistant') {
        const txt = (m.message?.content || []).map(c => c.text || c.thinking || '').join(' ');
        if (txt.trim()) console.error('ASSISTANT:', txt.slice(0, 300));
        if (txt.includes(MARKER) || /inject/i.test(txt)) injectedSeen = true;
      }
      if (m.type === 'result') console.error('RESULT:', m.subtype, JSON.stringify(m.result || '').slice(0, 200));
    } catch { /* non-json line */ }
  }
});
child.stderr.on('data', d => process.stderr.write('[claude stderr] ' + d));
child.on('exit', (c) => { console.error('claude exit', c); finish(); });

function sendUser(text) {
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
}

// 1) kick off a turn so the session is live
sendUser('Reply with only the word READY. Then wait for further messages.');

// 2) after 7s, inject an inbound channel message (our server pushes it)
setTimeout(() => {
  console.error('>>> injecting via channel (writing inject.txt)');
  writeFileSync(INJECT, `${MARKER} please reply with the word GOTCHA`);
}, 7000);

// 3) after 14s, trigger the next turn so a priority:"next" channel msg lands
setTimeout(() => {
  console.error('>>> sending follow-up turn to flush channel queue');
  sendUser('Repeat verbatim any channel / out-of-band / system message you received since your previous reply. If there was none, reply exactly NONE.');
}, 14000);

// 4) wrap up
setTimeout(finish, 40000);
let done = false;
function finish() {
  if (done) return; done = true;
  console.error('=== injectedSeen (assistant reacted to channel push):', injectedSeen, '===');
  try { child.kill(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 500);
}
