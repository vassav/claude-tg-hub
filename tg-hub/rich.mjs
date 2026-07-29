// tg-hub/rich.mjs
// Bot API 10.1 Rich Messages. The model already writes Markdown, and Telegram parses it
// natively — tables, headings, fenced code with syntax highlighting — so there is no
// converter here: the reply text goes out untouched. grammY doesn't know the method, so we
// POST it ourselves (hub.mjs already fetches Bot API directly for file downloads).
// Every failure returns null/false: rich is an attempt layered over the working sendTg path.

export const RICH_LIMIT = 32768;   // chars per rich message (sendMessage allows 4096)

// extra (reply_parameters, reply_markup) sits NEXT TO rich_message, not inside it.
export function richBody({ chatId, markdown, extra = {} }) {
  return { chat_id: chatId, rich_message: { markdown }, ...extra };
}

async function post(apiRoot, token, method, body, fetchImpl) {
  const f = fetchImpl || fetch;
  const res = await f(`${apiRoot}/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}

export async function sendRich({ apiRoot, token, chatId, markdown, extra, fetchImpl }) {
  try {
    const j = await post(apiRoot, token, 'sendRichMessage', richBody({ chatId, markdown, extra }), fetchImpl);
    return j?.ok && j.result ? j.result : null;
  } catch { return null; }
}

// The thinking bubble is a DRAFT: ephemeral, 30s, private chats only, animated between
// updates that share a draft_id. It returns True, not a Message — nothing to track.
export async function sendThinking({ apiRoot, token, chatId, draftId, text, fetchImpl }) {
  try {
    const body = { chat_id: chatId, draft_id: draftId, rich_message: { markdown: `<tg-thinking>${text}</tg-thinking>` } };
    const j = await post(apiRoot, token, 'sendRichMessageDraft', body, fetchImpl);
    return !!j?.ok;
  } catch { return false; }
}

const fmtTokens = n => (n < 1000 ? String(n) : (n / 1000).toFixed(1) + 'k');
const fmtSecs = s => (s < 100 ? `${s} с` : `${Math.floor(s / 60)} м ${s % 60} с`);
// "Thinking… · 1.8k tokens · 23 с" — tokens only when we know them (channels sessions don't
// report usage), elapsed time always.
export function thinkingText({ startedAt, tokens, now }) {
  const secs = Math.max(0, Math.floor(((now ?? Date.now()) - startedAt) / 1000));
  return ['Thinking…', tokens ? `${fmtTokens(tokens)} tokens` : null, fmtSecs(secs)].filter(Boolean).join(' · ');
}
