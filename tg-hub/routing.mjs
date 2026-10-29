// tg-hub/routing.mjs
// Where a chat's plain text goes, and how a session looks on a button.
// The hub used to keep ONE global `active` pointer, so switching in the group also
// switched the DM. Here each chat owns its own pointer.
import { basename } from 'node:path';

export const PENDING_TTL_MS = 600000;   // 10 min: a tap an hour later must not deliver a forgotten line

const key = chatId => String(chatId ?? '');

// chatId -> sessionId. One pointer per chat, nothing global.
export function createActive() {
  const m = new Map();
  return {
    get: chatId => m.get(key(chatId)) ?? null,
    set: (chatId, sessionId) => { m.set(key(chatId), sessionId); },
    // A dead session must stop being "active" everywhere at once — and must NOT be
    // replaced by a guess, or the next message would land in a random session.
    clearSession(sessionId) { for (const [c, s] of m) if (s === sessionId) m.delete(c); },
    drop(chatId) { m.delete(key(chatId)); },   // a place that is gone (a deleted forum topic)
    chatsFor(sessionId) { return [...m].filter(([, s]) => s === sessionId).map(([c]) => c); },
  };
}

// Text written into a chat that has no active session yet. Held until the person picks
// a session, then delivered — so the message is neither lost nor guessed at.
export function createPending(ttlMs = PENDING_TTL_MS) {
  const m = new Map();
  return {
    put(chatId, text, now = Date.now()) { m.set(key(chatId), { text, ts: now }); },  // a second line REPLACES the first
    take(chatId, now = Date.now()) {
      const k = key(chatId), e = m.get(k);
      if (!e) return null;
      m.delete(k);
      return now - e.ts > ttlMs ? null : e.text;
    },
  };
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Caption for an INLINE button: the session name and nothing else. A button clips its
// caption to the button's width with no ellipsis of its own, and a newline inside it is
// collapsed to a space (checked on a real client), so the project cannot live here — it
// goes into the message text above, where width is not a constraint.
export const buttonLabel = label => cut(String(label ?? '').trim(), 18);

// Project name for a session: the last path segment of its cwd.
export const projectOf = cwd => (cwd ? basename(String(cwd).replace(/[\\/]+$/, '')).trim() : '') || '?';

// Group sessions by project for the /sessions listing, preserving the order projects are
// first seen so the list does not reshuffle between calls.
export function groupSessions(list) {
  const out = [];
  const at = new Map();
  for (const s of list || []) {
    const project = projectOf(s.cwd);
    let g = at.get(project);
    if (!g) { g = { project, items: [] }; at.set(project, g); out.push(g); }
    g.items.push(s);
  }
  return out;
}
export const stripActiveMark = text => String(text ?? '').replace(/\s*✓\s*$/, '').trim();

// ── what a session is doing right now ────────────────────────────────────────
// 'work' — a turn is running (input delivered, or the model is still emitting),
// 'perm' — stopped on a tool approval and waiting for a human,
// 'idle' — connected and silent.
// A turn with no signal for longer than WORK_TTL_MS is treated as over: a session can
// die without a word, and a permanent "⚡ working" would be a lie no one can clear.
export const WORK_TTL_MS = 600000;   // 10 min
export function sessionState({ since, awaitingPerm, now = Date.now(), ttlMs = WORK_TTL_MS } = {}) {
  if (awaitingPerm) return 'perm';                       // waiting on a human outranks working
  return since && now - since < ttlMs ? 'work' : 'idle';
}
export const stateMark = state => (state === 'work' ? '⚡' : state === 'perm' ? '🔐' : '');
// "42 с" / "3 м 07 с" — how long the current turn has been running.
export function fmtDur(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000));
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} м ${String(s % 60).padStart(2, '0')} с`;
}
// "820" / "3.4k" — output tokens of the running turn. Only stream sessions report usage;
// a channels one never does, so the caller must be ready for zero.
export const fmtTokens = n => {
  const v = Math.max(0, Math.floor(Number(n) || 0));   // undefined/NaN → 0, never "NaNk"
  return v < 1000 ? String(v) : (v / 1000).toFixed(1) + 'k';
};
