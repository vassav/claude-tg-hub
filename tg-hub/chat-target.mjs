// tg-hub/chat-target.mjs
// Where a session's output lands and how it gets attributed. Pure functions over the
// hub's `lastInbound` record ({ chat_id, message_id, user, user_id, pending, ambiguous })
// — see hub.mjs routeTo(). Group/supergroup chat ids are NEGATIVE; a private chat's id is
// the user's own id.

export const isGroup = chatId => String(chatId ?? '').startsWith('-');

// Quote the message that asked, so two people talking in one group can tell whose
// answer is whose. Also works in private chats to point back at the original question.
export function replyExtra(last, chatId) {
  // Quote the message that asked, in ANY chat — group or DM. Two conditions remain: we
  // must know which message it was, and the answer must be going back to the very chat the
  // question came from (a session can be driven from several chats).
  if (!last?.message_id) return {};
  if (String(last.chat_id) !== String(chatId)) return {};
  return { reply_parameters: { message_id: Number(last.message_id), allow_sending_without_reply: true } };
}

// An AskUserQuestion card belongs in the chat that asked; fall back to the home chat
// (a session started from the panel or by an external `start` has no inbound yet).
export const askChatFor = (last, homeChat) => last?.chat_id || homeChat;

// Attribution state for a session's next answer. `pending` means the recorded message
// hasn't been answered yet; a SECOND person writing in the SAME chat while one is pending
// makes the next answer's owner unknowable, so we mark it ambiguous and later quote nobody
// rather than point at the wrong person. Ambiguity survives until a fresh, uncontested
// message arrives. This only catches a racer who arrives before ANY part of the answer:
// sessions emit one t:'reply' per assistant text block, so `pending` clears on the FIRST
// block of a multi-block answer, and a racer arriving after that block goes uncaught.
export function nextInbound(prev, meta) {
  const sameChat = !!prev && String(prev.chat_id) === String(meta.chat_id);
  const contested = !!prev?.pending && sameChat && (prev.ambiguous || String(prev.user_id) !== String(meta.user_id));
  return { chat_id: meta.chat_id, message_id: meta.message_id, user: meta.user, user_id: meta.user_id, pending: true, ambiguous: contested };
}
