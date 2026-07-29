// tg-hub/access.mjs
// Access list: who — besides the owner — may drive the bot from a group chat.
// The owner comes from env (HUB_OWNER_ID) and is NEVER stored here; this file holds
// only the people the owner let in. Format and durability mirror registry.json:
// atomic write (tmp -> fsync -> rename), tolerant read (missing = empty, corrupt =
// backed up and empty), so a broken file degrades to "owner only", never to "open".
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';

const DIR = join(homedir(), '.claude', 'channels', 'hub');
const FILE = join(DIR, 'access.json');
const users = new Map();   // id(string) -> { id, name, role, added, by }

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

// The gate. Owner passes anywhere (DM included). Anyone on the list passes in ANY
// group chat but never in a DM — DMs with the bot stay owner-only.
export function canUse({ userId, chatType, isBot }, { owner }) {
  if (isBot) return false;
  if (String(userId) === String(owner)) return true;
  return chatType !== 'private' && !!roleOf(userId);
}

// `/allow` target: the quoted message's author if the command was a reply, else the
// "<id> [name]" typed inline. Bot API can't resolve @username -> id, so a bare nick
// is deliberately NOT accepted.
export function parseTarget(arg, replyFrom) {
  if (replyFrom?.id) return { id: String(replyFrom.id), name: String(replyFrom.username || replyFrom.first_name || replyFrom.id) };
  const m = /^(\d+)(?:\s+([\s\S]+))?$/.exec(String(arg || '').trim());
  return m ? { id: m[1], name: (m[2] || m[1]).trim() } : null;
}

reload();
