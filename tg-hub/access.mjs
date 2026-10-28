// tg-hub/access.mjs
// Access list: who — besides the owner — may drive the bot from a group chat.
// The owner comes from env (HUB_OWNER_ID) and is NEVER stored here; this file holds
// only the people the owner let in. Format and durability mirror registry.json:
// atomic write (tmp -> fsync -> rename), tolerant read (missing = empty, corrupt =
// backed up and empty), so a broken file degrades to "owner only", never to "open".
import { join, resolve, relative, isAbsolute } from 'node:path';
import { mkdirSync, readFileSync, renameSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';

// The hub's state dir, set by init(): it comes from the hub's config, which is read only
// after this module has been imported.
let DIR = null, FILE = null;
const users = new Map();   // id(string) -> { id, name, role, added, by }

export function init(dir) { DIR = dir; FILE = join(dir, 'access.json'); reload(); }
export function reload() {
  users.clear();
  let raw;
  try { raw = readFileSync(FILE, 'utf8'); }
  catch (e) { if (e?.code !== 'ENOENT') console.error('[access] read failed:', e?.message); return; }
  try {
    for (const [id, u] of Object.entries(JSON.parse(raw).users || {})) users.set(String(id), { ...u, id: String(id) });
  } catch {
    try { renameSync(FILE, FILE + '.corrupt-' + Date.now()); } catch {}
    console.error('[access] access.json corrupt — backed up, starting empty');
  }
}
function save() {
  try {
    mkdirSync(DIR, { recursive: true });
    const data = JSON.stringify({ version: 1, users: Object.fromEntries(users) }, null, 2);
    const tmp = FILE + '.tmp';
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, FILE);
  } catch (e) { console.error('[access] save failed:', e?.message); }
}

export const roleOf = id => users.get(String(id))?.role || null;
export const list = () => [...users.values()];
export function add(id, name, by) {
  const key = String(id || '');
  if (!key || users.has(key)) return false;
  users.set(key, { id: key, name: String(name || key), role: 'owner', added: new Date().toISOString(), by: String(by || '') });
  save();
  return true;
}
export function remove(id) {
  const ok = users.delete(String(id || ''));
  if (ok) save();
  return ok;
}

// The gate. Owner passes anywhere (DM included). Anyone on the list passes in any GROUP
// chat (group or supergroup) but never in a DM, a channel, or an unknown chat type — DMs
// with the bot stay owner-only.
export function canUse({ userId, chatType, isBot }, { owner }) {
  if (isBot) return false;
  if (!owner) return false;
  if (String(userId) === String(owner)) return true;
  return (chatType === 'group' || chatType === 'supergroup') && !!roleOf(userId);
}

// Whom a replied-to message points at: the person in a shared contact, if it's a Telegram
// account (contact.user_id) — the owner sending a contact is not the one to add — else
// the message's author. Shaped like a Telegram User, for parseTarget.
export function personOf(msg) {
  const c = msg?.contact;
  if (c?.user_id) return { id: c.user_id, first_name: [c.first_name, c.last_name].filter(Boolean).join(' ') || String(c.user_id) };
  return msg?.from;
}

// `/allow` target: the quoted message's author if the command was a reply, else the
// "<id> [name]" typed inline. Bot API can't resolve @username -> id, so a bare nick
// is deliberately NOT accepted.
export function parseTarget(arg, replyFrom) {
  if (replyFrom?.id) return { id: String(replyFrom.id), name: String(replyFrom.username || replyFrom.first_name || replyFrom.id) };
  const m = /^(\d+)(?:\s+([\s\S]+))?$/.exec(String(arg || '').trim());
  return m ? { id: m[1], name: (m[2] || m[1]).trim() } : null;
}

// Project roots (HUB_PROJECTS): a cwd is allowed when it is a root or lies inside one; no
// roots = everything. path.relative compares case-insensitively on Windows and yields an
// absolute path across drives, so both are handled by the same test.
export function inRoots(cwd, roots) {
  if (!roots?.length) return true;
  if (!cwd) return false;
  const abs = resolve(cwd);
  return roots.some(root => {
    const r = relative(root, abs);
    return r === '' || (!isAbsolute(r) && r.split(/[\\/]/)[0] !== '..');
  });
}

// What `/new <arg>` and ➕ New project point at. A full path is taken as is (inside the
// roots, if there are any); a bare name or relative path lands in the root. A missing
// folder may be created only inside a root, so a typo in a full path can't litter the
// disk. Returns { cwd, canCreate } | { pickRoot } (a name, several roots) | { error }.
const BAD_CHARS = /[<>:"|?*\x00-\x1f]/;                     // not allowed in a Windows file name
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;  // device names Windows won't create
export function projectPath(arg, roots) {
  const a = String(arg || '').trim().replace(/^["']+|["']+$/g, '');
  if (!a) return { error: 'укажи имя проекта или полный путь' };
  if (isAbsolute(a)) {
    const cwd = resolve(a);
    if (roots?.length && !inRoots(cwd, roots)) return { error: `${cwd} — вне папок этого бота` };
    return { cwd, canCreate: !!roots?.length };
  }
  if (!roots?.length) return { error: 'у этого бота не задан HUB_PROJECTS — укажи полный путь' };
  const bad = a.split(/[\\/]/).find(s => s && s !== '.' && s !== '..' && (BAD_CHARS.test(s) || RESERVED.test(s) || /[. ]$/.test(s)));
  if (bad !== undefined) return { error: `недопустимое имя папки: «${bad}»` };
  // `..` escapes every root alike, so one test serves before the root is even picked
  const cwd = resolve(roots[0], a);
  if (!inRoots(cwd, [roots[0]])) return { error: `${a} выходит за пределы папки проектов` };
  if (roots.length > 1) return { pickRoot: true };
  return { cwd, canCreate: true };
}
