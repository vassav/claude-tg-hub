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

// A refusal must never be silent: the fallback renders the SAME text without tables, so
// from the outside a rejected rich message and a plain one look alike, and the only place
// the reason ever existed was Telegram's `description`. Log it, send nothing of the body.
export async function sendRich({ apiRoot, token, chatId, markdown, extra, fetchImpl, log = console.error }) {
  try {
    const j = await post(apiRoot, token, 'sendRichMessage', richBody({ chatId, markdown, extra }), fetchImpl);
    if (j?.ok && j.result) return j.result;
    log('[rich] rejected:', j?.error_code ?? '?', j?.description || 'ok:true without result', `(${markdown?.length ?? 0} chars)`);
    return null;
  } catch (e) { log('[rich] failed:', e?.message || String(e)); return null; }
}

// ── send_file: local file → chat ────────────────────────────────────────────
// Which Bot API method uploads this file? Telegram renders a photo inline but recompresses
// it and caps dimensions; a document is byte-exact. `as:"auto"` (default) picks sendPhoto for
// common raster images, sendDocument for everything else (PDF, logs, SVG, …). `as:"photo"`/
// `as:"document"` force it — e.g. a PNG sent as a document keeps full quality.
export const PHOTO_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
export const CAPTION_LIMIT = 1024;   // Telegram caption cap (sendPhoto/sendDocument)

export function chooseFileMethod(path, as = 'auto') {
  if (as === 'photo') return 'sendPhoto';
  if (as === 'document') return 'sendDocument';
  const name = String(path || '');
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  return PHOTO_EXT.has(ext) ? 'sendPhoto' : 'sendDocument';
}

// The live "Thinking…" draft used to live here (sendRichMessageDraft + its text builder).
// Dropped on request: a bubble repainting itself in the DM every 10 seconds was more
// irritating than useful. What a session is doing now shows in /sessions instead, as ⚡ with
// the elapsed time and the turn's tokens. Git history has the draft code if it's ever wanted.
