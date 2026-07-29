// tg-hub/chat-target-test.mjs
// Unit test for chat-target.mjs — pure functions, no I/O.
// Run from repo root:  node tg-hub/chat-target-test.mjs
import assert from 'node:assert/strict';
import { isGroup, replyExtra, askChatFor } from './chat-target.mjs';

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

console.log(`\n✅ chat-target-test: ${n} групп проверок пройдено`);
