// Phase-0 smoke: can a headless client drive `claude` over stream-json without
// the VSCode extension? Spawns claude in stream-json mode (pipes, no PTY), does
// the initialize handshake, then issues control-protocol requests that DON'T run
// the model (get_settings, get_context_usage) — so no tokens are spent.
//
// Run:  node tg-hub/panel/smoke-headless.mjs
// Pass:  we see system/init, an init control_response, a commands list, and a
//        context-usage payload — proving our client can do the handshake +
//        control-protocol that /context, /rc, /limits, /interrupt rely on.
import { spawn } from 'node:child_process';

const CLAUDE = process.env.CLAUDE_BIN || (process.platform === 'win32'
  ? 'C:\\Users\\vsavinov\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  : 'claude');

const args = [
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-prompt-tool', 'stdio',
  '--include-partial-messages',
  '--replay-user-messages',
];

console.error('[smoke] spawning:', CLAUDE, args.join(' '));
const child = spawn(CLAUDE, args, { stdio: ['pipe', 'pipe', 'inherit'], cwd: process.cwd() });

const got = { init: false, settings: null, context: null, sysInit: false };
function send(obj) { try { child.stdin.write(JSON.stringify(obj) + '\n'); console.error('[smoke] ->', obj.request?.subtype || obj.type); } catch (e) { console.error('[smoke] write err', e?.message); } }

// Send the handshake immediately. Empty hooks => engine won't fire hook_callback.
send({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize', hooks: {} } });

let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const tag = o.type + (o.subtype ? '/' + o.subtype : '') + (o.request?.subtype ? '#' + o.request.subtype : '');
    if (o.type !== 'stream_event') console.error('[smoke] <-', tag);

    if (o.type === 'system' && o.subtype === 'init') got.sysInit = true; // only fires once a turn starts
    if (o.type === 'control_response') {
      const rid = o.response?.request_id;
      if (rid === 'init-1') {
        got.init = true;
        // initialize ack'd — fire the token-free control requests now (NOT gated on
        // system/init, which only appears on the first turn)
        send({ type: 'control_request', request_id: 'gs-1', request: { subtype: 'get_settings' } });
        send({ type: 'control_request', request_id: 'ctx-1', request: { subtype: 'get_context_usage' } });
      }
      if (rid === 'gs-1') got.settings = o.response?.response?.commands?.length ?? 'present';
      if (rid === 'ctx-1') got.context = { percentage: o.response?.response?.percentage, total: o.response?.response?.totalTokens, max: o.response?.response?.maxTokens };
    }
    if (got.init && got.settings != null && got.context != null) finish('all control responses received');
  }
});

child.on('exit', (c, s) => { console.error('[smoke] child exit', c, s); report(); process.exit(0); });
child.on('error', e => { console.error('[smoke] spawn error', e?.message); process.exit(1); });

const timer = setTimeout(() => finish('timeout'), 35000);
function finish(why) { console.error('[smoke] finishing:', why); clearTimeout(timer); try { child.kill(); } catch {} setTimeout(() => { report(); process.exit(0); }, 300); }
function report() {
  console.error('\n===== SMOKE RESULT =====');
  console.error('system/init seen   :', got.sysInit);
  console.error('initialize ack     :', got.init);
  console.error('get_settings       :', got.settings, '(commands count or "present")');
  console.error('get_context_usage  :', got.context);
  const ok = got.init && (got.settings != null || got.context != null);
  console.error('VERDICT            :', ok ? 'PASS — headless client can drive stream-json + control-protocol' : 'PARTIAL/FAIL — see above');
}
