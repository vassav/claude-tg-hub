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
