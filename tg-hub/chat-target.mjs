// tg-hub/chat-target.mjs
// Where a session's output lands and how it gets attributed. Pure functions over the
// hub's `lastInbound` record ({ chat_id, message_id, user }) — see hub.mjs routeTo().
// Group/supergroup chat ids are NEGATIVE; a private chat's id is the user's own id.

export const isGroup = chatId => String(chatId ?? '').startsWith('-');

// Quote the message that asked, so two people talking in one group can tell whose
// answer is whose. Only in a group, and only when the answer goes back to the very
// chat the question came from. allow_sending_without_reply keeps the message from
// failing if the original was deleted meanwhile.
export function replyExtra(last, chatId) {
  if (!last?.message_id || !isGroup(chatId)) return {};
  if (String(last.chat_id) !== String(chatId)) return {};
  return { reply_parameters: { message_id: Number(last.message_id), allow_sending_without_reply: true } };
}

// An AskUserQuestion card belongs in the chat that asked; fall back to the home chat
// (a session started from the panel or by an external `start` has no inbound yet).
export const askChatFor = (last, homeChat) => last?.chat_id || homeChat;

// Attribution state for a session's next answer. `pending` means the recorded message
// hasn't been answered yet; a SECOND person writing while one is pending makes the next
// answer's owner unknowable, so we mark it ambiguous and later quote nobody rather than
// point at the wrong person. Ambiguity survives until a fresh, uncontested message arrives.
export function nextInbound(prev, meta) {
  const contested = !!prev?.pending && (prev.ambiguous || String(prev.user_id) !== String(meta.user_id));
  return { chat_id: meta.chat_id, message_id: meta.message_id, user: meta.user, user_id: meta.user_id, pending: true, ambiguous: contested };
}
