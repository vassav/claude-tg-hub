// tg-hub/rich-test.mjs
// Unit test for rich.mjs — no network: every case injects a fake fetch.
// Run from repo root:  node tg-hub/rich-test.mjs
import assert from 'node:assert/strict';
import { richBody, sendRich, RICH_LIMIT, chooseFileMethod, PHOTO_EXT, CAPTION_LIMIT } from './rich.mjs';
import * as richModule from './rich.mjs';

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
const logged = [];
const log = (...a) => logged.push(a.join(' '));
for (const [label, f] of [['ok:false', fakeFalse], ['исключение сети', fakeThrow], ['нечитаемый ответ', fakeGarbage], ['ok:true без result', fakeNoResult]]) {
  const r = await sendRich({ apiRoot: 'x', token: 'T', chatId: '1', markdown: 'y', fetchImpl: f, log });
  assert.equal(r, null, label);
}
ok('sendRich: ok:false / бросок / мусор / ok:true без result → null, без исключения наружу');

// 3b. каждый отказ ОБЪЯСНЁН в логе — иначе фоллбек молча отдаёт тот же текст без таблиц
assert.equal(logged.length, 4, 'все четыре отказа записаны');
assert.ok(logged[0].includes('Bad Request: nope'), 'описание от Telegram попадает в лог');
assert.ok(logged[1].includes('socket hang up'), 'сетевой бросок объяснён');
assert.ok(logged[3].includes('ok:true without result'), 'ответ без result назван своими словами');
assert.ok(!logged.some(l => l.includes('markdown')), 'тело сообщения в лог не утекает');
ok('sendRich: причина отказа уходит в лог, тело — нет');

// 4. драфт «Thinking…» убран из хаба — модуль больше не должен его предлагать
assert.equal(typeof richModule.sendThinking, 'undefined', 'sendThinking удалён вместе с пузырём');
assert.equal(typeof richModule.thinkingText, 'undefined', 'и его текст тоже');
ok('rich.mjs: пузыря Thinking… больше нет');

// 5. chooseFileMethod — авто-выбор по расширению + форс
assert.equal(chooseFileMethod('/tmp/shot.png'), 'sendPhoto');
assert.equal(chooseFileMethod('C:\\x\\PHOTO.JPG'), 'sendPhoto', 'регистр расширения не важен');
assert.equal(chooseFileMethod('/tmp/a.jpeg'), 'sendPhoto');
assert.equal(chooseFileMethod('/tmp/report.pdf'), 'sendDocument');
assert.equal(chooseFileMethod('/tmp/run.log'), 'sendDocument');
assert.equal(chooseFileMethod('/tmp/diagram.svg'), 'sendDocument', 'svg — документ: Telegram не покажет его как фото');
assert.equal(chooseFileMethod('/tmp/noext'), 'sendDocument', 'без расширения → документ');
assert.equal(chooseFileMethod('/tmp/shot.png', 'document'), 'sendDocument', 'as:document форсирует документ (без пережатия)');
assert.equal(chooseFileMethod('/tmp/report.pdf', 'photo'), 'sendPhoto', 'as:photo форсирует фото');
assert.ok(PHOTO_EXT.has('.webp') && CAPTION_LIMIT === 1024);
ok('chooseFileMethod: .png/.jpg/… → sendPhoto, прочее → sendDocument, as форсирует');

console.log(`\n✅ rich-test: ${n} групп проверок пройдено`);
