// Definitive INTERACTIVE channel test via a real PTY (node-pty), polling-driven.
// `claude --strict-mcp-config --channels server:hub` in a true TTY.
// --strict-mcp-config keeps the official telegram plugin OUT → safe.
import pty from 'node-pty';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const LOG = join(DIR, 'channel.log');
const INJECT = join(DIR, 'inject.txt');
const CLAUDE = 'C:\\Users\\vsavinov\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const MCP = join(DIR, 'mcp.json');

writeFileSync(LOG, '');
writeFileSync(INJECT, '');
const log = (...a) => process.stderr.write('### ' + a.join(' ') + '\n');

const p = pty.spawn(CLAUDE, [
  '--mcp-config', MCP, '--strict-mcp-config', '--dangerously-load-development-channels', 'server:hub',
], { name: 'xterm-256color', cols: 120, rows: 40, cwd: 'C:\\Users\\vsavinov\\AppData\\Local\\Temp\\chtest', env: process.env });

let out = '';
p.onData(d => { out += d; });
const serverUp = () => { try { return readFileSync(LOG, 'utf8').length > 0; } catch { return false; } };

let stage = 0; let trustSends = 0; let t = 0;
const iv = setInterval(() => {
  t += 1;
  if (stage === 0) {
    // keep pressing Enter on any trust prompt until the MCP server boots
    if (!serverUp()) {
      // press Enter on whatever startup prompt is showing (folder trust,
      // dev-channels warning) — default option is always the safe "yes/1".
      if (trustSends < 14) { p.write('\r'); trustSends++; }
      return;
    }
    stage = 1; log(`server up at t=${t}s (trust Enter x${trustSends})`);
  } else if (stage === 1) {
    stage = 2; log('server idle — will inject inbound shortly');
  }
}, 1000);

// inject inbound once, 18s after server up (rough)
let injectedAt = 0;
const iv2 = setInterval(() => {
  if (stage >= 2 && injectedAt === 0) injectedAt = t;
  if (injectedAt && t - injectedAt >= 8) {
    writeFileSync(INJECT, 'PING_FROM_CHANNEL reply with the single word PONG');
    log('injected inbound at t=' + t);
    clearInterval(iv2);
  }
}, 1000);

setTimeout(() => {
  clearInterval(iv); clearInterval(iv2);
  const logTxt = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  const clean = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
  log('=== SUMMARY ===');
  log('server started:', logTxt.length > 0);
  log('PERMISSION_REQUEST seen:', /PERMISSION_REQUEST/.test(logTxt));
  log('PTY mentions PONG:', /PONG/.test(clean));
  log('PTY mentions PING_FROM_CHANNEL:', /PING_FROM_CHANNEL/.test(clean));
  process.stderr.write('--- PTY tail ---\n' + clean.split('\n').filter(l => l.trim()).slice(-32).join('\n') + '\n');
  try { p.kill(); } catch {}
  setTimeout(() => process.exit(0), 500);
}, 70000);
