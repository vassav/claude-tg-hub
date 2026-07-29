// Smoke: /browser command + @browser expansion + host-map co-ownership.
// mock hub (TCP) + REAL interposer.mjs + mock engine. Run: node tg-hub/panel/smoke-browser.mjs
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8794, MOCKENG_OUT = join(tmpdir(), 'smoke-browser-maps-' + process.pid + '.jsonl');
rmSync(MOCKENG_OUT, { force: true });
const maps = () => { try { return readFileSync(MOCKENG_OUT, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const replies = []; let sock = null, child = null;
const failures = [];
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : '')); if (!cond) failures.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); } console.log('TIMEOUT waiting: ' + what); return false; }
const toHubSession = m => sock.write(JSON.stringify(m) + '\n');
const toPanelSide = o => child.stdin.write(JSON.stringify(o) + '\n');   // "extension -> engine" direction

const server = net.createServer(s => {
  sock = s; s.setEncoding('utf8'); s.on('error', () => {}); let buf = '';
  s.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.t === 'reply') { replies.push(String(m.text || '')); console.log('[mockhub] REPLY:', JSON.stringify(String(m.text || '')).slice(0, 140)); }
    if (m.t === 'register') console.log('[mockhub] register', m.sessionId, m.kind);
  } });
});

server.listen(PORT, '127.0.0.1', async () => {
  const env = { ...process.env, HUB_PORT: String(PORT), HUB_TOKEN: 'smoke', PANEL_BRIDGE: '1', MOCKENG_OUT };
  child = spawn(process.execPath, [join(HERE, 'interposer.mjs'), process.execPath, join(HERE, 'mock-engine-browser.mjs')],
    { stdio: ['pipe', 'pipe', 'inherit'], env });
  child.stdout.on('data', () => {});   // panel side of the pipe — drained, unused

  // 1: bind the TG chat, plain echo round-trip
  await until(() => sock, 'register');
  toHubSession({ t: 'inbound', content: 'привет', meta: { chat_id: 'TEST' } });
  check('echo round-trip', await until(() => replies.some(r => r === 'ECHO:привет'), 'echo'));

  // 2: @browser in TG text -> registration first, then inject with instruction block
  toHubSession({ t: 'inbound', content: '@browser открой vc.ru', meta: { chat_id: 'TEST' } });
  check('enable confirmed', await until(() => replies.some(r => r.includes('браузер подключён')), 'подключён'));
  check('map has chrome', await until(() => maps().length === 1 && !!maps()[0]['claude-in-chrome'], 'map#1'),
    JSON.stringify(maps()[0] || null));
  const bridgeArgs = maps()[0]?.['claude-in-chrome']?.args || [];
  check('bridge flag', bridgeArgs.includes('--claude-in-chrome-mcp') && /mock-engine-browser\.mjs$/.test(bridgeArgs[0] || ''), JSON.stringify(bridgeArgs));
  check('inject has hint+text', await until(() => replies.some(r => r.startsWith('ECHO:') && r.includes('browser_instruction') && r.includes('открой vc.ru') && !r.includes('@browser')), 'hinted echo'));

  // 3: repeat command -> "уже подключён", no extra mcp_set_servers
  toHubSession({ t: 'command', name: 'browser', chat_id: 'TEST' });
  check('already-on reply', await until(() => replies.some(r => r.includes('уже подключён')), 'уже'));
  check('no extra map', maps().length === 1, 'maps=' + maps().length);

  // 4: host update WITHOUT chrome -> augmented (our registration survives)
  toPanelSide({ type: 'control_request', request_id: 'host-1', request: { subtype: 'mcp_set_servers', servers: { mock: { type: 'stdio', command: 'x', args: [] } } } });
  check('augment', await until(() => maps().length === 2, 'map#2') && !!maps()[1]['claude-in-chrome'] && !!maps()[1].mock, JSON.stringify(maps()[1] || null));

  // 5: host enables chrome itself -> passthrough
  toPanelSide({ type: 'control_request', request_id: 'host-2', request: { subtype: 'mcp_set_servers', servers: { 'claude-in-chrome': { type: 'stdio', command: 'host', args: ['--claude-in-chrome-mcp'] } } } });
  check('host-enable passthrough', await until(() => maps().length === 3, 'map#3') && maps()[2]['claude-in-chrome']?.command === 'host');

  // 6: host explicit disable (had chrome -> dropped) -> respected, NOT augmented
  toPanelSide({ type: 'control_request', request_id: 'host-3', request: { subtype: 'mcp_set_servers', servers: {} } });
  check('disable respected', await until(() => maps().length === 4, 'map#4') && !maps()[3]['claude-in-chrome'], JSON.stringify(maps()[3] || null));

  // 7: /browser re-enables after the disable
  toHubSession({ t: 'command', name: 'browser', chat_id: 'TEST' });
  check('re-enable', await until(() => maps().length === 5, 'map#5') && !!maps()[4]['claude-in-chrome']);

  console.log('\n===== BROWSER SMOKE ===== ' + (failures.length ? 'FAIL: ' + failures.join(', ') : 'PASS'));
  try { child.kill(); } catch {}
  server.close();
  setTimeout(() => process.exit(failures.length ? 1 : 0), 300);
});
setTimeout(() => { console.log('GLOBAL TIMEOUT'); try { child?.kill(); } catch {}; process.exit(1); }, 60000);
