// tg-hub/rich-test.mjs
// Unit test for rich.mjs — no network: every case injects a fake fetch.
// Run from repo root:  node tg-hub/rich-test.mjs
import assert from 'node:assert/strict';
import { richBody, sendRich, sendThinking, thinkingText, RICH_LIMIT } from './rich.mjs';

let n = 0; const ok = m => { n++; console.log('  ✓', m); };

// 1. richBody
assert.deepEqual(richBody({ chatId: '123', markdown: '# hi' }),
  { chat_id: '123', rich_message: { markdown: '# hi' } });
assert.deepEqual(
  richBody({ chatId: -100123, markdown: 'x', extra: { reply_parameters: { message_id: 7 }, reply_markup: { inline_keyboard: [] } } }),
  { chat_id: -100123, rich_message: { markdown: 'x' }, reply_parameters: { message_id: 7 }, reply_markup: { inline_keyboard: [] } });
assert.equal(RICH_LIMIT, 32768);
ok('richBody: chat_id + markdown, extra прокидывается рядом, а не внутрь rich_message');

// 2. sendRich — успех
const calls = [];
const fakeOk = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { json: async () => ({ ok: true, result: { message_id: 42 } }) }; };
const sent = await sendRich({ apiRoot: 'https://api.telegram.org', token: 'T', chatId: '123', markdown: '# hi', fetchImpl: fakeOk });
assert.deepEqual(sent, { message_id: 42 });
assert.equal(calls[0].url, 'https://api.telegram.org/botT/sendRichMessage');
assert.equal(calls[0].body.rich_message.markdown, '# hi');
ok('sendRich: зовёт sendRichMessage и возвращает Message');

// 3. sendRich — все виды отказа дают null, ничего не бросая
const fakeFalse = async () => ({ json: async () => ({ ok: false, description: 'Bad Request: nope' }) });
const fakeThrow = async () => { throw new Error('socket hang up'); };
const fakeGarbage = async () => ({ json: async () => { throw new Error('not json'); } });
const fakeNoResult = async () => ({ json: async () => ({ ok: true }) });
for (const [label, f] of [['ok:false', fakeFalse], ['исключение сети', fakeThrow], ['нечитаемый ответ', fakeGarbage], ['ok:true без result', fakeNoResult]]) {
  const r = await sendRich({ apiRoot: 'x', token: 'T', chatId: '1', markdown: 'y', fetchImpl: f });
  assert.equal(r, null, label);
}
ok('sendRich: ok:false / бросок / мусор / ok:true без result → null, без исключения наружу');

// 4. sendThinking
const draftCalls = [];
const fakeDraft = async (url, init) => { draftCalls.push({ url, body: JSON.parse(init.body) }); return { json: async () => ({ ok: true, result: true }) }; };
assert.equal(await sendThinking({ apiRoot: 'https://api.telegram.org', token: 'T', chatId: 300, draftId: 5, text: 'Thinking… · 3 с', fetchImpl: fakeDraft }), true);
assert.equal(draftCalls[0].url, 'https://api.telegram.org/botT/sendRichMessageDraft');
assert.equal(draftCalls[0].body.chat_id, 300);
assert.equal(draftCalls[0].body.draft_id, 5);
assert.equal(draftCalls[0].body.rich_message.markdown, '<tg-thinking>Thinking… · 3 с</tg-thinking>');
assert.equal(await sendThinking({ apiRoot: 'x', token: 'T', chatId: 1, draftId: 1, text: 'z', fetchImpl: fakeThrow }), false);
ok('sendThinking: оборачивает текст в <tg-thinking>, отказ → false');

// 5. thinkingText
const t0 = 1000000;
assert.equal(thinkingText({ startedAt: t0, now: t0 + 3000 }), 'Thinking… · 3 с');
assert.equal(thinkingText({ startedAt: t0, now: t0 + 3000, tokens: 0 }), 'Thinking… · 3 с');
assert.equal(thinkingText({ startedAt: t0, now: t0 + 23000, tokens: 1800 }), 'Thinking… · 1.8k tokens · 23 с');
assert.equal(thinkingText({ startedAt: t0, now: t0 + 23000, tokens: 999 }), 'Thinking… · 999 tokens · 23 с');
assert.equal(thinkingText({ startedAt: t0, now: t0 + 23000, tokens: 1000 }), 'Thinking… · 1.0k tokens · 23 с');
assert.equal(thinkingText({ startedAt: t0, now: t0 + 99000 }), 'Thinking… · 99 с');
assert.equal(thinkingText({ startedAt: t0, now: t0 + 100000 }), 'Thinking… · 1 м 40 с');
assert.equal(thinkingText({ startedAt: t0, now: t0 + 605000 }), 'Thinking… · 10 м 5 с');
assert.equal(thinkingText({ startedAt: t0, now: t0 }), 'Thinking… · 0 с');
ok('thinkingText: секунды, минуты, форматирование токенов, отсутствие токенов');

console.log(`\n✅ rich-test: ${n} групп проверок пройдено`);
