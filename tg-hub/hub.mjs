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
import { dirname, join, basename, isAbsolute, resolve, delimiter } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, renameSync, existsSync, openSync, readSync, writeSync, fsyncSync, closeSync, copyFileSync } from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { Bot, InlineKeyboard, Keyboard, InputFile } from 'grammy';
import { spawnSession } from './session.mjs';
import { askOf } from './panel/ask.mjs';
import * as access from './access.mjs';
import { replyExtra, askChatFor, nextInbound, isGroup, placeOf, splitPlace, isTopicPlace, topicLink, isTopicGoneError } from './chat-target.mjs';
import { sendRich, RICH_LIMIT, chooseFileMethod, CAPTION_LIMIT } from './rich.mjs';
import { createActive, createPending, buttonLabel, groupSessions, stripActiveMark, sessionState, stateMark, fmtDur, fmtTokens } from './routing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
// Config: `node hub.mjs --config <file>` reads a .env-style file instead of the repo's .env,
// so several hubs (one bot each) can run side by side. An explicit file wins over the
// inherited environment: a hub started from inside a hub-managed session would otherwise
// pick up that hub's HUB_BOT_TOKEN/HUB_PORT.
function configArg(argv) {
  const i = argv.findIndex(a => a === '--config' || a.startsWith('--config='));
  if (i < 0) return null;
  const v = argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[i + 1];
  if (!v) { console.error('[hub] --config needs a file path'); process.exit(1); }
  return resolve(v);
}
const CONFIG = configArg(process.argv.slice(2));
if (CONFIG && !existsSync(CONFIG)) { console.error(`[hub] config not found: ${CONFIG}`); process.exit(1); }
dotenv.config({ path: CONFIG || join(ROOT, '.env'), override: !!CONFIG });

const TOKEN = process.env.HUB_BOT_TOKEN;
const OWNER = String(process.env.HUB_OWNER_ID || '');
// The bot's "home" chat: where ALL bot-originated output goes (session-reply
// fallback, approvals, notifications) and which is accepted as input. Defaults to
// the owner's DM; set HUB_CHAT_ID to a group's id (e.g. -1001234567890) to run the
// whole bot in that group — output lands there and any group member may drive it.
const CHAT = String(process.env.HUB_CHAT_ID || OWNER);
const PORT = Number(process.env.HUB_PORT || 8799);
const IPC_TOKEN = process.env.HUB_TOKEN || 'dev';
// Bot API endpoint. Default is Telegram's cloud API (getFile downloads capped at 20 MB).
// Point at a self-hosted local Bot API server to lift that to 2 GB and get files on disk.
const API_ROOT = (process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org').replace(/\/+$/, '');
const SHIM = join(HERE, 'shim.mjs');
const TMP = process.env.HUB_TMP_DIR || (process.platform === 'win32'
  ? 'C:\\Users\\vsavinov\\AppData\\Local\\Temp\\hubsessions'
  : join(tmpdir(), 'hubsessions'));
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CONFIG_DIR = dirname(CONFIG || join(ROOT, '.env'));   // relative paths in the config are taken from here
// Per-instance state: registry.json, access.json, hub.json. A second hub needs its own
// HUB_STATE_DIR.
const HUB_CFG_DIR = process.env.HUB_STATE_DIR
  ? resolve(CONFIG_DIR, process.env.HUB_STATE_DIR)
  : join(homedir(), '.claude', 'channels', 'hub');
if (process.env.HUB_STATE_DIR) process.env.HUB_STATE_DIR = HUB_CFG_DIR;   // children inherit it absolute
// HUB_PROJECTS: the folders this bot may work in, separated by `;` (`:` off Windows).
// Unset = every project. Limits /projects, every way of starting a session and which
// self-joining sessions (plugin, VSCode panel) are let in.
const PROJECT_ROOTS = String(process.env.HUB_PROJECTS || '').split(delimiter)
  .map(s => s.trim()).filter(Boolean).map(p => resolve(CONFIG_DIR, p));
for (const r of PROJECT_ROOTS) if (!existsSync(r)) console.error(`[hub] HUB_PROJECTS: ${r} does not exist`);
const inProjects = cwd => access.inRoots(cwd, PROJECT_ROOTS);
const REG_FILE = join(HUB_CFG_DIR, 'registry.json');
const GRACE_MS = 8000;                       // after startup, let survivors reconnect before reporting resumables
const JANITOR_MS = 30000;                     // periodic reconcile/cleanup
const DEAD_TTL_MS = 7 * 24 * 3600 * 1000;     // forget resumable entries older than a week
const STARTING_TTL_MS = 60000;                // discard a 'starting' entry that never registered & wrote nothing
const ACTIVE_WINDOW_MS = 45000;               // a .jsonl touched within this is treated as a live conversation
const TITLE_TIMEOUT_MS = 20000;               // wait this long for the model's set_title before slugging the 1st request
if (!TOKEN) { console.error('HUB_BOT_TOKEN missing in .env'); process.exit(1); }
if (!OWNER) { console.error('HUB_OWNER_ID missing in .env'); process.exit(1); }

// One hub per state dir: two would overwrite each other's registry.json and hub.json.
// The hub.json there counts as taken when its port answers and its pid (absent in files
// written before pids were recorded) is alive — after a reboot the pid may belong to
// someone else, but then nothing listens on the port. Checked before anything is read
// or written, as is our own port, so a misconfigured second hub leaves no trace.
function portAnswers(port) {
  return new Promise(res => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.setTimeout(1000, () => { s.destroy(); res(false); });
  });
}
{
  let prev = null;
  try { prev = JSON.parse(readFileSync(join(HUB_CFG_DIR, 'hub.json'), 'utf8')); } catch {}
  if (prev?.port && (!prev.pid || isAlive(prev.pid)) && await portAnswers(prev.port)) {
    console.error(`[hub] ${HUB_CFG_DIR} is in use by another hub (pid ${prev.pid ?? '?'}, port ${prev.port}) — give this one its own HUB_STATE_DIR`);
    process.exit(1);
  }
  if (await portAnswers(PORT)) { console.error(`[hub] port ${PORT} is busy — set another HUB_PORT`); process.exit(1); }
}
access.init(HUB_CFG_DIR);

// Discovery: write hub address+token so plugin-launched shims (no env) can find us.
try {
  mkdirSync(HUB_CFG_DIR, { recursive: true });
  writeFileSync(join(HUB_CFG_DIR, 'hub.json'), JSON.stringify({ port: PORT, token: IPC_TOKEN, pid: process.pid }));
} catch (e) { console.error('[hub] discovery config write failed:', e?.message); }

const bot = new Bot(TOKEN, { client: { apiRoot: API_ROOT } });
const sessions = new Map();    // sessionId -> { conn, cwd, label }  (LIVE only — has a socket)
const order = [];
const pendingPerm = new Map(); // request_id -> sessionId
const permMsg = new Map();      // request_id -> { mid, chat } of the approval/ask card, for clearing buttons
const askState = new Map();     // request_id -> { sessionId, qs, picks:number[][], cur }  (AskUserQuestion cards)
const outMsgToSession = new Map();
const lastInbound = new Map();  // sessionId -> { chat_id, message_id, user, user_id, pending, ambiguous } of the message that most recently drove it
// Which sessions are mid-turn, for the ⚡ mark in /sessions. This replaced the live
// "Thinking…" draft bubble: a draft repainted every 10s in the DM was noise, while the
// same knowledge is worth having on demand, in the list, for every chat including groups.
const working = new Map();    // sessionId -> { since, tokens } of the running turn
const active = createActive();                 // chatId -> sessionId; no global pointer
const pending = createPending();   // chatId -> text written before the chat had an active session
// Where this update lives: the chat, or the forum topic inside it (see chat-target.mjs).
const here = ctx => placeOf(ctx.chat, ctx.msg);
const activeIn = ctx => active.get(here(ctx));
const pendingActivate = new Map(); // sessionId -> chatId that asked for it (new/resume flow)
const pendingFirstMsg = new Map(); // id -> { content, meta } to inject once the session registers (external {t:'start',content})
const awaitingTitle = new Set();   // ids whose meaningful name we're awaiting (model set_title, else slug fallback)
const newProjPrompt = new Map();   // message_id of a "name the new project" prompt -> chat id; a reply to it is the name
const newProjArg = new Map();      // chat id -> project name waiting for its root to be picked (several HUB_PROJECTS)

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
// Co-writer guard: refuse to resume conversation `id` only if a live session in the
// same cwd whose REAL conversation UUID we DON'T know might actually be `id` (would
// double-write one .jsonl). We skip live sessions we can identify: managed ones (we
// forced their UUID) and any whose id maps to a real <id>.jsonl (panels/headless
// register with their real conversation UUID) — those write a DISTINCT file (lid≠id).
// Only an unidentifiable id (e.g. a plugin channels shim's synthetic basename-pid id,
// with no <id>.jsonl) is ambiguous → block.
function liveCwdConflict(id, cwd) {
  if (!cwd) return false;
  for (const lid of sessions.keys()) {
    if (lid === id) continue;
    if (registry.get(lid)?.managed) continue;   // forced UUID → writes its own .jsonl
    if (conversationExists(lid)) continue;       // id is a real conversation UUID → distinct .jsonl
    if (sessions.get(lid)?.cwd === cwd) return true; // unidentifiable id in this cwd → can't rule out a co-writer
  }
  return false;
}
// Decide a non-live managed entry's fate. NEVER mark dead while it looks alive (own
// process alive, or its .jsonl actively written) — that would let a resume double-write
// one conversation. Process gone + history present → dead (resumable); nothing → discard.
// A session WE stopped (stoppedAt) is over once its process is: a fresh .jsonl then only
// means it was busy a moment ago, not that someone else is writing it.
const stoppedAndGone = e => !!e?.stoppedAt && !isOwnLive(e);
function resolveFate(e, id) {
  if (isOwnLive(e) || (jsonlFresh(id) && !stoppedAndGone(e))) { e.status = 'detached'; e.lastSeen = Date.now(); }
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
const btnOf = id => buttonLabel(labelOf(id));   // inline caption: name only — the project goes in the message text

// Labels keep unicode letters/digits (so a Russian request doesn't collapse to
// 'session'); everything else becomes '-'. Trimmed, capped at 40 chars.
// Words stay words: "Проверка заголовка сессии", not "Проверка-заголовка-сессии". Only /to
// splits a label from text, and it matches whole labels (see there), so spaces are safe.
function sanitizeLabel(s) { return (s || '').normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, ' ').trim().replace(/^[-.]+/, '').slice(0, 40).replace(/[\s.-]+$/, ''); }
function folderBase(cwd) { return sanitizeLabel((cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || '') || 'session'; }
// A short slug from free text (first ~7 words) — the auto-name fallback.
function slugLabel(text) { return sanitizeLabel(String(text || '').trim().split(/\s+/).slice(0, 7).join(' ')); }
// Labels visible right now (live + resumable), excluding one id — the dedupe set.
function visibleLabels(exceptId) {
  const s = new Set();
  for (const [k, v] of sessions) if (k !== exceptId) s.add(v.label);
  for (const e of resumableEntries()) if (e.id !== exceptId) s.add(e.label);
  return s;
}
function uniqueLabel(base, exceptId) {
  base = base || 'session';
  const used = visibleLabels(exceptId);
  let label = base, i = 2;
  while (used.has(label)) label = `${base} ${i++}`;
  return label;
}
// Provisional name at creation: deduped project-folder basename.
function makeLabel(cwd, exceptId) { return uniqueLabel(folderBase(cwd), exceptId); }

// Give a managed session a meaningful name. fromModel=true (its claude called
// set_title) overrides an earlier slug fallback; the slug fallback never
// overrides an existing name. Renames in place — silent (shows on next render).
function applyName(id, raw, fromModel) {
  const e = registry.get(id);
  const live = sessions.get(id);
  if (!e && !live) return;                          // unknown session
  if (e?.named && !fromModel) return;               // slug fallback never overrides an existing name
  const label = uniqueLabel(slugLabel(raw) || folderBase(e?.cwd || live?.cwd), id);
  const renamed = e && e.label !== label;
  if (e) { e.label = label; e.named = true; saveRegistry(); }
  if (live) live.label = label;                     // also rename non-managed (panel) live sessions
  awaitingTitle.delete(id);
  if (renamed && e.topic && e.topicOwned) renameTopic(e.topic, label);   // its topic carries its name
}
// On the first request to an unnamed managed session, wait for the model's
// set_title; if it doesn't arrive in time, fall back to slugging that request.
function armAutoName(id, body) {
  const e = registry.get(id);
  if (!e || !e.managed || e.named || awaitingTitle.has(id)) return;
  const text = String(body || '').trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return; // nothing nameable (slash command / emoji only)
  awaitingTitle.add(id);
  setTimeout(() => {
    if (registry.get(id)?.named) { awaitingTitle.delete(id); return; }
    applyName(id, text, false);
  }, TITLE_TIMEOUT_MS);
}
const notify = (text, extra) => { const { chat, thread } = splitPlace(CHAT); return bot.api.sendMessage(chat, text, { ...thread, ...extra }).catch(() => {}); };
function sendToSession(id, obj) {
  const s = sessions.get(id); if (!s?.conn) return false;
  s.conn.write(JSON.stringify(obj) + '\n');
  // Every path that feeds a session goes through here — a Telegram message, a held line
  // delivered on switch, a queued first message, an external inject, an approval verdict
  // that unblocks a waiting turn. One hook instead of eight call sites, and a ninth one
  // added later can't forget it.
  if (obj.t === 'inbound' || obj.t === 'permission_decision') markWorking(id);
  return true;
}
const markWorking = id => { if (!working.has(id)) working.set(id, { since: Date.now(), tokens: 0 }); };
const clearWorking = id => working.delete(id);
// A tool approval belongs to exactly one session; a session can have several open.
const awaitsPerm = id => { for (const s of pendingPerm.values()) if (s === id) return true; return false; };
const stateOf = id => sessionState({ since: working.get(id)?.since, awaitingPerm: awaitsPerm(id) });
// "⚡ 1 м 20 с · 3.4k" / "🔐 ждёт аппрув" — the tail of a session's line in /sessions.
// Tokens only when the session reports usage: channels sessions never do.
function stateSuffix(id) {
  const st = stateOf(id);
  if (st === 'perm') return ' 🔐 ждёт аппрув';
  if (st !== 'work') return '';
  const w = working.get(id);
  return ` ⚡ ${fmtDur(Date.now() - w.since)}${w.tokens ? ` · ${fmtTokens(w.tokens)}` : ''}`;
}

// ── Telegram rendering ───────────────────────────────────────────────────────
// Sessions (panel & CLI) emit Markdown: **bold**, `code`, ```fences```, [t](url),
// # headers, - bullets, > quotes. Render it as Telegram HTML — far more forgiving than
// MarkdownV2 (only < > & need escaping). sendTg falls back to plain text if
// Telegram still rejects the entities, so a message is never lost; long messages
// are split under Telegram's 4096-char limit.
function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function mdToTgHtml(src) {
  // Split code spans/blocks out so we never format inside them; odd segments are
  // the captured code delimiters, even segments are normal text.
  const parts = String(src ?? '').split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts.map((seg, i) => {
    if (i % 2 === 1) {
      const fence = seg.match(/^```[^\n]*\n?([\s\S]*?)```$/);
      if (fence) return `<pre>${escapeHtml(fence[1].replace(/\n$/, ''))}</pre>`;
      const inline = seg.match(/^`([^`\n]+)`$/);
      if (inline) return `<code>${escapeHtml(inline[1])}</code>`;
      return escapeHtml(seg);
    }
    let t = escapeHtml(seg);
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) =>                                  // links:
      /^(https?:\/\/|tg:\/\/|mailto:)/i.test(url) ? `<a href="${url}">${txt}</a>` : `<code>${txt}</code>`); // real URLs stay clickable; file paths → monospace (TG rejects non-FQDN href)
    t = t.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>').replace(/__([^\n]+?)__/g, '<b>$1</b>');     // bold
    t = t.replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>');                                              // headers
    t = t.replace(/^(\s*)[-*]\s+/gm, '$1• ');                                                     // bullets
    // blockquotes: consecutive "> " lines (already escaped to &gt;) -> one <blockquote>
    if (/^&gt;/m.test(t)) {
      const lines = t.split('\n'); const out = []; let q = null;
      for (const ln of lines) {
        const m = ln.match(/^&gt;\s?(.*)$/);
        if (m) { (q ??= []).push(m[1]); continue; }
        if (q) { out.push(`<blockquote>${q.join('\n')}</blockquote>`); q = null; }
        out.push(ln);
      }
      if (q) out.push(`<blockquote>${q.join('\n')}</blockquote>`);
      t = out.join('\n');
    }
    return t;
  }).join('');
}
function chunkText(s, n = 4000) {
  if (s.length <= n) return [s];
  const out = []; let cur = '';
  for (const line of s.split('\n')) {
    if (line.length > n) { if (cur) { out.push(cur); cur = ''; } for (let i = 0; i < line.length; i += n) out.push(line.slice(i, i + n)); continue; }
    if (cur && cur.length + line.length + 1 > n) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}
async function sendTg(chatId, text, sid, extra = {}, firstExtra = {}) {
  const { chat, thread } = splitPlace(chatId);
  const parts = chunkText(String(text ?? ''));
  let last = null;
  for (let i = 0; i < parts.length; i++) {
    // keyboard only on the last chunk; reply-quote only on the first
    const opts = { link_preview_options: { is_disabled: true }, ...thread, ...(i === 0 ? firstExtra : {}), ...(i === parts.length - 1 ? extra : {}) };
    let sent = null;
    try { sent = await bot.api.sendMessage(chat, mdToTgHtml(parts[i]), { parse_mode: 'HTML', ...opts }); }
    catch { try { sent = await bot.api.sendMessage(chat, parts[i], opts); } catch (e) {   // plain fallback
      // the topic was deleted: unbind it and say the whole thing in General instead
      if (thread.message_thread_id && isTopicGoneError(e?.description || e?.message)) { topicGone(chatId); return sendTg(chat, text, sid, extra, firstExtra); }
      console.error('sendTg', e?.message);
    } }
    if (sent?.message_id && sid) outMsgToSession.set(sent.message_id, sid);
    if (sent) last = sent;
  }
  return last;
}
// Send an approval/question card to `chat` and remember where it landed (permMsg, for
// clearing its buttons). sendTg swallows failures and returns null: if a group is gone,
// migrated to a new id, or the bot is restricted there, the card would render nowhere
// while the request stays pending — a card nobody can see hangs the session. Then
// re-send to the home chat; `onMoved(CHAT)` lets the caller repoint its own state.
function sendCard(rid, sid, chat, text, kb, onMoved) {
  sendTg(chat, text, sid, { reply_markup: kb }).then(sent => {
    if (sent?.message_id) { permMsg.set(rid, { mid: sent.message_id, chat }); return; }
    if (chat === CHAT) return;                       // already the home chat — nothing left to fall back to
    onMoved?.(CHAT);
    sendTg(CHAT, text, sid, { reply_markup: kb }).then(sent2 => {
      if (sent2?.message_id) permMsg.set(rid, { mid: sent2.message_id, chat: CHAT });
    });
  });
}
// Session answers go out as Rich Messages: the model's Markdown is handed to Telegram
// untouched, which renders real tables, headings and syntax-highlighted code. Falls back to
// the HTML path on ANY failure — an old self-hosted Bot API server (TELEGRAM_API_ROOT), a
// rejected payload (500 blocks / 20 columns / 16 nesting levels), or a network blip.
// Text over RICH_LIMIT goes the old way too, where chunkText splits it.
async function sendMd(chatId, text, sid, extra = {}, firstExtra = {}) {
  const body = String(text ?? '');
  if (body.length <= RICH_LIMIT) {
    const { chat, thread } = splitPlace(chatId);
    const sent = await sendRich({ apiRoot: API_ROOT, token: TOKEN, chatId: chat, markdown: body, extra: { ...thread, ...firstExtra, ...extra } });
    if (sent?.message_id) {
      if (sid) outMsgToSession.set(sent.message_id, sid);   // keep "reply to a bot message → its session" working
      return sent;
    }
  }
  return sendTg(chatId, body, sid, extra, firstExtra);
}
// Edit a card in place — same render path as sendTg (HTML + plain fallback), but NO
// chunking: callers must keep the card under the limit (askCard truncates for this).
// Default empty inline_keyboard so a final card reliably loses its buttons.
async function editTg(chatId, messageId, text, extra = {}) {
  const t = String(text ?? '');
  const opts = { link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] }, ...extra };
  const chat = splitPlace(chatId).chat;   // an edit addresses a message — its topic comes with it
  try { return await bot.api.editMessageText(chat, messageId, mdToTgHtml(t), { parse_mode: 'HTML', ...opts }); }
  catch { try { return await bot.api.editMessageText(chat, messageId, t, opts); } catch (e) { console.error('editTg', e?.message); } }
  return null;
}

function replyKeyboard(chatId) {
  const k = new Keyboard();
  const cur = active.get(chatId);
  // Bottom keyboard shows the bare label. It is the one Telegram sends back as ordinary
  // text, so its caption is also the lookup key — keeping it a plain label keeps that pair
  // trivial. The project lives on the inline /sessions list instead.
  // A session's own forum topic gets no session list: a tap would make ANOTHER session
  // active in this one's topic. (In a forum the keyboard is per topic, see topicHello.)
  const ownTopic = [...registry.values()].some(e => e.topic && e.topic === String(chatId));
  if (order.length && !ownTopic) { for (const id of order) k.text(labelOf(id) + (id === cur ? ' ✓' : '')); k.row(); }
  k.text('/sessions').text('/projects').text('⚙ пульт');
  return k.resized();
}
// stream-json sessions (VSCode panel, or hub-launched headless) are control-capable:
// they accept /context, /rc, /limits, /compact, /interrupt. Channels CLI sessions are not.
const isStream = id => sessions.get(id)?.kind === 'stream';
// Inline command pad for ONE stream session, opened via the ⚙ пульт keyboard button.
function controlPad(id) {
  return new InlineKeyboard()
    .text('🧮 контекст', `cmd:${id}:context`).text('🌐 remote', `cmd:${id}:rc`).text('🧭 браузер', `cmd:${id}:browser`).row()
    .text('⏳ лимит', `cmd:${id}:limits`).text('🗜 compact', `cmd:${id}:compact`).text('⏹ прервать', `cmd:${id}:interrupt`).row();
}
// ── AskUserQuestion cards ────────────────────────────────────────────────────
// The engine offers AskUserQuestion as a normal approval, but a one-tap Allow/Deny
// would answer NOTHING (the tool reads the pick from updatedInput.answers). Stream
// sessions send us the parsed `ask`, so we render the real options as buttons; the
// pick travels back as INDICES and the client rebuilds answers off the original input.
const btnLabel = s => (s.length > 40 ? s.slice(0, 39) + '…' : s);
// ONE question per card. Text is Markdown source (mdToTgHtml escapes it downstream) and
// is truncated hard so sendTg never chunks it — a chunked card would strand the keyboard
// on a second message that editTg can't keep in sync with the first.
function askCard(rid) {
  const st = askState.get(rid); if (!st) return null;
  const q = st.qs.questions[st.cur], sel = st.picks[st.cur], n = st.qs.questions.length;
  const head = `❓ [${labelOf(st.sessionId)}] ${q.header || 'Вопрос'}${n > 1 ? ` · ${st.cur + 1}/${n}` : ''}`;
  const body = q.options.map((o, i) =>
    `${sel.includes(i) ? '☑' : '▫️'} **${o.label}**${o.description ? ` — ${o.description.slice(0, 200)}` : ''}`).join('\n');
  const text = `${head}\n${q.question.slice(0, 700)}\n\n${body}${q.multiSelect ? '\n\n_можно выбрать несколько_' : ''}`;
  const kb = new InlineKeyboard();
  q.options.forEach((o, i) => kb.text(`${q.multiSelect ? (sel.includes(i) ? '☑ ' : '☐ ') : ''}${btnLabel(o.label)}`, `ask:${rid}:${st.cur}:${i}`).row());
  if (q.multiSelect) kb.text(sel.length ? `✔ Готово (${sel.length})` : '✔ Готово', `ask:${rid}:${st.cur}:ok`);
  kb.text('❌ Отмена', `ask:${rid}:x`).row();
  return { text, kb };
}
// The engine ships ready-made permission_suggestions with each approval (Edit ->
// {setMode:'acceptEdits', destination:'session'}, i.e. "stop asking me this session").
// We only NAME them; the chosen one goes back as an index and the client replays the
// engine's own object, so granularity (Bash command prefixes, paths) stays the engine's.
const MODE_RU = { acceptEdits: 'принимать правки', bypassPermissions: 'без запросов', plan: 'режим плана', default: 'обычный режим' };
const DEST_RU = { session: 'до конца сессии', localSettings: 'навсегда (локально)', projectSettings: 'навсегда (проект)', userSettings: 'навсегда (глобально)', cliArg: '' };
function suggestLabel(s) {
  const dest = DEST_RU[s?.destination] ?? s?.destination ?? '';
  const tail = dest ? ` — ${dest}` : '';
  if (s?.type === 'setMode') return `✅ ${MODE_RU[s.mode] || s.mode}${tail}`;
  if (s?.type === 'addRules' || s?.type === 'replaceRules') {
    const r = s.rules?.[0];
    const what = r ? (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName) : 'правило';
    return `${s.behavior === 'deny' ? '⛔ запретить' : '✅ разрешить'} ${what}${tail}`;
  }
  if (s?.type === 'addDirectories') return `📁 + ${(s.directories || []).join(', ')}${tail}`;
  return `${s?.type || 'правило'}${tail}`;
}
function askSummary(st) {
  return `✅ [${labelOf(st.sessionId)}] ответ отправлен\n` + st.qs.questions.map((q, qi) =>
    `• ${q.header || q.question}: **${st.picks[qi].map(i => q.options[i].label).join(', ') || '—'}**`).join('\n');
}
// Channels CLI path: the permission reply schema is hard-wired to {request_id, behavior}
// — no slot for updatedInput, so a structural answer is impossible there. Best we can do
// is parse the JSON-string input_preview and PRINT the choices readably.
function askDigest(tool, preview) {
  let input; try { input = JSON.parse(preview); } catch { return null; }
  const ask = askOf(tool, input); if (!ask) return null;
  return ask.questions.map((q, qi) =>
    `**${qi + 1}. ${q.header || 'Вопрос'}**${q.multiSelect ? ' (мультивыбор)' : ''}\n${q.question}\n` +
    q.options.map((o, i) => `  ${i + 1}) ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')
  ).join('\n\n') + '\n\n⚠️ Сессия на channels — выбрать вариант отсюда нельзя. Allow пропустит вопрос БЕЗ ответа; лучше Deny и напишите ответ обычным сообщением.';
}

function sessionInline(chatId) {
  const k = new InlineKeyboard();
  const cur = active.get(chatId);
  // Inline list carries the session id in callback_data, so its caption is never parsed
  // back — it can afford two lines: project above, session name below.
  // ⚡/🔐 goes BEFORE the name: the caption is clipped to the button's width from the
  // right, so a mark at the tail is the first thing a long name would eat.
  for (const id of order) { const mk = stateMark(stateOf(id)); k.text((id === cur ? '● ' : '') + (mk ? mk + ' ' : '') + btnOf(id), `switch:${id}`).text('🛑', `stop:${id}`).row(); }
  for (const e of resumableEntries()) k.text(`⏸ ${e.label} — resume`, `resume:${e.id}`).text('🗑', `forget:${e.id}`).row();
  // ⚡ and the elapsed time are a snapshot of the moment the list was drawn — without a way
  // to redraw it, a session that finished a minute ago still looks busy.
  if (order.length) k.text('🔄 обновить', 'refresh');
  return k;
}
// The /sessions body: projects with their live sessions, then the resumable ones. Built
// apart from the handler so 🔄 обновить can redraw the very same text in place.
function sessionsText(chatId) {
  const cur = active.get(chatId);
  // The project lives HERE, in the text, grouped — a button clips its caption to the button's
  // width with no ellipsis and collapses newlines, so nothing but the bare name fits there.
  const live = groupSessions(order.map(id => ({ id, label: labelOf(id), cwd: sessions.get(id)?.cwd })))
    .flatMap(g => [`📁 <b>${escapeHtml(g.project)}</b>`,
      ...g.items.map(s => `  ${s.id === cur ? '●' : '○'} ${escapeHtml(s.label)}${stateSuffix(s.id)}`)]);
  const dead = groupSessions(resumableEntries().map(e => ({ id: e.id, label: e.label, cwd: e.cwd })))
    .flatMap(g => [`📁 <b>${escapeHtml(g.project)}</b> (resumable)`,
      ...g.items.map(s => `  ⏸ ${escapeHtml(s.label)}`)]);
  return [...live, ...dead].join('\n') || 'no live sessions';
}
async function routeTo(ctx, id, body) {
  const meta = {
    // no message when a held text is delivered by a button tap — then there's nothing to quote
    chat_id: here(ctx), message_id: ctx.message ? String(ctx.message.message_id) : '',
    user: ctx.from.username || String(ctx.from.id), user_id: String(ctx.from.id), ts: new Date().toISOString(),
  };
  if (!sendToSession(id, { t: 'inbound', content: body, meta })) { await ctx.reply('⚠️ session not connected'); return false; }
  // A session runs one turn at a time, but a SECOND person can write in before the
  // first is answered — nextInbound() tracks that and marks the entry ambiguous so
  // we quote nobody rather than the wrong person (see chat-target.mjs).
  lastInbound.set(id, nextInbound(lastInbound.get(id), meta));
  armAutoName(id, body); // first request → name the session (model set_title, else slug fallback)
  return true;
}

// Which session a message targets: a reply to a tracked bot message → that session
// (the reply may be to an OLD message, not the latest), else the active session.
function targetSession(ctx) {
  const rid = ctx.message?.reply_to_message?.message_id;
  if (rid && outMsgToSession.has(rid)) return outMsgToSession.get(rid);
  return activeIn(ctx);
}
// When a message quotes another, prefix its content as a `> …` block so the session
// sees WHICH message was answered — needed because a reply can target any past message,
// not just the last. Works for replies to the bot, to yourself, or to anyone in a group.
function quotePrefix(ctx) {
  const r = ctx.message?.reply_to_message;
  const q = String(r?.text || r?.caption || '').trim();
  if (!q) return '';
  const capped = q.length > 500 ? q.slice(0, 500) + '…' : q;
  return capped.split('\n').map(l => '> ' + l).join('\n') + '\n\n';
}

// ── incoming files → <cwd>/.tg-inbox/ ────────────────────────────────────────
const humanSize = n => (!n ? '?' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
function inboxName(msg) {
  const uid = f => f?.file_unique_id || 'file';
  if (msg.document?.file_name) return basename(msg.document.file_name);
  if (msg.audio) return basename(msg.audio.file_name || `audio_${uid(msg.audio)}.mp3`);
  if (msg.video) return basename(msg.video.file_name || `video_${uid(msg.video)}.mp4`);
  if (msg.animation) return basename(msg.animation.file_name || `anim_${uid(msg.animation)}.mp4`);
  if (msg.photo) return `photo_${uid(msg.photo[msg.photo.length - 1])}.jpg`;
  if (msg.voice) return `voice_${uid(msg.voice)}.ogg`;
  if (msg.video_note) return `videonote_${uid(msg.video_note)}.mp4`;
  if (msg.sticker) return `sticker_${uid(msg.sticker)}.webp`;
  return `file_${uid(msg.document)}`;
}
const fileMime = msg => msg.document?.mime_type || msg.audio?.mime_type || msg.video?.mime_type || msg.voice?.mime_type || msg.animation?.mime_type || '';

// Spawn a session in cwd. Identity is the claude conversation UUID: a NEW session
// gets a hub-generated UUID used as BOTH --session-id and our registry/shim key,
// so we can always resume it later. Resuming passes that same UUID via --resume.
// Guards prevent double-spawning one conversation. Returns the session id (string)
// on success, or null if a guard rejected (callers using `if (startSession(...))`
// still work: a uuid string is truthy, null is falsy).
// `topic` ({ place, owned }) binds the session to a forum topic for good (see startFromChat).
function startSession(cwd, { resumeUuid, chatId, topic, extraMcpServers, extraAllowedTools } = {}) {
  const id = resumeUuid || randomUUID();
  const e0 = registry.get(id);
  if (!inProjects(cwd)) { notify(`⛔ ${cwd} is outside this bot's projects (HUB_PROJECTS)`); return null; }
  if (sessions.has(id) || pendingActivate.has(id)) { notify(`already running: ${labelOf(id)}`); return null; }
  if (isOwnLive(e0)) { notify(`${labelOf(id)} is still alive — not resuming (it should reconnect on its own)`); return null; }
  if (resumeUuid) {
    if (!conversationExists(resumeUuid)) { notify(`can't resume ${id.slice(0, 8)} — its history is gone`); registry.delete(id); saveRegistry(); return null; }
    if (jsonlFresh(resumeUuid) && !stoppedAndGone(e0)) { notify(`can't resume ${id.slice(0, 8)} — that conversation looks active right now`); return null; }
    if (liveCwdConflict(id, cwd)) { notify(`can't resume ${id.slice(0, 8)} — another live session is in ${cwd}`); return null; }
  }
  pendingActivate.set(id, String(chatId || CHAT));   // activate it only in the chat that asked
  let child;
  try {
    child = spawnSession({ id, cwd, resumeId: resumeUuid || null, sessionUuid: resumeUuid ? null : id, shimPath: SHIM, tmpDir: TMP, hubPort: PORT, hubToken: IPC_TOKEN, extraMcpServers, extraAllowedTools });
  } catch (e) { pendingActivate.delete(id); registry.delete(id); saveRegistry(); notify(`start failed: ${e?.message}`); return null; }
  // Record the REAL claude pid now (from the pty child), independent of the shim
  // registering — so the liveness guard holds during the spawn→register window.
  upsertRegistry(id, { cwd, label: e0?.label || makeLabel(cwd), status: 'starting', managed: true, resumeUuid: id, pid: child?.pid ?? null, bootId: BOOT_ID, createdAt: e0?.createdAt || Date.now(), lastSeen: Date.now(), stoppedAt: null,
    ...(topic ? { topic: topic.place, topicOwned: !!topic.owned } : {}) });
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
  return id;
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
    // Only the head: transcripts run to tens of MB, and HUB_PROJECTS reads one per project
    // on every /projects. 160 KB always holds the first 40000 chars, even at 4 bytes each.
    // The engine's own name for the session is appended as the conversation goes on — an
    // `ai-title` it generated (panel, or our bridge with persist:true) or a `custom-title`
    // someone set — so look in the tail as well. The last one wins; a set name beats a
    // generated one.
    const buf = Buffer.alloc(160000), fd = openSync(file, 'r');
    let n, tail = '';
    try {
      n = readSync(fd, buf, 0, buf.length, 0);
      const size = statSync(file).size;
      if (size > n) { const tb = Buffer.alloc(Math.min(256000, size - n)); tail = tb.toString('utf8', 0, readSync(fd, tb, 0, tb.length, size - tb.length)); }
    } finally { closeSync(fd); }
    const head = buf.toString('utf8', 0, n).slice(0, 40000);
    let ai = '', custom = '';
    for (const chunk of [buf.toString('utf8', 0, n), tail])
      for (const line of chunk.split('\n')) {
        if (!line.includes('-title"')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'ai-title' && o.aiTitle) ai = String(o.aiTitle);
        if (o.type === 'custom-title' && o.customTitle) custom = String(o.customTitle);
      }
    title = (custom || ai).replace(/\s+/g, ' ').trim().slice(0, 50);
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!title && o.type === 'summary' && o.summary) title = String(o.summary).replace(/\s+/g, ' ').slice(0, 50);
      if (!title && o.type === 'user' && o.message) {
        const c = o.message.content;
        const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.map(x => typeof x === 'string' ? x : (x?.type === 'text' ? x.text : '')) : [];
        for (const part of parts) {
          let t = (part || '').trim();
          if (!t) continue;
          if (/^<channel\b/i.test(t)) { const mm = /<channel[^>]*>([\s\S]*?)<\/channel>/i.exec(t); t = (mm ? mm[1] : '').trim(); } // unwrap a channel message
          else if (t.startsWith('<')) continue; // skip other wrapper blocks (system reminders, etc.)
          if (!t) continue;
          title = t.replace(/\s+/g, ' ').slice(0, 50); break;
        }
      }
      if (cwd && title) break;
    }
  } catch {}
  return { cwd, title };
}
// Locate a conversation transcript by session id (scan the projects dirs) and read
// its stored title — used to name a session that registers without a hub-known name
// (e.g. a VSCode panel resuming an existing conversation).
function findSessionFile(sid) {
  try { for (const dir of readdirSync(PROJECTS_DIR)) { const f = join(PROJECTS_DIR, dir, sid + '.jsonl'); if (existsSync(f)) return f; } } catch {}
  return null;
}
function diskTitle(sid) { const f = findSessionFile(sid); return f ? (readMeta(f).title || '') : ''; }
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
      ss.push({ id: f.replace(/\.jsonl$/, ''), mtime: st.mtimeMs });
    }
    if (!ss.length) continue;
    ss.sort((a, b) => b.mtime - a.mtime);
    const p = { dir: d, sessions: ss, latest: ss[0].mtime };
    if (PROJECT_ROOTS.length) {                       // the folder name encodes cwd lossily — read the real one
      p.cwd = readMeta(join(dir, ss[0].id + '.jsonl')).cwd;
      if (!inProjects(p.cwd)) continue;
    }
    for (const s of ss) idToDir.set(s.id, d);
    byDir.push(p);
  }
  byDir.sort((a, b) => b.latest - a.latest);
  return byDir;
}
const PROJECTS_PROMPT = '📁 Projects (recent). Pick one to see its sessions:';
// Build the top-level projects-list keyboard (refreshes the on-disk snapshot).
function projectsKeyboard() {
  lastProjects = listProjects();
  const kb = new InlineKeyboard();
  lastProjects.slice(0, 10).forEach((p, i) => {
    const cwd = p.cwd || readMeta(join(PROJECTS_DIR, p.dir, p.sessions[0].id + '.jsonl')).cwd || p.dir;
    p.cwd = cwd;
    kb.text(`${shortCwd(cwd)} (${p.sessions.length}) · ${ago(p.latest)}`, `proj:${i}`).row();
  });
  kb.text('➕ Новый проект', 'newproj').row();
  return kb;
}
const projectsPrompt = () => lastProjects.length ? PROJECTS_PROMPT : '📁 Проектов с сессиями пока нет — создай новый:';

// /new: a session in an EXISTING project. It never makes a folder — a typo would quietly
// become a new project; a missing one gets a 📁 button that creates it on purpose.
const missingProj = new Map();   // place -> the name /new didn't find, for the 📁 button
const openPick = new Map();      // place -> [cwd] when that name exists under several roots
async function openProject(ctx, arg) {
  const r = access.projectPath(arg, PROJECT_ROOTS);
  if (r.error) { await ctx.reply(`⚠️ ${r.error}`); return; }
  const found = r.pickRoot
    ? PROJECT_ROOTS.map(root => access.projectPath(arg, [root]).cwd).filter(c => c && existsSync(c))
    : (existsSync(r.cwd) ? [r.cwd] : []);
  if (found.length > 1) {
    openPick.set(here(ctx), found);
    const kb = new InlineKeyboard();
    found.forEach((c, i) => kb.text(c, `npo:${i}`).row());
    await ctx.reply(`«${arg.trim()}» есть в нескольких папках — в каком?`, { reply_markup: kb });
    return;
  }
  if (!found.length) {
    if (!r.pickRoot && !r.canCreate) { await ctx.reply(`⚠️ папки нет: ${r.cwd}`); return; }   // outside the roots, or no roots at all
    missingProj.set(here(ctx), arg);
    const name = arg.trim();
    await ctx.reply(`⚠️ проекта «${name}» нет. /new открывает только существующие проекты.`,
      { reply_markup: new InlineKeyboard().text(`📁 Создать проект «${name.slice(0, 40)}»`, 'mkproj') });
    return;
  }
  if (await startFromChat(ctx, found[0])) await ctx.reply(`➕ starting new session in ${found[0]}…`);
}
// ➕ Новый проект and a bare /newproject: ask for the name; the reply goes to newProject().
async function askProjectName(ctx) {
  const hint = PROJECT_ROOTS.length ? `папка в ${PROJECT_ROOTS.join(' или ')}` : 'полный путь к существующей папке';
  const sent = await ctx.reply(`Название нового проекта (${hint}) — ответом на это сообщение:`,
    { reply_markup: { force_reply: true, input_field_placeholder: PROJECT_ROOTS.length ? 'Oligo' : 'D:/path/to/project' } }).catch(() => null);
  if (sent?.message_id) newProjPrompt.set(sent.message_id, here(ctx));
}

// /newproject <arg> and ➕ Новый проект: resolve the name/path (access.projectPath), create
// the folder if it's missing and allowed, then start a session there, active in this chat.
// `root` is set when the user picked one of several HUB_PROJECTS roots.
async function newProject(ctx, arg, root) {
  const r = access.projectPath(arg, root ? [root] : PROJECT_ROOTS);
  if (r.error) { await ctx.reply(`⚠️ ${r.error}`); return; }
  if (r.pickRoot) {
    newProjArg.set(here(ctx), arg);
    const kb = new InlineKeyboard();
    PROJECT_ROOTS.forEach((p, i) => kb.text(p, `npr:${i}`).row());
    await ctx.reply(`Где создать «${arg.trim()}»?`, { reply_markup: kb });
    return;
  }
  if (!existsSync(r.cwd)) {
    if (!r.canCreate) { await ctx.reply(`⚠️ папки нет: ${r.cwd}`); return; }
    try { mkdirSync(r.cwd, { recursive: true }); }
    catch (e) { await ctx.reply(`⚠️ не смог создать ${r.cwd}: ${e?.message || e}`); return; }
    await ctx.reply(`📁 создан проект ${r.cwd}`);
  }
  if (await startFromChat(ctx, r.cwd)) await ctx.reply(`➕ starting new session in ${r.cwd}…`);
}

// ── forum: a topic per session ───────────────────────────────────────────────
// A session started or resumed from a forum's General gets a topic of its own, named after
// it; started inside a topic, it lives in that topic. Either way the binding goes into the
// registry (topic, topicOwned), so after /stop or a hub restart the session comes back to
// the same topic. Only topics the hub created itself are renamed after the session and
// closed with it — a topic a person made stays theirs.
const topicApi = (place, call) => { const { chat, thread } = splitPlace(place); return call(chat, thread.message_thread_id).catch(e => e); };
const renameTopic = (place, name) => topicApi(place, (c, t) => bot.api.editForumTopic(c, t, { name: String(name).slice(0, 128) }));
const closeTopic = place => topicApi(place, (c, t) => bot.api.closeForumTopic(c, t));
// Where a session started from this update should live: { place, topic?, created? }, or
// { error } when its topic couldn't be reopened.
async function topicFor(ctx, id, label) {
  const e = id && registry.get(id);
  if (e?.topic) {                                   // it has a topic — reopen it (no-op if open) and go back there
    const r = await topicApi(e.topic, (c, t) => bot.api.reopenForumTopic(c, t));
    const desc = r instanceof Error ? (r.description || r.message || '') : '';
    if (!desc || /TOPIC_NOT_MODIFIED/i.test(desc)) return { place: e.topic, topic: { place: e.topic, owned: !!e.topicOwned } };
    // Only a topic Telegram says is gone may be replaced: a network blip or a revoked right
    // must not cost the session its topic (a new one would overwrite the binding).
    if (!isTopicGoneError(desc)) return { error: `не смог открыть тему сессии (${desc})` };
  }
  if (ctx.msg?.is_topic_message) return { place: here(ctx), topic: { place: here(ctx), owned: false } };
  if (!ctx.chat?.is_forum) return { place: here(ctx) };
  try {
    const t = await bot.api.createForumTopic(ctx.chat.id, String(label).slice(0, 128));
    const place = `${ctx.chat.id}:${t.message_thread_id}`;
    return { place, topic: { place, owned: true }, created: true };
  } catch (err) {
    await ctx.reply(`⚠️ не смог создать тему (${err?.description || err?.message}) — боту нужно право «Управление темами». Сессия будет здесь.`);
    return { place: here(ctx) };
  }
}
// The one way a person starts or resumes a session from Telegram (/new, ➕, /projects, ▶).
async function startFromChat(ctx, cwd, opts = {}) {
  const id = opts.resumeUuid;
  const label = (id && (registry.get(id)?.label || diskTitle(id))) || makeLabel(cwd);
  const hadTopic = !!(id && registry.get(id)?.topic);
  const t = await topicFor(ctx, id, label);
  if (t.error) { await ctx.reply(`⚠️ ${t.error} — попробуй ещё раз`); return null; }
  const sid = startSession(cwd, { ...opts, chatId: t.place, topic: t.topic });
  if (!sid) { if (t.created) await topicApi(t.place, (c, th) => bot.api.deleteForumTopic(c, th)); return null; }   // no empty topics
  // Text held here (written before this chat had a session) is delivered where the session
  // becomes active — its topic — so it has to move there with it.
  if (t.place !== here(ctx)) { const held = pending.take(here(ctx)); if (held) pending.put(t.place, held); }
  if (t.topic && t.place !== here(ctx)) await ctx.reply(`📌 ${label} — в теме ${topicLink(t.place) || ''}`.trim(), { link_preview_options: { is_disabled: true } }).catch(() => {});
  // In a forum the bottom keyboard belongs to a topic: one the hub made (or one the session
  // just moved into) has none until something brings it — so the first message does.
  if (t.topic && (t.created || !hadTopic || t.place !== here(ctx)))
    await sendTg(t.place, `▶ ${label}\n📁 ${cwd}\nПиши сюда — это тема этой сессии.`, null, { reply_markup: replyKeyboard(t.place) });
  return sid;
}
// /stop, ⏹ and a topic closed by hand. A session with a topic stays in the registry (⏸,
// resumable into the same topic); one without is forgotten, as before.
async function stopSession(id, { topicClosedByUser = false } = {}) {
  sendToSession(id, { t: 'stop' });
  clearWorking(id);
  const e = registry.get(id);
  if (!e?.topic) { registry.delete(id); saveRegistry(); return; }
  e.stoppedAt = Date.now(); saveRegistry();   // resumable as soon as its process is gone (see stoppedAndGone)
  if (e.topicOwned && !topicClosedByUser) {
    await sendTg(e.topic, `🛑 ${labelOf(id)} остановлена. Вернуть: /sessions → ⏸ (тема откроется сама).`);
    await closeTopic(e.topic);
  }
}
// The stopped session bound to a topic, if any (a live one is simply the topic's active one).
const boundTo = place => isTopicPlace(place) && [...registry.values()]
  .find(e => e.topic === place && e.managed && e.status === 'dead' && !sessions.has(e.id) && !pendingActivate.has(e.id));

// A topic closed by hand in Telegram stops its session, like /stop (the topic stays closed).
bot.on('message:forum_topic_closed', async ctx => {
  if (!owns(ctx)) return;
  const place = here(ctx);
  const id = active.get(place) || [...registry.values()].find(e => e.topic === place && sessions.has(e.id))?.id;
  if (id && sessions.has(id)) await stopSession(id, { topicClosedByUser: true });
});

// A deleted topic: unbind it, so the session isn't aimed at nothing, and say so.
function topicGone(place) {
  active.drop(place);
  let hit = false;
  for (const e of registry.values()) if (e.topic === place) { delete e.topic; delete e.topicOwned; hit = true; notify(`⚠️ тема сессии ${e.label} удалена — сессия осталась без темы, выбери её через /sessions`); }
  if (hit) saveRegistry();
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
  let buf = '', sid = null, refused = false;
  sock.setEncoding('utf8');
  sock.on('data', d => {
    if (refused) return;
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.t === 'register') {
        if (m.token !== IPC_TOKEN) { sock.end(); return; }
        if (!inProjects(m.cwd)) {
          // Not this bot's project. Keep the socket but ignore it: on close the shim/panel
          // reconnects every 2 s and would be refused again, forever.
          refused = true;
          console.error(`[hub] refused ${m.sessionId} in ${m.cwd}: outside HUB_PROJECTS`);
          return;
        }
        sid = m.sessionId;
        const known = registry.get(sid);
        const managed = known?.managed ?? pendingActivate.has(sid); // hub-started ones are pending/known
        const readopt = known?.status === 'detached' || known?.status === 'dead';
        const label = known?.label || makeLabel(m.cwd);
        // Replace a superseded live connection deterministically (avoid orphan/leak).
        const prev = sessions.get(sid);
        if (prev?.conn && prev.conn !== sock) { try { prev.conn.destroy(); } catch {} }
        sessions.set(sid, { conn: sock, cwd: m.cwd, label, kind: m.kind || 'cli' });
        if (!order.includes(sid)) order.push(sid);
        if (managed) {
          upsertRegistry(sid, {
            cwd: m.cwd, label, status: 'live', lastSeen: Date.now(), managed: true,
            resumeUuid: known?.resumeUuid ?? sid, createdAt: known?.createdAt ?? Date.now(),
            pid: m.ppid || known?.pid || null, bootId: BOOT_ID,
          });
        }
        // A session that registers without a hub-known name (e.g. a VSCode panel
        // resuming an existing conversation) — pull its stored title from disk so it
        // shows its real name instead of just the cwd folder.
        if (!known?.named) { const dt = diskTitle(sid); if (dt) applyName(sid, dt, true); }
        const wantChat = pendingActivate.get(sid);
        if (wantChat !== undefined) { active.set(wantChat, sid); pendingActivate.delete(sid); }
        else if (known?.topic) active.set(known.topic, sid);  // came back on its own (hub restart) → its topic again
        else if (!active.get(CHAT)) active.set(CHAT, sid);   // first session ever → home chat
        // The picker offered in an empty chat also lists ⏸ resumable sessions, and tapping one
        // goes through startSession — never through the switch: handler. Deliver here, where a
        // session becomes a chat's active one no matter how it got up: new, resumed or re-adopted.
        // No ctx and no original message_id, so this goes out like pendingFirstMsg does, and the
        // answer will carry no reply-quote.
        if (wantChat !== undefined) {
          const held = pending.take(wantChat);
          const meta = { chat_id: String(wantChat), message_id: '', user: 'hub', user_id: '', ts: new Date().toISOString() };
          if (held && sendToSession(sid, { t: 'inbound', content: held, meta })) {
            lastInbound.set(sid, nextInbound(lastInbound.get(sid), meta));
            armAutoName(sid, held);
          }
        }
        console.error(`[hub] ${readopt ? 're-adopted' : 'registered'}: ${labelOf(sid)} = ${sid} (cwd ${m.cwd})`);
        notify(`${readopt ? '♻️ re-adopted' : '✅ registered'} ${labelOf(sid)}\ncwd: ${m.cwd}\nactive: ${labelOf(active.get(CHAT))}`, { reply_markup: replyKeyboard(CHAT) });
        // External {t:'start',content}: deliver the queued first message now that it's live.
        const first = pendingFirstMsg.get(sid);
        if (first) { pendingFirstMsg.delete(sid); if (sendToSession(sid, { t: 'inbound', content: first.content, meta: first.meta })) armAutoName(sid, first.content); }
      } else if (m.t === 'title') {
        applyName(m.sessionId, m.title, true); // the session's claude named itself
      } else if (m.t === 'turn') {
        // Both edges of a turn, from a stream bridge: 'start' on the engine's user message
        // (so a turn typed in the PANEL also lights up), 'end' on its result record.
        const s = sessions.get(m.sessionId); if (s) s.sawTurn = true;   // this bridge reports turn edges
        if (m.state === 'end') clearWorking(m.sessionId); else markWorking(m.sessionId);
      } else if (m.t === 'status') {
        // A status may START the mark only from a bridge that also reports turn edges: the
        // engine emits one right AFTER the answer (checked: turn:start → reply → status →
        // turn:end), so without an end signal to follow it the ⚡ would never go out.
        if (sessions.get(m.sessionId)?.sawTurn) markWorking(m.sessionId);
        const w = working.get(m.sessionId); if (w) w.tokens = Number(m.tokens || 0);
      } else if (m.t === 'reply') {
        // A channels session has no end-of-turn signal at all, so its answer is the only
        // thing that can clear the mark. A stream session sends `turn end` instead — and
        // clearing on its reply would be wrong twice over: the model speaks mid-turn, and
        // the very next thing after an answer is a `status` that would light it up again.
        // A bridge from before turn edges existed reports neither, so fall back to the old
        // rule for it — otherwise its ⚡ would hang until the ttl.
        if (!(isStream(m.sessionId) && sessions.get(m.sessionId)?.sawTurn)) clearWorking(m.sessionId);
        const to = m.chat_id || CHAT;
        const last = lastInbound.get(m.sessionId);
        // Header as a blockquote, ALWAYS, in every chat. The blank line is load-bearing:
        // rich messages are Markdown, where a single newline does NOT start a new block, so
        // `[label]\n` merged the header into the answer's first sentence. mdToTgHtml turns the
        // same `> ` line into <blockquote>, so the fallback path renders it as a quote too.
        const header = `> ${labelOf(m.sessionId)}\n\n`;
        sendMd(to, header + m.text, m.sessionId, {}, last?.ambiguous ? {} : replyExtra(last, to));
        if (last) last.pending = false;  // answered — the next writer isn't competing with anyone
      } else if (m.t === 'permission_request') {
        clearWorking(m.sessionId);   // not working — waiting on a human; the list says 🔐 while pendingPerm holds it
        pendingPerm.set(m.request_id, m.sessionId);
        // Both kinds of card belong where the request came from: a person driving the session
        // from a group must be able to answer there, or the session waits for nobody.
        const cardChat = askChatFor(lastInbound.get(m.sessionId), CHAT);
        if (m.ask) {                                   // stream path: structural questions -> option buttons
          askState.set(m.request_id, { sessionId: m.sessionId, qs: m.ask, picks: m.ask.questions.map(() => []), cur: 0, chatId: cardChat });
          const c = askCard(m.request_id);
          // Moved to the home chat → repoint askState, so the four later editTg(st.chatId, …)
          // sites (cancel, redraw, next question, summary) edit the chat that has the card.
          sendCard(m.request_id, m.sessionId, cardChat, c.text, c.kb, chat => { const st = askState.get(m.request_id); if (st) st.chatId = chat; });
        } else {                                       // channels (or any other tool): Allow/Deny as before
          const kb = new InlineKeyboard().text('✅ Allow', `perm:${m.request_id}:allow`).text('❌ Deny', `perm:${m.request_id}:deny`).row();
          // …plus the engine's own "don't ask again" offers (stream sessions only)
          (m.suggestions || []).slice(0, 4).forEach((s, i) => kb.text(btnLabel(suggestLabel(s)), `psug:${m.request_id}:${i}`).row());
          const pv = (m.input_preview && askDigest(m.tool_name, m.input_preview)) || m.input_preview;
          const body = `🔐 [${labelOf(m.sessionId)}] ${m.tool_name}` + (m.description ? `\n${m.description}` : '') + (pv ? `\n${pv}` : '');
          sendCard(m.request_id, m.sessionId, cardChat, body, kb);
        }
      } else if (m.t === 'approval_cancel') {
        // The session answered this approval elsewhere (e.g. in the VSCode panel) —
        // drop the now-stale Telegram buttons.
        pendingPerm.delete(m.request_id); askState.delete(m.request_id);
        const card = permMsg.get(m.request_id); permMsg.delete(m.request_id);
        if (card) bot.api.editMessageText(splitPlace(card.chat).chat, card.mid, `🔐 [${labelOf(m.sessionId)}] ${m.tool || 'tool'} — ✅ обработано в панели`).catch(() => {});
      } else if (m.t === 'inject') {
        // External, programmatic inbound (a local consumer process, NOT a human in
        // Telegram). Authenticated like register; target is a live session's id or
        // label; delivered exactly like routeTo. This socket isn't a registered
        // session (sid stays null) — it's a one-shot request/response.
        if (m.token !== IPC_TOKEN) { sock.end(); return; }
        const id = order.find(x => x === m.target || labelOf(x) === m.target);
        const meta = { ...(m.meta || {}) };
        if (!meta.chat_id) meta.chat_id = CHAT; // replies default to the bot's home chat (DM or group)
        if (id && sendToSession(id, { t: 'inbound', content: m.content, meta })) {
          armAutoName(id, m.content);
          sock.write(JSON.stringify({ ok: true }) + '\n');
        } else {
          sock.write(JSON.stringify({ ok: false, error: 'session not connected' }) + '\n');
        }
      } else if (m.t === 'start') {
        // External, programmatic session creation (symmetric to inject): spawn a new
        // hub-MANAGED session (durable/resumable, owned by the daemon) in `cwd`, or
        // resume `resume` (a known uuid). Optional `content` is injected as the first
        // user-turn once it registers; optional extraMcpServers/extraAllowedTools are
        // passed through to spawnSession. Replies to {ok:true,id} so the consumer can
        // later target it via inject. Not a registered session (sid stays null).
        if (m.token !== IPC_TOKEN) { sock.end(); return; }
        const cwd = m.resume ? (registry.get(m.resume)?.cwd || m.cwd) : m.cwd;
        if (!cwd) { sock.write(JSON.stringify({ ok: false, error: 'cwd required (or resume an unknown uuid)' }) + '\n'); return; }
        const newId = startSession(cwd, { resumeUuid: m.resume || undefined, extraMcpServers: m.extraMcpServers, extraAllowedTools: m.extraAllowedTools });
        if (!newId) { sock.write(JSON.stringify({ ok: false, error: 'could not start (already running / history gone / cwd conflict / outside HUB_PROJECTS)' }) + '\n'); return; }
        if (m.content != null && String(m.content) !== '') {
          const meta = { ...(m.meta || {}) };
          if (!meta.chat_id) meta.chat_id = CHAT;
          pendingFirstMsg.set(newId, { content: String(m.content), meta });
        }
        sock.write(JSON.stringify({ ok: true, id: newId }) + '\n');
      } else if (m.t === 'notify') {
        // Standalone Telegram notification from ANY local client — e.g. the hub
        // plugin's `notify` tool (shim.mjs), callable even from a session NOT joined
        // to the hub. No session, no [label] prefix — just deliver text to the home
        // chat (or an explicit chat_id).
        if (m.token !== IPC_TOKEN) { sock.end(); return; }
        const text = String(m.text ?? '').trim();
        if (!text) { sock.write(JSON.stringify({ ok: false, error: 'empty text' }) + '\n'); return; }
        // Same render path as a session's reply: a notification is model-written Markdown
        // too, and going through sendTg dropped its tables into rows of pipes.
        sendMd(m.chat_id || CHAT, text);
        sock.write(JSON.stringify({ ok: true }) + '\n');
      } else if (m.t === 'send_file') {
        // A local file (screenshot, generated image, PDF, log) → the chat. Hub and the
        // calling shim share the filesystem, so we read the PATH from disk — no bytes on
        // the wire. Photo vs document is chosen by extension (or forced via `as`).
        if (m.token !== IPC_TOKEN) { sock.end(); return; }
        const path = String(m.path ?? '').trim();
        if (!path) { sock.write(JSON.stringify({ ok: false, error: 'empty path' }) + '\n'); return; }
        if (!existsSync(path)) { sock.write(JSON.stringify({ ok: false, error: 'file not found: ' + path }) + '\n'); return; }
        const method = chooseFileMethod(path, m.as);
        const to = m.chat_id || CHAT;
        const rawCap = String(m.caption ?? '').trim();
        // Caption counts toward Telegram's 1024-char cap on the VISIBLE text; cut the raw
        // Markdown first, then render. An over-long caption rejects the whole upload.
        const cap = rawCap.slice(0, CAPTION_LIMIT);
        const opts = cap ? { caption: mdToTgHtml(cap), parse_mode: 'HTML' } : {};
        const { chat: toChat, thread: toThread } = splitPlace(to);
        bot.api[method](toChat, new InputFile(path), { ...toThread, ...opts })
          .then(() => sock.write(JSON.stringify({ ok: true, method }) + '\n'))
          .catch(e => {
            // HTML caption rejected (bad entities) → retry once with the plain caption.
            const plainOpts = cap ? { caption: cap } : {};
            bot.api[method](toChat, new InputFile(path), { ...toThread, ...plainOpts })
              .then(() => sock.write(JSON.stringify({ ok: true, method }) + '\n'))
              .catch(e2 => sock.write(JSON.stringify({ ok: false, error: (e2?.description || e2?.message || String(e2)) }) + '\n'));
          });
      }
    }
  });
  sock.on('close', () => {
    if (!sid) return;
    if (sessions.get(sid)?.conn !== sock) return; // superseded by a newer registration — ignore this orphan
    const label = labelOf(sid);
    sessions.delete(sid);
    lastInbound.delete(sid); // a resume reuses this id — don't quote a message from its previous life
    clearWorking(sid);
    for (const [rid, st] of askState) if (st.sessionId === sid) askState.delete(rid); // its cards can never resolve now
    const i = order.indexOf(sid); if (i >= 0) order.splice(i, 1);
    active.clearSession(sid);   // no guessing a replacement — the next message would land somewhere random
    // Decide the durable fate by whether the claude process is actually gone.
    const e = registry.get(sid);
    let resumable = false;
    if (e?.managed) { resolveFate(e, sid); resumable = e.status === 'dead'; saveRegistry(); }
    notify(`⚠️ ${label} disconnected${resumable ? ' — resume via /sessions' : ''}`, { reply_markup: replyKeyboard(CHAT) });
  });
  sock.on('error', () => {});
}).on('error', e => { console.error(`[hub] IPC on ${PORT} failed: ${e?.message}`); process.exit(1); })
  .listen(PORT, '127.0.0.1', () => console.error(`[hub] IPC on 127.0.0.1:${PORT}; state ${HUB_CFG_DIR}`));

// ── Telegram ─────────────────────────────────────────────────────────────────
// Access gate: the owner (in any chat, DM included) OR anyone on the access list —
// but only from a GROUP chat. DMs with the bot stay owner-only. See access.mjs.
const owns = ctx => access.canUse(
  { userId: ctx.from?.id, chatType: ctx.chat?.type, isBot: ctx.from?.is_bot },
  { owner: OWNER });

bot.command('start', async ctx => { if (!owns(ctx)) return; await ctx.reply('Hub ready. /sessions = live · /projects = history+resume', { reply_markup: replyKeyboard(here(ctx)) }); });

// Discover a chat's id. Open to everyone in a GROUP (it reveals only the caller's own
// id and the chat's) — that's how a newcomer can hand the owner their id. In a DM it
// stays owner-only, like every other DM interaction.
bot.command('id', async ctx => {
  if (ctx.chat?.type === 'private' && String(ctx.from?.id) !== OWNER) return;
  await ctx.reply(`chat_id: ${ctx.chat.id}${ctx.msg?.is_topic_message ? `\ntopic (message_thread_id): ${ctx.msg.message_thread_id}` : ''}\ntype: ${ctx.chat.type}\nyour user_id: ${ctx.from?.id}`);
});

// ── access list management (owner only) ──────────────────────────────────────
// Managing the list is owner-only even though listed people otherwise have full
// rights: a list that can extend itself stops being a list. Bot API cannot turn an
// @username into a user_id, so a target is either the quoted message's author or an
// explicit numeric id.
const isOwner = ctx => String(ctx.from?.id) === OWNER;
const ALLOW_USAGE = 'usage: /allow <user_id> [имя]\nили ответь этой командой на сообщение человека';

bot.command('allow', async ctx => {
  if (!isOwner(ctx)) { if (owns(ctx)) await ctx.reply('только владелец может менять список'); return; }
  const t = access.parseTarget(ctx.match, access.personOf(ctx.message?.reply_to_message));
  if (!t) { await ctx.reply(ALLOW_USAGE); return; }
  if (t.id === OWNER) { await ctx.reply('это ты — владелец, тебе список не нужен'); return; }
  await ctx.reply(access.add(t.id, t.name, ctx.from.id)
    ? `✅ ${t.name} (${t.id}) добавлен — может писать боту в групповых чатах`
    : `${t.name} (${t.id}) уже в списке`);
});

bot.command('deny', async ctx => {
  if (!isOwner(ctx)) { if (owns(ctx)) await ctx.reply('только владелец может менять список'); return; }
  const t = access.parseTarget(ctx.match, access.personOf(ctx.message?.reply_to_message));
  if (!t) { await ctx.reply(ALLOW_USAGE.replace(/allow/g, 'deny')); return; }
  await ctx.reply(access.remove(t.id) ? `🚫 ${t.name} (${t.id}) удалён из списка` : `${t.name} (${t.id}) в списке и не был`);
});

// A shared contact carries the person's user_id when it's a Telegram account — the way to
// add someone the bot hasn't seen write yet: the Bot API can't turn @username into an id,
// and an @mention in text arrives without one.
const contactNames = new Map();   // user_id -> name, for the ✅ button below
bot.on('message:contact', async ctx => {
  if (!isOwner(ctx)) return;
  const c = ctx.message.contact;
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || String(c.user_id || '?');
  if (!c.user_id) { await ctx.reply(`👤 ${name}: это не аккаунт Telegram (или он скрыт) — id в контакте нет`); return; }
  const id = String(c.user_id);
  if (id === OWNER) { await ctx.reply('это ты — владелец, тебе список не нужен'); return; }
  if (access.roleOf(id)) { await ctx.reply(`👤 ${name} (${id}) уже в списке доступа — /deny ответом на контакт, чтобы убрать`); return; }
  contactNames.set(id, name);
  await ctx.reply(`👤 ${name} — id ${id}`, { reply_markup: new InlineKeyboard().text('✅ Разрешить в группах', `allowc:${id}`) });
});

bot.command('who', async ctx => {
  if (!owns(ctx)) return;
  const rows = access.list().map(u => `• ${u.name} (${u.id}) — добавил ${u.by || '?'}, ${String(u.added || '').slice(0, 10)}`);
  await ctx.reply([`👤 владелец: ${OWNER}`, ...(rows.length ? rows : ['список пуст — /allow реплаем на сообщение человека'])].join('\n'));
});

bot.command('sessions', async ctx => {
  if (!owns(ctx)) return;
  const resumable = resumableEntries();
  if (!order.length && !resumable.length) { await ctx.reply('no live sessions. /projects to resume an old one.', { reply_markup: replyKeyboard(here(ctx)) }); return; }
  await ctx.reply(sessionsText(here(ctx)), { parse_mode: 'HTML', reply_markup: sessionInline(here(ctx)) });
  await ctx.reply('⚡ работает · 🔐 ждёт аппрув · ● активная\nswitch ↓, resume ⏸, or reply to a session\'s message',
    { reply_markup: replyKeyboard(here(ctx)) });
});

bot.command('projects', async ctx => {
  if (!owns(ctx)) return;
  const kb = projectsKeyboard();
  await ctx.reply(projectsPrompt(), { reply_markup: kb });
});

bot.command('use', async ctx => {
  if (!owns(ctx)) return;
  const id = order.find(x => labelOf(x) === (ctx.match || '').trim() || x === (ctx.match || '').trim());
  if (id) { active.set(here(ctx), id); await ctx.reply(`▶ active: ${labelOf(id)}`, { reply_markup: replyKeyboard(here(ctx)) }); } else await ctx.reply('not found');
});

bot.command('stop', async ctx => {
  if (!owns(ctx)) return;
  const arg = (ctx.match || '').trim();
  const id = order.find(x => labelOf(x) === arg || x === arg);
  if (!id) { await ctx.reply('not found — /sessions to list'); return; }
  await ctx.reply(`🛑 stopping ${labelOf(id)}…`);
  await stopSession(id);   // without a topic: forgotten (not offered as resumable); with one: ⏸ + topic closed
});

bot.command('new', async ctx => {
  if (!owns(ctx)) return;
  const arg = (ctx.match || '').trim();
  if (!arg) { await ctx.reply(`usage: /new <имя проекта | полный путь> — новая сессия в существующем проекте${PROJECT_ROOTS.length ? ` (папка в ${PROJECT_ROOTS.join(' или ')})` : ''}\nновый проект: /newproject <имя> или /projects → ➕ Новый проект`); return; }
  await openProject(ctx, arg);
});

bot.command('newproject', async ctx => {
  if (!owns(ctx)) return;
  const arg = (ctx.match || '').trim();
  if (!arg) { await askProjectName(ctx); return; }
  await newProject(ctx, arg);
});

// Panel/stream commands → forwarded to the active control-capable session, which
// runs them over the stream-json control-protocol and replies via the hub.
for (const name of ['context', 'rc', 'limits', 'compact', 'interrupt', 'browser']) {
  bot.command(name, async ctx => {
    if (!owns(ctx)) return;
    const id = activeIn(ctx);
    if (!id || !sessions.has(id)) { await ctx.reply('нет активной сессии'); return; }
    if (!isStream(id)) { await ctx.reply('⚙️ доступно только для stream-сессий (панель VSCode / TG на stream-json)'); return; }
    sendToSession(id, { t: 'command', name, chat_id: here(ctx) });
  });
}
// /model <name> — switch the active stream session's model mid-conversation (control
// set_model). The engine resolves aliases itself, so `opus`/`sonnet` mean whatever its
// version maps them to; `default` goes back to the session's start model.
bot.command('model', async ctx => {
  if (!owns(ctx)) return;
  const model = (ctx.match || '').trim();
  if (!model) { await ctx.reply('usage: /model <модель>\nнапр. /model opus · /model claude-opus-5-5 · /model sonnet · /model default'); return; }
  const id = activeIn(ctx);
  if (!id || !sessions.has(id)) { await ctx.reply('нет активной сессии'); return; }
  if (!isStream(id)) { await ctx.reply('⚙️ доступно только для stream-сессий (панель VSCode / TG на stream-json)'); return; }
  sendToSession(id, { t: 'command', name: 'model', arg: model, chat_id: here(ctx) });
});

bot.on('callback_query:data', async ctx => {
  if (!owns(ctx)) { await ctx.answerCallbackQuery().catch(() => {}); return; }
  const data = ctx.callbackQuery.data;
  let m;

  if (data === 'refresh') {
    // Redraw the list in place. Telegram rejects an edit that changes nothing ("message is
    // not modified"), and that is precisely the "nothing moved" case — say so on the toast.
    await ctx.editMessageText(sessionsText(here(ctx)), { parse_mode: 'HTML', reply_markup: sessionInline(here(ctx)) })
      .then(() => ctx.answerCallbackQuery().catch(() => {}))
      .catch(() => ctx.answerCallbackQuery({ text: 'без изменений' }).catch(() => {}));
    return;
  }

  if ((m = /^switch:(.+)$/.exec(data))) {
    const id = m[1];
    if (sessions.has(id)) {
      active.set(here(ctx), id);
      await ctx.answerCallbackQuery({ text: `active: ${labelOf(id)}` }).catch(() => {});
      await ctx.editMessageReplyMarkup({ reply_markup: sessionInline(here(ctx)) }).catch(() => {});
      await notify(`▶ active: ${labelOf(id)}`, { reply_markup: replyKeyboard(CHAT) });
      const held = pending.take(here(ctx));
      if (held) { if (!await routeTo(ctx, id, held)) pending.put(here(ctx), held); }   // re-hold on delivery failure
    } else await ctx.answerCallbackQuery({ text: 'session gone' }).catch(() => {});
    return;
  }

  if ((m = /^stop:(.+)$/.exec(data))) {
    const id = m[1];
    if (sessions.has(id)) { await ctx.answerCallbackQuery({ text: `stopping ${labelOf(id)}` }).catch(() => {}); await stopSession(id); }
    else await ctx.answerCallbackQuery({ text: 'already gone' }).catch(() => {});
    return;
  }

  if ((m = /^forget:(.+)$/.exec(data))) {
    const id = m[1];
    registry.delete(id); saveRegistry();
    await ctx.answerCallbackQuery({ text: 'forgotten' }).catch(() => {});
    await ctx.editMessageReplyMarkup({ reply_markup: sessionInline(here(ctx)) }).catch(() => {});
    return;
  }

  if ((m = /^cmd:(.+):(context|rc|limits|compact|interrupt|browser)$/.exec(data))) {
    const [, id, name] = m;
    if (!sessions.has(id)) { await ctx.answerCallbackQuery({ text: 'session gone' }).catch(() => {}); return; }
    if (!isStream(id)) { await ctx.answerCallbackQuery({ text: 'только для stream-сессий' }).catch(() => {}); return; }
    sendToSession(id, { t: 'command', name, chat_id: here(ctx) });
    await ctx.answerCallbackQuery({ text: name }).catch(() => {});
    return;
  }

  if ((m = /^perm:([a-z]{5}):(allow|deny)$/.exec(data))) {
    const [, rid, behavior] = m;
    const s = pendingPerm.get(rid);
    if (s) { sendToSession(s, { t: 'permission_decision', request_id: rid, behavior }); pendingPerm.delete(rid); }
    permMsg.delete(rid);
    await ctx.answerCallbackQuery({ text: behavior === 'allow' ? 'Allowed' : 'Denied' }).catch(() => {});
    await ctx.editMessageText(`${ctx.callbackQuery.message?.text || ''}\n\n${behavior === 'allow' ? '✅ Allowed' : '❌ Denied'}`).catch(() => {});
    return;
  }

  // "Don't ask again" — allow this call AND apply the engine's suggestion #i. Only the
  // index travels; the session replays the engine's own suggestion object verbatim.
  if ((m = /^psug:([a-z]{5}):([0-3])$/.exec(data))) {
    const [, rid, i] = m;
    const s = pendingPerm.get(rid);
    if (!s) { await ctx.answerCallbackQuery({ text: 'expired' }).catch(() => {}); return; }
    sendToSession(s, { t: 'permission_decision', request_id: rid, behavior: 'allow', suggestion: Number(i) });
    pendingPerm.delete(rid); permMsg.delete(rid);
    await ctx.answerCallbackQuery({ text: 'Allowed + правило' }).catch(() => {});
    await ctx.editMessageText(`${ctx.callbackQuery.message?.text || ''}\n\n✅ Allowed — правило применено`).catch(() => {});
    return;
  }

  // AskUserQuestion: cancel the whole card → deny. The engine hands `message` to the
  // model as the tool result, so it learns WHY there's no answer (and deny needs one).
  if ((m = /^ask:([a-z]{5}):x$/.exec(data))) {
    const rid = m[1], st = askState.get(rid);
    if (!st) { await ctx.answerCallbackQuery({ text: 'expired' }).catch(() => {}); return; }
    askState.delete(rid); pendingPerm.delete(rid); permMsg.delete(rid);
    sendToSession(st.sessionId, { t: 'permission_decision', request_id: rid, behavior: 'deny', message: 'User cancelled the question in Telegram.' });
    await ctx.answerCallbackQuery({ text: 'Отменено' }).catch(() => {});
    await editTg(st.chatId, ctx.callbackQuery.message.message_id, `❓ [${labelOf(st.sessionId)}] — ❌ отменено`);
    return;
  }

  // AskUserQuestion: pick/toggle an option. Indices only (callback_data ≤ 64 bytes, and
  // they address the ORIGINAL engine input — see panel/ask.mjs).
  if ((m = /^ask:([a-z]{5}):([0-3]):([0-3]|ok)$/.exec(data))) {
    const [, rid, qs_, act] = m;
    const st = askState.get(rid);
    if (!st) { await ctx.answerCallbackQuery({ text: 'expired' }).catch(() => {}); return; }
    const qi = Number(qs_), q = st.qs.questions[qi];
    if (!q || qi !== st.cur) { await ctx.answerCallbackQuery({ text: 'stale' }).catch(() => {}); return; } // tap on an already-passed question
    const sel = st.picks[qi], mid = ctx.callbackQuery.message.message_id;
    if (act === 'ok') {
      if (!sel.length) { await ctx.answerCallbackQuery({ text: 'выберите хотя бы один вариант' }).catch(() => {}); return; }
    } else {
      const oi = Number(act);
      if (!q.options[oi]) { await ctx.answerCallbackQuery().catch(() => {}); return; }
      if (q.multiSelect) {                                  // toggle in place, commit on ✔
        const k = sel.indexOf(oi); if (k >= 0) sel.splice(k, 1); else sel.push(oi);
        await ctx.answerCallbackQuery().catch(() => {});
        const c = askCard(rid);
        await editTg(st.chatId, mid, c.text, { reply_markup: c.kb });
        return;
      }
      st.picks[qi] = [oi];                                  // single select commits on tap
    }
    await ctx.answerCallbackQuery().catch(() => {});
    if (++st.cur < st.qs.questions.length) {                // next question, SAME card
      const c = askCard(rid);
      await editTg(st.chatId, mid, c.text, { reply_markup: c.kb });
      return;
    }
    askState.delete(rid); pendingPerm.delete(rid); permMsg.delete(rid);
    sendToSession(st.sessionId, { t: 'permission_decision', request_id: rid, behavior: 'allow', answers: st.picks });
    await editTg(st.chatId, mid, askSummary(st));
    return;
  }

  if ((m = /^proj:(\d+)$/.exec(data))) {
    const p = lastProjects[Number(m[1])];
    if (!p) { await ctx.answerCallbackQuery({ text: 'expired, /projects again' }).catch(() => {}); return; }
    await ctx.answerCallbackQuery().catch(() => {});
    const kb = new InlineKeyboard();
    kb.text('➕ New session here', `new:${m[1]}`).row();
    for (const s of p.sessions.slice(0, 8)) {
      const named = labelOf(s.id);                                   // our set_title / slug name, if we know it
      const title = named !== s.id ? named : (readMeta(join(PROJECTS_DIR, p.dir, s.id + '.jsonl')).title || s.id.slice(0, 8));
      kb.text(`▶ ${title} · ${ago(s.mtime)}`, `res:${s.id}`).row();
    }
    kb.text('⬅️ Назад', 'back:projects').row();
    await ctx.editMessageText(`📁 ${p.cwd || p.dir}\nStart a new session, or resume one:`, { reply_markup: kb }).catch(() => {});
    return;
  }

  if (data === 'back:projects') {
    await ctx.answerCallbackQuery().catch(() => {});
    const kb = projectsKeyboard();
    await ctx.editMessageText(projectsPrompt(), { reply_markup: kb }).catch(() => {});
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
    await startFromChat(ctx, cwd, { resumeUuid: id }); // startSession enforces liveness/history guards
    return;
  }

  if ((m = /^resume:(.+)$/.exec(data))) {
    const id = m[1];
    const e = registry.get(id);
    if (!e?.cwd) { await ctx.answerCallbackQuery({ text: 'unknown session' }).catch(() => {}); return; }
    if (sessions.has(id) || pendingActivate.has(id)) { await ctx.answerCallbackQuery({ text: 'already running' }).catch(() => {}); return; }
    await ctx.answerCallbackQuery({ text: 'resuming…' }).catch(() => {});
    await startFromChat(ctx, e.cwd, { resumeUuid: id });
    return;
  }

  if ((m = /^new:(\d+)$/.exec(data))) {
    const p = lastProjects[Number(m[1])];
    if (!p?.cwd) { await ctx.answerCallbackQuery({ text: 'open /projects again' }).catch(() => {}); return; }
    await ctx.answerCallbackQuery({ text: 'starting…' }).catch(() => {});
    await startFromChat(ctx, p.cwd);
    return;
  }

  // ✅ under a shared contact → add that person to the access list (owner only, like /allow)
  if ((m = /^allowc:(\d+)$/.exec(data))) {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery({ text: 'только владелец может менять список' }).catch(() => {}); return; }
    const id = m[1], name = contactNames.get(id) || id;
    const added = access.add(id, name, ctx.from.id);
    contactNames.delete(id);
    await ctx.answerCallbackQuery({ text: added ? 'добавлен' : 'уже в списке' }).catch(() => {});
    await ctx.editMessageText(added ? `✅ ${name} (${id}) добавлен — может писать боту в групповых чатах` : `${name} (${id}) уже в списке`).catch(() => {});
    return;
  }

  // ➕ Новый проект → ask for the name; the reply to this prompt goes to newProject().
  if (data === 'newproj') {
    await ctx.answerCallbackQuery().catch(() => {});
    await askProjectName(ctx);
    return;
  }

  // 📁 under "/new: no such project" → create it, on purpose this time
  if (data === 'mkproj') {
    const arg = missingProj.get(here(ctx));
    if (!arg) { await ctx.answerCallbackQuery({ text: 'устарело — /newproject <имя>' }).catch(() => {}); return; }
    missingProj.delete(here(ctx));
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageReplyMarkup().catch(() => {});
    await newProject(ctx, arg);
    return;
  }

  // /new found the name under several roots → the one picked
  if ((m = /^npo:(\d+)$/.exec(data))) {
    const cwd = openPick.get(here(ctx))?.[Number(m[1])];
    if (!cwd) { await ctx.answerCallbackQuery({ text: 'устарело — /new ещё раз' }).catch(() => {}); return; }
    openPick.delete(here(ctx));
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (await startFromChat(ctx, cwd)) await ctx.reply(`➕ starting new session in ${cwd}…`);
    return;
  }

  if ((m = /^npr:(\d+)$/.exec(data))) {
    const root = PROJECT_ROOTS[Number(m[1])], arg = newProjArg.get(here(ctx));
    if (!root || !arg) { await ctx.answerCallbackQuery({ text: 'устарело — /new ещё раз' }).catch(() => {}); return; }
    newProjArg.delete(here(ctx));
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageReplyMarkup().catch(() => {});
    await newProject(ctx, arg, root);
    return;
  }

  await ctx.answerCallbackQuery().catch(() => {});
});

bot.on('message:text', async ctx => {
  if (!owns(ctx)) return;
  const text = ctx.message.text;

  // ⚙ пульт keyboard button -> open the inline command pad for the active stream session
  if (text === '⚙ пульт') {
    const id = activeIn(ctx);
    if (!id || !sessions.has(id)) { await ctx.reply('нет активной сессии'); return; }
    if (!isStream(id)) { await ctx.reply('⚙️ пульт доступен только для stream-сессий (панель VSCode / TG на stream-json)'); return; }
    await ctx.reply(`⚙ пульт · ${labelOf(id)}`, { reply_markup: controlPad(id) });
    return;
  }

  // the answer to a ➕ Новый проект prompt is the project's name
  const rid = ctx.message.reply_to_message?.message_id;
  if (rid && newProjPrompt.get(rid) === here(ctx)) { newProjPrompt.delete(rid); await newProject(ctx, text); return; }

  // reply to a bot message -> its session, WITH the quoted text (the reply may target
  // an old message, so the session needs to see which one).
  const quoted = quotePrefix(ctx);
  if (rid && outMsgToSession.has(rid)) { await routeTo(ctx, outMsgToSession.get(rid), quoted + text); return; }

  // bare button tap from the keyboard -> switch this chat's active session.
  // Caption and lookup MUST come from the same function: the bottom keyboard sends plain
  // text, so a format change on one side without the other silently turns taps into prompts.
  const bare = stripActiveMark(text);
  const swId = order.find(x => labelOf(x) === bare);   // bottom keyboard renders the bare label — match on it
  if (swId) { active.set(here(ctx), swId); await ctx.reply(`▶ active: ${labelOf(swId)}`, { reply_markup: replyKeyboard(here(ctx)) }); return; }

  // /to <label> <text> -> one-off send to a specific session without switching
  // Labels may contain spaces, so take the LONGEST label the rest starts with ("Oligo 2" over "Oligo").
  const mm = /^\/to\s+([\s\S]+)$/.exec(text);
  if (mm) {
    const rest = mm[1];
    const id = order.filter(x => rest.startsWith(labelOf(x) + ' ') || rest.startsWith(labelOf(x) + '\n'))
      .sort((a, b) => labelOf(b).length - labelOf(a).length)[0];
    if (id) await routeTo(ctx, id, rest.slice(labelOf(id).length).trim());
    else await ctx.reply(`no session "${rest.split(/\s/)[0]}" — see /sessions`);
    return;
  }

  const cur = activeIn(ctx);
  // A topic whose session is stopped: bring it back and hand it this message (delivered on register).
  const bound = !cur && boundTo(here(ctx));
  if (bound) {
    pending.put(here(ctx), quoted + text);
    await ctx.reply(`▶ поднимаю ${bound.label}…`);
    if (!await startFromChat(ctx, bound.cwd, { resumeUuid: bound.id })) pending.take(here(ctx));
    return;
  }
  if (!cur) {
    // Don't drop what they wrote: hold it and let them pick a session — the tap delivers it.
    if (!order.length) { await ctx.reply('нет живых сессий — /projects, чтобы поднять'); return; }
    await ctx.reply('в этом чате нет активной сессии — выбери, куда отправить:', { reply_markup: sessionInline(here(ctx)) });
    pending.put(here(ctx), quoted + text);
    return;
  }
  // reply to a non-bot message (yours, someone else's, or a bot msg forgotten after a
  // restart) still carries its quote to the active session.
  await routeTo(ctx, cur, quoted + text);
});

// Any attachment (document/photo/voice/video/…) -> download into the target session's
// .tg-inbox/ and inject a turn pointing at it, so Claude can Read it by relative path.
bot.on(':file', async ctx => {
  if (!owns(ctx)) return;
  const id = targetSession(ctx);
  if (!id || !sessions.has(id)) { await ctx.reply('нет активной сессии — /projects, чтобы поднять'); return; }
  const cwd = sessions.get(id).cwd;

  let file;
  try { file = await ctx.getFile(); }
  catch (e) {
    const msg = e?.description || e?.message || String(e);
    await ctx.reply(/too big/i.test(msg) ? '⚠️ файл больше 20 МБ — Bot API не может его скачать.' : `⚠️ не удалось получить файл: ${msg}`);
    return;
  }
  const name = inboxName(ctx.message).replace(/[\r\n\t]/g, '_');
  const dir = join(cwd, '.tg-inbox'), dest = join(dir, name);
  try {
    mkdirSync(dir, { recursive: true });
    if (isAbsolute(file.file_path)) copyFileSync(file.file_path, dest);   // local Bot API server: file already on disk
    else {
      const res = await fetch(`${API_ROOT}/file/bot${TOKEN}/${file.file_path}`);
      if (!res.ok) throw new Error(`download HTTP ${res.status}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    }
  } catch (e) {
    await ctx.reply(`⚠️ не смог сохранить файл (${humanSize(file.file_size)}): ${e?.message || e}`);
    return;
  }
  const mime = fileMime(ctx.message);
  const info = `[файл: .tg-inbox/${name} (${humanSize(file.file_size)}${mime ? ', ' + mime : ''})]`;
  const cap = String(ctx.message.caption || '').trim();
  await routeTo(ctx, id, quotePrefix(ctx) + info + (cap ? '\n' + cap : ''));
});

bot.catch(err => console.error('[hub] bot error', err?.error));
// Don't let a node-pty/conpty quirk (e.g. AttachConsole on a dead pty) crash the daemon.
process.on('uncaughtException', e => console.error('[hub] uncaught:', e?.message || e));
process.on('unhandledRejection', e => console.error('[hub] unhandledRejection:', e?.message || e));
bot.start({ onStart: i => console.error(`[hub] polling as @${i.username}; owner=${OWNER}; home chat=${CHAT}${CHAT !== OWNER ? ' (group)' : ' (owner DM)'}`) });
