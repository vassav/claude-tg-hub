// tg-hub/chat-target.mjs
// Where a session's output lands and how it gets attributed. Pure functions over the
// hub's `lastInbound` record ({ chat_id, message_id, user, user_id, pending, ambiguous })
// — see hub.mjs routeTo(). Group/supergroup chat ids are NEGATIVE; a private chat's id is
// the user's own id.

export const isGroup = chatId => String(chatId ?? '').startsWith('-');

// A "place" is where a conversation lives: a chat, or a topic of a forum group —
// "<chat_id>" or "<chat_id>:<thread_id>". It is what the hub keys a chat's active session
// by, and what sessions get as chat_id and hand back unchanged in reply/send_file/commands,
// so the topic survives the round trip. Only the calls into Telegram split it (splitPlace).
// is_topic_message, not just message_thread_id: an ordinary group sets the latter on any
// reply thread, and the General topic of a forum has no thread to address at all.
export const placeOf = (chat, msg) =>
  msg?.is_topic_message && msg.message_thread_id ? `${chat.id}:${msg.message_thread_id}` : String(chat?.id ?? '');
export function splitPlace(place) {
  const m = /^(-?\d+):(\d+)$/.exec(String(place ?? ''));
  return m ? { chat: m[1], thread: { message_thread_id: Number(m[2]) } } : { chat: String(place ?? ''), thread: {} };
}
export const isTopicPlace = place => /^-?\d+:\d+$/.test(String(place ?? ''));
// t.me link that opens a topic: supergroup ids are -100<id>, links use the bare <id>.
export function topicLink(place) {
  const m = /^-100(\d+):(\d+)$/.exec(String(place ?? ''));
  return m ? `https://t.me/c/${m[1]}/${m[2]}` : '';
}
// Telegram's answers to a message aimed at a topic that is gone (deleted) — then the hub
// unbinds the topic and says it in General. A CLOSED topic is not gone: it says TOPIC_CLOSED.
export const isTopicGoneError = desc => /thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/i.test(String(desc ?? ''));

// Quote the message that asked, so two people talking in one GROUP can tell whose answer
// is whose. Deliberately not done in a private chat: there is only one asker, the quote
// carries no information, and it stacks a second quote block on top of the session header.
export function replyExtra(last, chatId) {
  if (!last?.message_id || !isGroup(chatId)) return {};
  // A session can be driven from several chats — quote only when the answer goes back to
  // the very chat the question came from.
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
