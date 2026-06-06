// Hub daemon: owns ONE Telegram bot and routes it to N Claude sessions.
// Sessions connect via their channel-shim over local TCP.
//
// Live sessions:
//   • reply (quote) to a [sN] message → that session   • tap s1/s2 keyboard → active
//   • /sessions → inline pick active                   • /sN <text> → one-off   • plain → active
// History / resume:
//   • /projects → browse past sessions grouped by project (cwd) → ▶ Resume any
//     (spawns `claude --resume <id> --channels server:hub` in that cwd → live session)
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
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
if (!TOKEN) { console.error('HUB_BOT_TOKEN missing in .env'); process.exit(1); }
if (!OWNER) { console.error('HUB_OWNER_ID missing in .env'); process.exit(1); }

// Discovery: write hub address+token so plugin-launched shims (no env) can find us.
try {
  const cfgDir = join(homedir(), '.claude', 'channels', 'hub');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'hub.json'), JSON.stringify({ port: PORT, token: IPC_TOKEN }));
} catch (e) { console.error('[hub] discovery config write failed:', e?.message); }

const bot = new Bot(TOKEN);
const sessions = new Map();    // sessionId -> { conn, cwd, label }
const order = [];
const pendingPerm = new Map(); // request_id -> sessionId
const outMsgToSession = new Map();
let active = null;
const pendingActivate = new Set(); // hub-labels to make active as soon as they register (resume flow)

// history browse state (snapshot for callback buttons)
let lastProjects = [];         // [{ dir, cwd, sessions:[{id,mtime,title?}], latest }]
const idToDir = new Map();     // session id -> projects dir

const labelOf = id => sessions.get(id)?.label || id;
// Informative, unique label derived from the project folder (cwd basename).
function makeLabel(cwd) {
  let base = (cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || 'session';
  base = base.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 18) || 'session';
  const used = new Set([...sessions.values()].map(s => s.label));
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
  return k;
}
async function routeTo(ctx, id, body) {
  const meta = {
    chat_id: String(ctx.chat.id), message_id: String(ctx.message.message_id),
    user: ctx.from.username || String(ctx.from.id), user_id: String(ctx.from.id), ts: new Date().toISOString(),
  };
  if (!sendToSession(id, { t: 'inbound', content: body, meta })) await ctx.reply('⚠️ session not connected');
}

// Spawn a session (resume an old conversation if resumeId, else fresh) in cwd.
// It registers shortly and becomes active (pendingActivate). Returns ok.
function startSession(cwd, resumeId) {
  const rid = (resumeId ? 'r-' : 'n-') + Date.now().toString(36).slice(-5);
  pendingActivate.add(rid);
  try {
    spawnSession({ id: rid, cwd, resumeId, shimPath: SHIM, tmpDir: TMP, hubPort: PORT, hubToken: IPC_TOKEN });
    notify(resumeId
      ? `▶ resuming ${resumeId.slice(0, 8)}… in ${cwd}\nit'll appear and become active (⚠ don't resume one still live).`
      : `➕ new session in ${cwd}\nit'll appear and become active shortly.`);
    return true;
  } catch (e) { pendingActivate.delete(rid); notify(`start failed: ${e?.message}`); return false; }
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
        const label = makeLabel(m.cwd);
        sessions.set(sid, { conn: sock, cwd: m.cwd, label });
        order.push(sid);
        if (pendingActivate.has(sid)) { active = sid; pendingActivate.delete(sid); }
        else if (!active) active = sid;
        console.error(`[hub] session registered: ${label} = ${sid} (cwd ${m.cwd})`);
        notify(`✅ ${label} registered\ncwd: ${m.cwd}\nactive: ${labelOf(active)}`, { reply_markup: replyKeyboard() });
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
    const label = labelOf(sid);
    sessions.delete(sid);
    const i = order.indexOf(sid); if (i >= 0) order.splice(i, 1);
    if (active === sid) active = order[order.length - 1] || null;
    notify(`⚠️ ${label} disconnected`, { reply_markup: replyKeyboard() });
  });
  sock.on('error', () => {});
}).listen(PORT, '127.0.0.1', () => console.error(`[hub] IPC on 127.0.0.1:${PORT}`));

// ── Telegram ─────────────────────────────────────────────────────────────────
const owns = ctx => String(ctx.from?.id) === OWNER;

bot.command('start', async ctx => { if (!owns(ctx)) return; await ctx.reply('Hub ready. /sessions = live · /projects = history+resume', { reply_markup: replyKeyboard() }); });

bot.command('sessions', async ctx => {
  if (!owns(ctx)) return;
  if (!order.length) { await ctx.reply('no live sessions. /projects to resume an old one.', { reply_markup: replyKeyboard() }); return; }
  const list = order.map(id => `${id === active ? '● ' : '○ '}${labelOf(id)} — ${sessions.get(id).cwd}`).join('\n');
  await ctx.reply(list, { reply_markup: sessionInline() });
  await ctx.reply('switch ↓ or reply to a session\'s message', { reply_markup: replyKeyboard() });
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
    if (sessions.has(id)) { sendToSession(id, { t: 'stop' }); await ctx.answerCallbackQuery({ text: `stopping ${labelOf(id)}` }).catch(() => {}); }
    else await ctx.answerCallbackQuery({ text: 'already gone' }).catch(() => {});
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
    await ctx.answerCallbackQuery({ text: 'resuming…' }).catch(() => {});
    startSession(cwd, id);
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
