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
// Button caption AND the key we match a tap against — the bottom keyboard sends plain
// text, so caption and lookup must come from this one function or taps silently break.
export function sessionButton({ label, cwd }) {
  const proj = cwd ? basename(String(cwd).replace(/[\\/]+$/, '')) : '';
  const name = cut(String(label ?? ''), 22);
  return proj ? `${cut(proj, 14)} · ${name}` : name;
}
export const stripActiveMark = text => String(text ?? '').replace(/\s*✓\s*$/, '').trim();
