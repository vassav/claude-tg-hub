// tg-hub/chat-target-test.mjs
// Unit test for chat-target.mjs — pure functions, no I/O.
// Run from repo root:  node tg-hub/chat-target-test.mjs
import assert from 'node:assert/strict';
import { isGroup, replyExtra, askChatFor, nextInbound } from './chat-target.mjs';

let n = 0; const ok = m => { n++; console.log('  ✓', m); };

assert.equal(isGroup('-1002369988429'), true);
assert.equal(isGroup(-1002369988429), true);
assert.equal(isGroup('300447655'), false);
assert.equal(isGroup(undefined), false);
assert.equal(isGroup(''), false);
ok('isGroup: отрицательный id = группа, положительный = личка');

const last = { chat_id: '-100123', message_id: '77', user: 'ivan' };
assert.deepEqual(replyExtra(last, '-100123'), { reply_parameters: { message_id: 77, allow_sending_without_reply: true } });
assert.deepEqual(replyExtra(last, '-100999'), {}, 'ответ уходит в другую группу — не цитируем');
assert.deepEqual(replyExtra(last, '300447655'), {}, 'ответ уходит в личку — не цитируем');
assert.deepEqual(replyExtra(undefined, '-100123'), {}, 'нет lastInbound');
assert.deepEqual(replyExtra({ chat_id: '-100123' }, '-100123'), {}, 'нет message_id');
ok('replyExtra: цитируем только в своей группе, message_id числом');

assert.equal(askChatFor(last, '300447655'), '-100123');
assert.equal(askChatFor(undefined, '300447655'), '300447655');
assert.equal(askChatFor({ chat_id: '' }, '300447655'), '300447655');
ok('askChatFor: чат-источник, иначе домашний');

const mA = { chat_id: '-100123', message_id: '1', user: 'alice', user_id: '1' };
const mB = { chat_id: '-100123', message_id: '2', user: 'bob', user_id: '2' };
const mA2 = { chat_id: '-100123', message_id: '3', user: 'alice', user_id: '1' };

// no prior entry → not ambiguous
const e1 = nextInbound(undefined, mA);
assert.equal(e1.ambiguous, false, 'нет предыдущей записи — не спорно');
assert.equal(e1.pending, true);

// same user writes again while pending → not ambiguous
const e2 = nextInbound(e1, mA2);
assert.equal(e2.ambiguous, false, 'тот же автор пишет повторно, пока не отвечено — не спорно');

// a DIFFERENT user writes in the SAME chat while pending → ambiguous
const e3 = nextInbound(e1, mB);
assert.equal(e3.ambiguous, true, 'другой автор пишет в том же чате, пока не отвечено — спорно');

// a DIFFERENT user writes in a DIFFERENT chat while pending → not ambiguous (contest is per-chat)
const mD = { chat_id: '-100999', message_id: '9', user: 'dave', user_id: '4' };
const e3b = nextInbound(e1, mD);
assert.equal(e3b.ambiguous, false, 'другой автор пишет в ДРУГОМ чате, пока не отвечено — не спорно');

// a different user writes when the prior entry is NOT pending (already answered) → not ambiguous
const answered = { ...e1, pending: false };
const e4 = nextInbound(answered, mB);
assert.equal(e4.ambiguous, false, 'предыдущий вопрос уже отвечен — новый автор не спорен');

// ambiguity persists across a third message while still pending
const mA3 = { chat_id: '-100123', message_id: '4', user: 'alice', user_id: '1' };
const e5 = nextInbound(e3, mA3); // e3 is ambiguous & still pending
assert.equal(e5.ambiguous, true, 'спорность сохраняется, пока не отвечено, даже если снова пишет alice');

// returned entry always carries chat_id/message_id/user/user_id from meta
assert.deepEqual(
  { chat_id: e3.chat_id, message_id: e3.message_id, user: e3.user, user_id: e3.user_id },
  { chat_id: mB.chat_id, message_id: mB.message_id, user: mB.user, user_id: mB.user_id },
  'возвращённая запись всегда несёт chat_id/message_id/user/user_id из meta',
);
ok('nextInbound: спорность при конкурирующих авторах, пока не отвечено');

console.log(`\n✅ chat-target-test: ${n} групп проверок пройдено`);
