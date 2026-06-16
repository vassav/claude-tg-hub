// Launcher: spawn the initial N Claude sessions (each with our channel-shim) via
// the shared spawner. The hub owns the bot; these sessions register + wait.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSession } from './session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
dotenv.config({ path: join(ROOT, '.env') });

// node-pty on Windows can throw an AttachConsole error when a pty child is
// killed externally; don't let it crash the launcher (which holds all sessions).
process.on('uncaughtException', e => console.error('[launch] uncaught:', e?.message || e));
process.on('unhandledRejection', e => console.error('[launch] unhandledRejection:', e?.message || e));

const HUB_PORT = process.env.HUB_PORT || 8799;
const HUB_TOKEN = process.env.HUB_TOKEN || 'dev';
const SHIM = join(HERE, 'shim.mjs');
const TMP = process.env.HUB_TMP_DIR || (process.platform === 'win32'
  ? 'C:\\Users\\vsavinov\\AppData\\Local\\Temp\\hubsessions'
  : join(tmpdir(), 'hubsessions'));

const SESSIONS = [
  { id: 'sess-A', cwd: join(TMP, 'A') },
  { id: 'sess-B', cwd: join(TMP, 'B') },
];

const ptys = [];
for (const s of SESSIONS) {
  const p = spawnSession({ id: s.id, cwd: s.cwd, shimPath: SHIM, tmpDir: TMP, hubPort: HUB_PORT, hubToken: HUB_TOKEN });
  ptys.push(p);
  console.error(`[launch] spawned ${s.id} (cwd ${s.cwd})`);
}

console.error('[launch] sessions up. Make sure the hub is running, then drive from Telegram. Ctrl+C to stop.');
process.stdin.resume();
process.on('SIGINT', () => { for (const p of ptys) { try { p.kill(); } catch {} } process.exit(0); });
