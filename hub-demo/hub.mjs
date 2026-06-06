// Hub daemon: owns ONE Telegram bot and routes it to N Claude sessions.
// Sessions connect via their channel-shim over local TCP.
//
// Live sessions:
//   • reply (quote) to a [sN] message → that session   • tap label keyboard → active
//   • /sessions → inline pick active                   • /to <label> <text> → one-off   • plain → active
// History / resume:
//   • /projects → browse past sessions grouped by project (cwd) → ▶ Resume any
//
// Durable registry (survives a hub restart/crash):
//   • Every hub-managed session is keyed by its claude conversation UUID (we force
//     it with --session-id), persisted with cwd/label/pid to registry.json.
//   • On restart: survivors (claude still alive — checked by PID) reconnect and are
//     re-adopted; the rest are surfaced as resumable (⏸) — one tap resumes the
//     full conversation. A resume is NEVER offered/spawned while the original
//     process is still alive (PID liveness), so we never double-write one .jsonl.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, renameSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { spawnSession } from './session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
dotenv.config({ path: join(ROOT, '.env') });

const TOKEN = process.env.HUB_BOT_TOKEN;
const OWNER = String(process.env.HUB_OWNER_ID || '');
const PORT = Number(process.env.HUB_PORT || 8799);
const IPC_TOKEN = process.env.HUB_TOKEN || 'dev';
const SHIM = join(HERE, 'shim.mjs');
const TMP = 'C:\\Users\\vsavinov\\AppData\\Local\\Temp\\hubsessions';
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const HUB_CFG_DIR = join(homedir(), '.claude', 'channels', 'hub');
const REG_FILE = join(HUB_CFG_DIR, 'registry.json');
const GRACE_MS = 8000;                       // after startup, let survivors reconnect before reporting resumables
const JANITOR_MS = 30000;                     // periodic reconcile/cleanup
const DEAD_TTL_MS = 7 * 24 * 3600 * 1000;     // forget resumable entries older than a week
const STARTING_TTL_MS = 60000;                // discard a 'starting' entry that never registered & wrote nothing
const ACTIVE_WINDOW_MS = 45000;               // a .jsonl touched within this is treated as a live conversation
if (!TOKEN) { console.error('HUB_BOT_TOKEN missing in .env'); process.exit(1); }
if (!OWNER) { console.error('HUB_OWNER_ID missing in .env'); process.exit(1); }

// Discovery: write hub address+token so plugin-launched shims (no env) can find us.
try {
  mkdirSync(HUB_CFG_DIR, { recursive: true });
  writeFileSync(join(HUB_CFG_DIR, 'hub.json'), JSON.stringify({ port: PORT, token: IPC_TOKEN }));
} catch (e) { console.error('[hub] discovery config write failed:', e?.message); }

const bot = new Bot(TOKEN);
const sessions = new Map();    // sessionId -> { conn, cwd, label }  (LIVE only — has a socket)
const order = [];
const pendingPerm = new Map(); // request_id -> sessionId
const outMsgToSession = new Map();
let active = null;
const pendingActivate = new Set(); // ids to make active as soon as they register (new/resume flow)

// history browse state (snapshot for callback buttons)
let lastProjects = [];         // [{ dir, cwd, sessions:[{id,mtime,title?}], latest }]
const idToDir = new Map();     // session id -> projects dir

// ── durable registry (survives hub restart/crash) ────────────────────────────
// id (== conversation UUID for hub-managed sessions) -> entry. Only MANAGED
// sessions are persisted; non-managed (launcher/plugin) live in `sessions` only.
// status: starting → live → detached (maybe alive) → dead (gone, resumable)
const registry = new Map();    // id -> { id, cwd, label, status, managed, resumeUuid, pid, bootId, createdAt, lastSeen }
const BOOT_ID = randomUUID();  // identifies THIS hub run; a pid is trusted as "alive" only if seen this boot

// PID liveness — the load-bearing guard against double-spawning one conversation.
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } // EPERM = exists; ESRCH = gone
}
// Trust a recorded pid only if we observed it live during THIS hub run — a bare pid
// from a previous boot may have been reused by an unrelated process (false "alive").
function isOwnLive(e) { return !!e && e.bootId === BOOT_ID && isAlive(e.pid); }
// Path to claude's conversation file (<id>.jsonl) on disk, or null.
function conversationFile(id) {
  try { for (const d of readdirSync(PROJECTS_DIR)) { const f = join(PROJECTS_DIR, d, id + '.jsonl'); if (existsSync(f)) return f; } } catch {}
  return null;
}
function conversationExists(id) { return !!conversationFile(id); }
// A conversation whose .jsonl was just written is almost certainly live — don't resume it.
function jsonlFresh(id) { const f = conversationFile(id); if (!f) return false; try { return Date.now() - statSync(f).mtimeMs < ACTIVE_WINDOW_MS; } catch { return false; } }
// A live NON-managed session in the same cwd may BE this conversation (we don't know
// its real UUID) — refuse to resume into it to avoid a co-writer on one .jsonl.
function liveCwdConflict(id, cwd) {
  if (!cwd) return false;
  for (const lid of sessions.keys()) { if (lid === id) continue; if (!registry.get(lid)?.managed && sessions.get(lid)?.cwd === cwd) return true; }
  return false;
}
// Decide a non-live managed entry's fate. NEVER mark dead while it looks alive (own
// process alive, or its .jsonl actively written) — that would let a resume double-write
// one conversation. Process gone + history present → dead (resumable); nothing → discard.
function resolveFate(e, id) {
  if (isOwnLive(e) || jsonlFresh(id)) { e.status = 'detached'; e.lastSeen = Date.now(); }
  else if (conversationExists(id)) { e.status = 'dead'; e.lastSeen = Date.now(); }
  else registry.delete(id);
}
function saveRegistry() {
  try {
    mkdirSync(HUB_CFG_DIR, { recursive: true });                // self-heal if the dir vanished
    const tmp = REG_FILE + '.tmp';
    const data = JSON.stringify({ sessions: [...registry.values()] }, null, 2);
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); } // flush to disk before rename
    renameSync(tmp, REG_FILE);                                   // atomic replace of a fully-written file
  } catch (e) { console.error('[hub] registry save failed:', e?.message); }
}
// Returns true if the registry is in a known-good state (loaded or genuinely absent),
// false if the file was present-but-unreadable (then we MUST NOT overwrite it blindly).
function loadRegistry() {
  let raw;
  try { raw = readFileSync(REG_FILE, 'utf8'); }
  catch (e) { if (e?.code === 'ENOENT') return true; console.error('[hub] registry read failed:', e?.message); return false; }
  try { for (const x of (JSON.parse(raw).sessions || [])) if (x?.id) registry.set(x.id, x); return true; }
  catch { try { renameSync(REG_FILE, REG_FILE + '.corrupt-' + Date.now()); } catch {} console.error('[hub] registry corrupt — backed up, starting empty'); return false; }
}
function upsertRegistry(id, patch) { registry.set(id, { ...(registry.get(id) || { id }), ...patch, id }); saveRegistry(); }
// Resumable = managed, confirmed dead (process gone), and we're not already running it.
function resumableEntries() { return [...registry.values()].filter(e => e.managed && e.status === 'dead' && !sessions.has(e.id)); }

const labelOf = id => sessions.get(id)?.label || registry.get(id)?.label || id;
// Informative, unique label derived from the project folder (cwd basename).
// Dedupe only against labels that are actually visible right now (live + resumable),
// so a single session per folder keeps a clean name instead of drifting to -2/-3.
function makeLabel(cwd) {
  let base = (cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || 'session';
  base = base.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 18) || 'session';
  const used = new Set([...sessions.values()].map(s => s.label).concat(resumableEntries().map(e => e.label)));
  let label = base, i = 2;
  while (used.has(label)) label = `${base}-${i++}`;
  return label;
}
const notify = (text, extra) => bot.api.sendMessage(OWNER, text, extra).catch(() => {});
function sendToSession(id, obj) { const s = sessions.get(id); if (s?.conn) { s.conn.write(JSON.stringify(obj) + '\n'); return true; } return false; }

function replyKeyboard() {
  const k = new Keyboard();
  if (order.length) { for (const id of order) k.text(labelOf(id) + (id === active ? ' ✓' : '')); k.row(); }
  k.text('/sessions').text('/projects');
  return k.resized();
}
function sessionInline() {
  const k = new InlineKeyboard();
  for (const id of order) { k.text((id === active ? '● ' : '') + labelOf(id), `switch:${id}`).text('🛑', `stop:${id}`).row(); }
  for (const e of resumableEntries()) k.text(`⏸ ${e.label} — resume`, `resume:${e.id}`).text('🗑', `forget:${e.id}`).row();
  return k;
}
async function routeTo(ctx, id, body) {
  const meta = {
    chat_id: String(ctx.chat.id), message_id: String(ctx.message.message_id),
    user: ctx.from.username || String(ctx.from.id), user_id: String(ctx.from.id), ts: new Date().toISOString(),
  };
  if (!sendToSession(id, { t: 'inbound', content: body, meta })) await ctx.reply('⚠️ session not connected');
}

// Spawn a session in cwd. Identity is the claude conversation UUID: a NEW session
// gets a hub-generated UUID used as BOTH --session-id and our registry/shim key,
// so we can always resume it later. Resuming passes that same UUID via --resume.
// Guards prevent double-spawning one conversation. Returns ok.
function startSession(cwd, { resumeUuid } = {}) {
  const id = resumeUuid || randomUUID();
  const e0 = registry.get(id);
  if (sessions.has(id) || pendingActivate.has(id)) { notify(`already running: ${labelOf(id)}`); return false; }
  if (isOwnLive(e0)) { notify(`${labelOf(id)} is still alive — not resuming (it should reconnect on its own)`); return false; }
  if (resumeUuid) {
    if (!conversationExists(resumeUuid)) { notify(`can't resume ${id.slice(0, 8)} — its history is gone`); registry.delete(id); saveRegistry(); return false; }
    if (jsonlFresh(resumeUuid)) { notify(`can't resume ${id.slice(0, 8)} — that conversation looks active right now`); return false; }
    if (liveCwdConflict(id, cwd)) { notify(`can't resume ${id.slice(0, 8)} — another live session is in ${cwd}`); return false; }
  }
  pendingActivate.add(id);
  let child;
  try {
    child = spawnSession({ id, cwd, resumeId: resumeUuid || null, sessionUuid: resumeUuid ? null : id, shimPath: SHIM, tmpDir: TMP, hubPort: PORT, hubToken: IPC_TOKEN });
  } catch (e) { pendingActivate.delete(id); registry.delete(id); saveRegistry(); notify(`start failed: ${e?.message}`); return false; }
  // Record the REAL claude pid now (from the pty child), independent of the shim
  // registering — so the liveness guard holds during the spawn→register window.
  upsertRegistry(id, { cwd, label: e0?.label || makeLabel(cwd), status: 'starting', managed: true, resumeUuid: id, pid: child?.pid ?? null, bootId: BOOT_ID, createdAt: e0?.createdAt || Date.now(), lastSeen: Date.now() });
  // Watchdog: if it never registers, resolve its fate by liveness (alive → keep; gone → dead/discard).
  setTimeout(() => {
    if (!pendingActivate.has(id) || sessions.has(id)) return;
    pendingActivate.delete(id);
    const e = registry.get(id);
    if (e) { resolveFate(e, id); saveRegistry(); }
    notify(`⚠️ ${labelOf(id)} didn't come up.${registry.get(id)?.status === 'dead' ? ' It stays resumable.' : ''}`);
  }, STARTING_TTL_MS);
  notify(resumeUuid
    ? `▶ resuming ${id.slice(0, 8)}… in ${cwd}\nit'll reconnect and become active.`
    : `➕ new session in ${cwd}\nit'll appear and become active shortly.`);
  return true;
}

// Periodic reconcile: resolve detached→dead/discard via PID, drop phantoms, TTL-prune.
function janitor() {
  let changed = false; const now = Date.now();
  for (const e of [...registry.values()]) {
    if (sessions.has(e.id)) continue;                                   // live — leave alone
    if (!e.managed) { registry.delete(e.id); changed = true; continue; } // never persist non-managed
    if (e.status === 'detached') { resolveFate(e, e.id); changed = true; continue; } // alive→keep; gone→dead/discard
    if (e.status === 'starting' && !pendingActivate.has(e.id) && now - (e.lastSeen || e.createdAt || 0) > STARTING_TTL_MS) {
      resolveFate(e, e.id); changed = true; continue;                    // never came up — resolve by liveness
    }
    if (e.status === 'dead' && now - (e.lastSeen || 0) > DEAD_TTL_MS) { registry.delete(e.id); changed = true; } // TTL
  }
  if (changed) saveRegistry();
}

// ── history ──────────────────────────────────────────────────────────────────
function ago(ms) { const s = Math.floor((Date.now() - ms) / 1000); if (s < 60) return s + 's'; const m = (s / 60) | 0; if (m < 60) return m + 'm'; const h = (m / 60) | 0; if (h < 48) return h + 'h'; return ((h / 24) | 0) + 'd'; }
function shortCwd(cwd) { return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).slice(-2).join('/') || cwd; }
function readMeta(file) {
  let cwd = '', title = '';
  try {
    const head = readFileSync(file, 'utf8').slice(0, 40000);
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!title && o.type === 'summary' && o.summary) title = String(o.summary).replace(/\s+/g, ' ').slice(0, 50);
      if (!title && o.type === 'user' && o.message) {
        const c = o.message.content;
        const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.map(x => typeof x === 'string' ? x : (x?.type === 'text' ? x.text : '')) : [];
        for (const part of parts) { const t = (part || '').trim(); if (t && !t.startsWith('<')) { title = t.replace(/\s+/g, ' ').slice(0, 50); break; } }
      }
      if (cwd && title) break;
    }
  } catch {}
  return { cwd, title };
}
function listProjects() {
  let dirs = [];
  try { dirs = readdirSync(PROJECTS_DIR); } catch { return []; }
  const byDir = [];
  idToDir.clear();
  for (const d of dirs) {
    const dir = join(PROJECTS_DIR, d);
    let files = [];
    try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    const ss = [];
    for (const f of files) {
      const full = join(dir, f);
      let st; try { st = statSync(full); } catch { continue; }
      if (st.size < 80) continue; // skip empty/near-empty
      const id = f.replace(/\.jsonl$/, '');
      ss.push({ id, mtime: st.mtimeMs });
      idToDir.set(id, d);
    }
    if (!ss.length) continue;
    ss.sort((a, b) => b.mtime - a.mtime);
    byDir.push({ dir: d, sessions: ss, latest: ss[0].mtime });
  }
  byDir.sort((a, b) => b.latest - a.latest);
  return byDir;
}

// ── startup recovery ─────────────────────────────────────────────────────────
// Load the durable registry. If it was present-but-unreadable, DON'T clobber it
// (loadRegistry already backed it up). Otherwise mark survivors detached and let
// the janitor resolve them by PID liveness (alive → wait for reconnect; gone → dead).
if (loadRegistry()) {
  for (const e of registry.values()) if (e.status === 'live' || e.status === 'starting') e.status = 'detached';
  saveRegistry();
} else {
  notify('⚠️ registry.json was unreadable — backed up, started empty. Use /projects to resume past sessions.');
}
setInterval(janitor, JANITOR_MS);
setTimeout(() => {
  janitor();
  const r = resumableEntries();
  if (!r.length) return;
  const kb = new InlineKeyboard();
  for (const e of r) kb.text(`▶ ${e.label}`, `resume:${e.id}`).text('🗑', `forget:${e.id}`).row();
  notify(`♻️ ${r.length} session(s) from before the restart can be resumed (full history):`, { reply_markup: kb });
}, GRACE_MS);

// ── IPC: shims connect here ──────────────────────────────────────────────────
net.createServer(sock => {
  let buf = '', sid = null;
  sock.setEncoding('utf8');
  sock.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.t === 'register') {
        if (m.token !== IPC_TOKEN) { sock.end(); return; }
        sid = m.sessionId;
        const known = registry.get(sid);
        const managed = known?.managed ?? pendingActivate.has(sid); // hub-started ones are pending/known
        const readopt = known?.status === 'detached' || known?.status === 'dead';
        const label = known?.label || makeLabel(m.cwd);
        // Replace a superseded live connection deterministically (avoid orphan/leak).
        const prev = sessions.get(sid);
        if (prev?.conn && prev.conn !== sock) { try { prev.conn.destroy(); } catch {} }
        sessions.set(sid, { conn: sock, cwd: m.cwd, label });
        if (!order.includes(sid)) order.push(sid);
        if (managed) {
          upsertRegistry(sid, {
            cwd: m.cwd, label, status: 'live', lastSeen: Date.now(), managed: true,
            resumeUuid: known?.resumeUuid ?? sid, createdAt: known?.createdAt ?? Date.now(),
            pid: m.ppid || known?.pid || null, bootId: BOOT_ID,
          });
        }
        if (pendingActivate.has(sid)) { active = sid; pendingActivate.delete(sid); }
        else if (!active) active = sid;
        console.error(`[hub] ${readopt ? 're-adopted' : 'registered'}: ${label} = ${sid} (cwd ${m.cwd})`);
        notify(`${readopt ? '♻️ re-adopted' : '✅ registered'} ${label}\ncwd: ${m.cwd}\nactive: ${labelOf(active)}`, { reply_markup: replyKeyboard() });
      } else if (m.t === 'reply') {
        bot.api.sendMessage(m.chat_id || OWNER, `[${labelOf(m.sessionId)}] ${m.text}`)
          .then(sent => { if (sent?.message_id) outMsgToSession.set(sent.message_id, m.sessionId); })
          .catch(e => console.error('reply send', e?.message));
      } else if (m.t === 'permission_request') {
        pendingPerm.set(m.request_id, m.sessionId);
        const kb = new InlineKeyboard().text('✅ Allow', `perm:${m.request_id}:allow`).text('❌ Deny', `perm:${m.request_id}:deny`);
        bot.api.sendMessage(OWNER, `🔐 [${labelOf(m.sessionId)}] ${m.tool_name}\n${m.description || ''}\n${(m.input_preview || '').slice(0, 200)}`, { reply_markup: kb })
          .then(sent => { if (sent?.message_id) outMsgToSession.set(sent.message_id, m.sessionId); })
          .catch(e => console.error('perm send', e?.message));
      }
    }
  });
  sock.on('close', () => {
    if (!sid) return;
    if (sessions.get(sid)?.conn !== sock) return; // superseded by a newer registration — ignore this orphan
    const label = labelOf(sid);
    sessions.delete(sid);
    const i = order.indexOf(sid); if (i >= 0) order.splice(i, 1);
    if (active === sid) active = order[order.length - 1] || null;
    // Decide the durable fate by whether the claude process is actually gone.
    const e = registry.get(sid);
    let resumable = false;
    if (e?.managed) { resolveFate(e, sid); resumable = e.status === 'dead'; saveRegistry(); }
    notify(`⚠️ ${label} disconnected${resumable ? ' — resume via /sessions' : ''}`, { reply_markup: replyKeyboard() });
  });
  sock.on('error', () => {});
}).listen(PORT, '127.0.0.1', () => console.error(`[hub] IPC on 127.0.0.1:${PORT}`));

// ── Telegram ─────────────────────────────────────────────────────────────────
const owns = ctx => String(ctx.from?.id) === OWNER;

bot.command('start', async ctx => { if (!owns(ctx)) return; await ctx.reply('Hub ready. /sessions = live · /projects = history+resume', { reply_markup: replyKeyboard() }); });

bot.command('sessions', async ctx => {
  if (!owns(ctx)) return;
  const resumable = resumableEntries();
  if (!order.length && !resumable.length) { await ctx.reply('no live sessions. /projects to resume an old one.', { reply_markup: replyKeyboard() }); return; }
  const live = order.map(id => `${id === active ? '● ' : '○ '}${labelOf(id)} — ${sessions.get(id).cwd}`);
  const dead = resumable.map(e => `⏸ ${e.label} — ${e.cwd} (resumable)`);
  await ctx.reply([...live, ...dead].join('\n') || 'no live sessions', { reply_markup: sessionInline() });
  await ctx.reply('switch ↓, resume ⏸, or reply to a session\'s message', { reply_markup: replyKeyboard() });
});

bot.command('projects', async ctx => {
  if (!owns(ctx)) return;
  lastProjects = listProjects();
  if (!lastProjects.length) { await ctx.reply('no past sessions found'); return; }
  const top = lastProjects.slice(0, 10);
  const kb = new InlineKeyboard();
  top.forEach((p, i) => {
    const cwd = readMeta(join(PROJECTS_DIR, p.dir, p.sessions[0].id + '.jsonl')).cwd || p.dir;
    p.cwd = cwd;
    kb.text(`${shortCwd(cwd)} (${p.sessions.length}) · ${ago(p.latest)}`, `proj:${i}`).row();
  });
  await ctx.reply('📁 Projects (recent). Pick one to see its sessions:', { reply_markup: kb });
});

bot.command('use', async ctx => {
  if (!owns(ctx)) return;
  const id = order.find(x => labelOf(x) === (ctx.match || '').trim() || x === (ctx.match || '').trim());
  if (id) { active = id; await ctx.reply(`▶ active: ${labelOf(id)}`, { reply_markup: replyKeyboard() }); } else await ctx.reply('not found');
});

bot.command('stop', async ctx => {
  if (!owns(ctx)) return;
  const arg = (ctx.match || '').trim();
  const id = order.find(x => labelOf(x) === arg || x === arg);
  if (!id) { await ctx.reply('not found — /sessions to list'); return; }
  sendToSession(id, { t: 'stop' });
  registry.delete(id); saveRegistry(); // explicit stop → don't offer as resumable
  await ctx.reply(`🛑 stopping ${labelOf(id)}…`);
});

bot.command('new', async ctx => {
  if (!owns(ctx)) return;
  const cwd = (ctx.match || '').trim();
  if (!cwd) { await ctx.reply('usage: /new <project path>\n(or /projects → ➕ New session here)'); return; }
  if (startSession(cwd)) await ctx.reply(`➕ starting new session in ${cwd}…`);
});

bot.on('callback_query:data', async ctx => {
  if (!owns(ctx)) { await ctx.answerCallbackQuery().catch(() => {}); return; }
  const data = ctx.callbackQuery.data;
  let m;

  if ((m = /^switch:(.+)$/.exec(data))) {
    const id = m[1];
    if (sessions.has(id)) {
      active = id;
      await ctx.answerCallbackQuery({ text: `active: ${labelOf(id)}` }).catch(() => {});
      await ctx.editMessageReplyMarkup({ reply_markup: sessionInline() }).catch(() => {});
      await notify(`▶ active: ${labelOf(id)}`, { reply_markup: replyKeyboard() });
    } else await ctx.answerCallbackQuery({ text: 'session gone' }).catch(() => {});
    return;
  }

  if ((m = /^stop:(.+)$/.exec(data))) {
    const id = m[1];
    if (sessions.has(id)) { sendToSession(id, { t: 'stop' }); registry.delete(id); saveRegistry(); await ctx.answerCallbackQuery({ text: `stopping ${labelOf(id)}` }).catch(() => {}); }
    else await ctx.answerCallbackQuery({ text: 'already gone' }).catch(() => {});
    return;
  }

  if ((m = /^forget:(.+)$/.exec(data))) {
    const id = m[1];
    registry.delete(id); saveRegistry();
    await ctx.answerCallbackQuery({ text: 'forgotten' }).catch(() => {});
    await ctx.editMessageReplyMarkup({ reply_markup: sessionInline() }).catch(() => {});
    return;
  }

  if ((m = /^perm:([a-z]{5}):(allow|deny)$/.exec(data))) {
    const [, rid, behavior] = m;
    const s = pendingPerm.get(rid);
    if (s) { sendToSession(s, { t: 'permission_decision', request_id: rid, behavior }); pendingPerm.delete(rid); }
    await ctx.answerCallbackQuery({ text: behavior === 'allow' ? 'Allowed' : 'Denied' }).catch(() => {});
    await ctx.editMessageText(`${ctx.callbackQuery.message?.text || ''}\n\n${behavior === 'allow' ? '✅ Allowed' : '❌ Denied'}`).catch(() => {});
    return;
  }

  if ((m = /^proj:(\d+)$/.exec(data))) {
    const p = lastProjects[Number(m[1])];
    if (!p) { await ctx.answerCallbackQuery({ text: 'expired, /projects again' }).catch(() => {}); return; }
    await ctx.answerCallbackQuery().catch(() => {});
    const kb = new InlineKeyboard();
    kb.text('➕ New session here', `new:${m[1]}`).row();
    for (const s of p.sessions.slice(0, 8)) {
      const meta = readMeta(join(PROJECTS_DIR, p.dir, s.id + '.jsonl'));
      kb.text(`▶ ${meta.title || s.id.slice(0, 8)} · ${ago(s.mtime)}`, `res:${s.id}`).row();
    }
    await ctx.editMessageText(`📁 ${p.cwd || p.dir}\nStart a new session, or resume one:`, { reply_markup: kb }).catch(() => {});
    return;
  }

  if ((m = /^res:(.+)$/.exec(data))) {
    const id = m[1];
    const dir = idToDir.get(id);
    if (!dir) { await ctx.answerCallbackQuery({ text: 'unknown session' }).catch(() => {}); return; }
    const cwd = readMeta(join(PROJECTS_DIR, dir, id + '.jsonl')).cwd;
    if (!cwd) { await ctx.answerCallbackQuery({ text: 'no cwd' }).catch(() => {}); return; }
    if (sessions.has(id) || pendingActivate.has(id)) { await ctx.answerCallbackQuery({ text: 'already running' }).catch(() => {}); return; }
    await ctx.answerCallbackQuery({ text: 'resuming…' }).catch(() => {});
    startSession(cwd, { resumeUuid: id }); // startSession enforces liveness/history guards
    return;
  }

  if ((m = /^resume:(.+)$/.exec(data))) {
    const id = m[1];
    const e = registry.get(id);
    if (!e?.cwd) { await ctx.answerCallbackQuery({ text: 'unknown session' }).catch(() => {}); return; }
    if (sessions.has(id) || pendingActivate.has(id)) { await ctx.answerCallbackQuery({ text: 'already running' }).catch(() => {}); return; }
    await ctx.answerCallbackQuery({ text: 'resuming…' }).catch(() => {});
    startSession(e.cwd, { resumeUuid: id });
    return;
  }

  if ((m = /^new:(\d+)$/.exec(data))) {
    const p = lastProjects[Number(m[1])];
    if (!p?.cwd) { await ctx.answerCallbackQuery({ text: 'open /projects again' }).catch(() => {}); return; }
    await ctx.answerCallbackQuery({ text: 'starting…' }).catch(() => {});
    startSession(p.cwd);
    return;
  }

  await ctx.answerCallbackQuery().catch(() => {});
});

bot.on('message:text', async ctx => {
  if (!owns(ctx)) return;
  const text = ctx.message.text;

  const rid = ctx.message.reply_to_message?.message_id;
  if (rid && outMsgToSession.has(rid)) { await routeTo(ctx, outMsgToSession.get(rid), text); return; }

  // bare label tap from the keyboard (optional trailing ✓) -> switch active
  const bare = text.replace(/\s*✓\s*$/, '').trim();
  const swId = order.find(x => labelOf(x) === bare);
  if (swId) { active = swId; await ctx.reply(`▶ active: ${labelOf(swId)}`, { reply_markup: replyKeyboard() }); return; }

  // /to <label> <text> -> one-off send to a specific session without switching
  const mm = /^\/to\s+(\S+)\s+([\s\S]+)$/.exec(text);
  if (mm) { const id = order.find(x => labelOf(x) === mm[1]); if (id) { await routeTo(ctx, id, mm[2]); } else { await ctx.reply(`no session "${mm[1]}" — see /sessions`); } return; }

  if (!active) { await ctx.reply('no active session — /projects to resume one, or start the launcher'); return; }
  await routeTo(ctx, active, text);
});

bot.catch(err => console.error('[hub] bot error', err?.error));
// Don't let a node-pty/conpty quirk (e.g. AttachConsole on a dead pty) crash the daemon.
process.on('uncaughtException', e => console.error('[hub] uncaught:', e?.message || e));
process.on('unhandledRejection', e => console.error('[hub] unhandledRejection:', e?.message || e));
bot.start({ onStart: i => console.error(`[hub] polling as @${i.username}; owner=${OWNER}`) });
