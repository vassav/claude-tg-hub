# Rich Messages: нативный рендер ответов + пузырь `<tg-thinking>` — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ответы сессий уходят в Telegram как Rich Messages (нативные таблицы, заголовки, подсвеченный код), а пока сессия работает, в личке висит живой пузырь `Thinking… · 1.8k tokens · 23 с`.

**Architecture:** Новый модуль `tg-hub/rich.mjs` с чистыми функциями и одним сетевым вызовом через `fetch` (grammY метода `sendRichMessage` не знает, но прямой `fetch` к Bot API в проекте уже используется). В `hub.mjs` появляется `sendMd` — «попробуй rich, не вышло → существующий `sendTg`», карта `thinking` с таймерами и приём нового IPC-сообщения `{t:'status'}`. Markdown-парсер не пишем: текст модели отдаётся Telegram как есть. Спека: [docs/specs/2026-07-29-rich-messages.md](../specs/2026-07-29-rich-messages.md).

**Tech Stack:** Node.js `.mjs`, zero-build, grammY 1.43 (для rich не используется), тесты — обычные node-скрипты на `node:assert/strict`.

## Global Constraints

- **НЕ коммитить без явного запроса пользователя** (правило проекта из `CLAUDE.md`). Шаги «Commit» выполнять, только если пользователь это разрешил для текущей ветки; иначе показать `git status`/`git diff` и ждать.
- Новых зависимостей нет. Новых переменных окружения нет.
- Стиль: компактный `.mjs` как в `hub.mjs`, комментарии по-английски, тексты в Telegram по-русски. Исключение: строка пузыря — `Thinking… · 1.8k tokens · 23 с`, слово `tokens` по-английски, так пользователь и просил.
- `mdToTgHtml` и `sendTg` **не трогаем**: rich — это попытка поверх работающего пути, а не замена. Любой отказ rich обязан приводить к сегодняшнему поведению.
- Rich применяется **только** к ответам сессий (ветка `t:'reply'`). Карточки аппрувов, ask-карточки, `notify` и служебные сообщения хаба остаются на `sendTg`.
- Лимиты Telegram: 32768 символов, 500 блоков, 16 уровней вложенности, 50 медиа, 20 колонок.
- Драфты работают **только в приватном чате**; в группе пузыря нет (в группу шлём ответ, но не пузырь).
- Номера строк в задачах указаны по состоянию `main` на коммит `e7a8260` (ветка работы — `feat/rich-messages`). Место правки ищи по приведённому фрагменту кода, а не по номеру.
- **РАБОТАЮЩЕГО БОТА НЕ ТРОГАТЬ.** Прямое требование владельца. На машине крутится боевой демон `hub.mjs` с живыми сессиями. Запрещено: убивать и перезапускать его любым способом, слать что-либо в Telegram, дёргать Bot API боевым токеном, править `.env`. Правки на диске работающему процессу не мешают — он держит свой код в памяти и подхватит новый только при перезапуске, которого не будет.
- Из этого следует: **проверка каждой задачи — только статическая.** `node --check`, юнит-тесты с подменённым `fetch`, грепы. Везде, где по смыслу просится «перезапусти и посмотри в Telegram», задача заканчивается статической проверкой, а живая откладывается до отдельного захода, который проведёт владелец. Не выдумывай результат живой проверки и не подменяй его рассуждением — пиши в отчёте, что она отложена.
- Осторожно с новыми сессиями: демон спавнит их из файлов на диске (`shim.mjs`, `panel/headless.mjs`), поэтому недописанный файл может достаться свежей сессии. Правки в `panel/` (задача 4) делай одним заходом, не оставляя файл в промежуточном состоянии.

---

### Task 1: `rich.mjs` — отправка rich-сообщения и текст пузыря

**Files:**
- Create: `tg-hub/rich.mjs`
- Test: `tg-hub/rich-test.mjs`

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `richBody({ chatId, markdown, extra }) → { chat_id, rich_message: { markdown }, ...extra }`
  - `sendRich({ apiRoot, token, chatId, markdown, extra, fetchImpl }) → Promise<object|null>` — `Message` при успехе, `null` при любой неудаче
  - `sendThinking({ apiRoot, token, chatId, draftId, text, fetchImpl }) → Promise<boolean>`
  - `thinkingText({ startedAt, tokens, now }) → string`
  - `RICH_LIMIT = 32768`

- [ ] **Step 1: Написать падающий тест**

```js
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
for (const [label, f] of [['ok:false', fakeFalse], ['исключение сети', fakeThrow], ['нечитаемый ответ', fakeGarbage]]) {
  const r = await sendRich({ apiRoot: 'x', token: 'T', chatId: '1', markdown: 'y', fetchImpl: f });
  assert.equal(r, null, label);
}
ok('sendRich: ok:false / бросок / мусор → null, без исключения наружу');

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
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node tg-hub/rich-test.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND: Cannot find module '.../tg-hub/rich.mjs'`

- [ ] **Step 3: Написать модуль**

```js
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
    return j?.ok ? j.result : null;
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
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `node tg-hub/rich-test.mjs`
Expected: PASS — пять строк `✓` и `✅ rich-test: 5 групп проверок пройдено`

- [ ] **Step 5: Commit (только если коммиты разрешены)**

```bash
git add tg-hub/rich.mjs tg-hub/rich-test.mjs
git commit -m "feat(hub): rich message sender + thinking bubble text"
```

---

### Task 2: `sendMd` в `hub.mjs` — ответы сессий уходят как Rich Messages

**Files:**
- Modify: `tg-hub/hub.mjs` — импорт рядом с прочими; новая функция сразу после `sendTg`; ветка `t:'reply'`

**Interfaces:**
- Consumes: `sendRich`, `RICH_LIMIT` (Task 1).
- Produces: `sendMd(chatId, text, sid, extra, firstExtra) → Promise<object|null>` — та же сигнатура, что у `sendTg`, поэтому вызывающая сторона не меняется.

- [ ] **Step 1: Добавить импорт**

Рядом с существующим `import { replyExtra, askChatFor, nextInbound } from './chat-target.mjs';` добавить:

```js
import { sendRich, RICH_LIMIT } from './rich.mjs';
```

- [ ] **Step 2: Написать `sendMd` сразу после `sendTg`**

```js
// Session answers go out as Rich Messages: the model's Markdown is handed to Telegram
// untouched, which renders real tables, headings and syntax-highlighted code. Falls back to
// the HTML path on ANY failure — an old self-hosted Bot API server (TELEGRAM_API_ROOT), a
// rejected payload (500 blocks / 20 columns / 16 nesting levels), or a network blip.
// Text over RICH_LIMIT goes the old way too, where chunkText splits it.
async function sendMd(chatId, text, sid, extra = {}, firstExtra = {}) {
  const body = String(text ?? '');
  if (body.length <= RICH_LIMIT) {
    const sent = await sendRich({ apiRoot: API_ROOT, token: TOKEN, chatId, markdown: body, extra: { ...firstExtra, ...extra } });
    if (sent?.message_id) {
      if (sid) outMsgToSession.set(sent.message_id, sid);   // keep "reply to a bot message → its session" working
      return sent;
    }
  }
  return sendTg(chatId, body, sid, extra, firstExtra);
}
```

- [ ] **Step 3: Переключить ветку `t:'reply'`**

Заменить `sendTg` на `sendMd` в этой ветке, всё остальное оставить как есть:

```js
      } else if (m.t === 'reply') {
        const to = m.chat_id || CHAT;
        const last = lastInbound.get(m.sessionId);
        sendMd(to, `[${labelOf(m.sessionId)}]\n${m.text}`, m.sessionId, {}, last?.ambiguous ? {} : replyExtra(last, to));
        if (last) last.pending = false;  // answered — the next writer isn't competing with anyone
```

- [ ] **Step 4: Проверить, что других вызовов не задели**

Run: `grep -n "sendTg(\|sendMd(" tg-hub/hub.mjs`
Expected: ровно один вызов `sendMd(` (в ветке `t:'reply'`), один `async function sendMd`; все прочие `sendTg(` на месте — карточки аппрувов, ask-карточки, `t:'notify'`, и вызов `sendTg` внутри самого `sendMd`.

- [ ] **Step 5: Проверить синтаксис**

Run: `node --check tg-hub/hub.mjs`
Expected: пустой вывод, код возврата 0. Демон НЕ перезапускать (см. Global Constraints).

- [ ] **Step 6: Отложенная живая проверка**

Записать в отчёт как непроведённую: ответ с таблицей из живой сессии должен прийти нативной таблицей, а реплай на него — попасть в ту же сессию (`outMsgToSession`). Требует перезапуска демона, который запрещён.

- [ ] **Step 7: Commit (только если коммиты разрешены)**

```bash
git add tg-hub/hub.mjs
git commit -m "feat(hub): send session replies as Rich Messages, fall back to HTML"
```

---

### Task 3: Пузырь `<tg-thinking>` — состояние и таймеры

**Files:**
- Modify: `tg-hub/hub.mjs` — новая карта рядом с `lastInbound`; блок функций после `sendMd`; вызовы в `routeTo`, в ветках `t:'reply'` и `t:'permission_request'`, в `sock.on('close')`, в обработчике `/stop` и в колбэке `stop:`

**Interfaces:**
- Consumes: `sendThinking`, `thinkingText` (Task 1).
- Produces: `startThinking(sessionId, chatId)`, `stopThinking(sessionId)`, и карта `thinking: Map<sessionId, { chatId, draftId, startedAt, tokens, timer }>`, в которую Task 4 кладёт токены.

- [ ] **Step 1: Добавить импорт и состояние**

К импорту из Task 2 добавить `sendThinking, thinkingText`:

```js
import { sendRich, sendThinking, thinkingText, RICH_LIMIT } from './rich.mjs';
```

Рядом с `const lastInbound = new Map();` добавить:

```js
const thinking = new Map();   // sessionId -> { chatId, draftId, startedAt, tokens, timer } — live "Thinking…" draft
let draftSeq = 0;             // draft_id must be a non-zero Integer; a NEW one per turn, since same-id edits animate
```

- [ ] **Step 2: Написать управление пузырём (сразу после `sendMd`)**

```js
// While a session works, show a live draft instead of silence. Drafts are ephemeral (30s),
// animated between updates sharing a draft_id, and PRIVATE CHATS ONLY — a group gets no
// bubble (sendRichMessageDraft answers TEXTDRAFT_PEER_INVALID there). Failure costs nothing:
// a draft is not a message, nothing references it.
const THINK_EVERY_MS = 10000;    // draft TTL is 30s — three shots at each refresh
const THINK_MAX_MS = 600000;     // safety net: stop pretending after 10 minutes
function paintThinking(id) {
  const e = thinking.get(id); if (!e) return;
  if (Date.now() - e.startedAt > THINK_MAX_MS) { stopThinking(id); return; }
  sendThinking({ apiRoot: API_ROOT, token: TOKEN, chatId: e.chatId, draftId: e.draftId,
    text: thinkingText({ startedAt: e.startedAt, tokens: e.tokens }) });
}
function startThinking(id, chatId) {
  if (isGroup(chatId)) return;              // drafts don't exist in groups
  stopThinking(id);                          // a new turn gets a fresh draft_id
  const e = { chatId: Number(chatId), draftId: ++draftSeq, startedAt: Date.now(), tokens: 0, timer: null };
  thinking.set(id, e);
  paintThinking(id);
  e.timer = setInterval(() => paintThinking(id), THINK_EVERY_MS);
  e.timer.unref?.();                         // never hold the daemon open on this alone
}
function stopThinking(id) {
  const e = thinking.get(id); if (!e) return;
  clearInterval(e.timer);
  thinking.delete(id);
}
```

- [ ] **Step 3: Добавить `isGroup` в импорт из `chat-target.mjs`**

Заменить существующий импорт на:

```js
import { replyExtra, askChatFor, nextInbound, isGroup } from './chat-target.mjs';
```

- [ ] **Step 4: Заводить пузырь в `routeTo`**

После строки `lastInbound.set(id, nextInbound(lastInbound.get(id), meta));` добавить:

```js
  startThinking(id, meta.chat_id);   // silence → a live draft while the session works
```

- [ ] **Step 5: Гасить пузырь там, где сессия перестала думать**

В ветке `t:'reply'`, первой строкой тела:

```js
      } else if (m.t === 'reply') {
        stopThinking(m.sessionId);   // the answer itself replaces the draft
```

В ветке `t:'permission_request'`, первой строкой тела (сессия не думает — она ждёт человека):

```js
      } else if (m.t === 'permission_request') {
        stopThinking(m.sessionId);
```

В `sock.on('close')`, рядом с `lastInbound.delete(sid);`:

```js
    stopThinking(sid);
```

В обработчике `bot.command('stop', …)` и в колбэке `stop:` — сразу после `sendToSession(id, { t: 'stop' })`:

```js
    stopThinking(id);
```

- [ ] **Step 6: Проверить синтаксис и точки остановки грепом**

Run: `node --check tg-hub/hub.mjs`, затем `grep -n "startThinking(\|stopThinking(" tg-hub/hub.mjs`
Expected: `node --check` пуст; в грепе — одно объявление и один вызов `startThinking` (в `routeTo`), одно объявление и **пять** вызовов `stopThinking` (внутри `startThinking`, в `t:'reply'`, в `t:'permission_request'`, в `sock.on('close')`, в `/stop` и в колбэке `stop:` — итого шесть вызовов, из них один внутренний). Перечислить найденное в отчёте построчно.

- [ ] **Step 7: Отложенная живая проверка**

Записать в отчёт как непроведённую: в личке пузырь появляется и тикает, гаснет с ответом и на карточке аппрува; в группе не появляется вовсе. Требует перезапуска демона, который запрещён.

- [ ] **Step 8: Commit (только если коммиты разрешены)**

```bash
git add tg-hub/hub.mjs
git commit -m "feat(hub): live <tg-thinking> bubble while a session works (DM only)"
```

---

### Task 4: Счётчик токенов — `{t:'status'}` от интерпозера и headless

**Files:**
- Modify: `tg-hub/panel/interposer.mjs` — рядом с обработкой `o.type === 'assistant'`
- Modify: `tg-hub/panel/headless.mjs` — симметрично
- Modify: `tg-hub/hub.mjs` — новая ветка в разборе IPC-сообщений

**Interfaces:**
- Consumes: карта `thinking` (Task 3).
- Produces: IPC-сообщение `{ t: 'status', sessionId, tokens }`, где `tokens` — сумма `output_tokens` по текущему ходу.

- [ ] **Step 1: Копить и слать сумму в `interposer.mjs`**

Рядом с прочим состоянием файла добавить:

```js
// Token counter for the hub's "Thinking…" bubble. usage.output_tokens is per API CALL, and a
// turn with tools is many calls, so we sum. A `user` message means a new turn → reset.
let turnTokens = 0, lastStatusAt = 0;
```

В обработчике потока, там где `o.type === 'assistant' && o.message`, после существующей отправки `reply`-блоков добавить:

```js
    const out = Number(o.message?.usage?.output_tokens || 0);
    if (out) {
      turnTokens += out;
      const now = Date.now();
      if (now - lastStatusAt > 2000) { lastStatusAt = now; sendHub({ t: 'status', sessionId, tokens: turnTokens }); }
    }
```

И сбросить счётчик на начале нового хода. Ветки `o.type === 'user'` в этом файле **нет** —
её надо добавить рядом с остальными проверками типа события, до них или после, порядок
неважен (она ничего не возвращает и не глотает событие):

```js
  if (o.type === 'user') { turnTokens = 0; lastStatusAt = 0; }   // new turn → new counter
```

- [ ] **Step 2: То же в `headless.mjs`**

Те же три вставки, с поправкой на то, что идентификатор сессии там — константа `SESSION_ID`:

```js
let turnTokens = 0, lastStatusAt = 0;
```

```js
    const out = Number(o.message?.usage?.output_tokens || 0);
    if (out) {
      turnTokens += out;
      const now = Date.now();
      if (now - lastStatusAt > 2000) { lastStatusAt = now; sendHub({ t: 'status', sessionId: SESSION_ID, tokens: turnTokens }); }
    }
```

```js
  if (o.type === 'user') { turnTokens = 0; lastStatusAt = 0; }
```

- [ ] **Step 3: Принять `status` в хабе**

В разборе IPC-сообщений, рядом с веткой `m.t === 'title'`, добавить:

```js
      } else if (m.t === 'status') {
        const e = thinking.get(m.sessionId);      // only meaningful while a bubble is up
        if (e) { e.tokens = Number(m.tokens || 0); paintThinking(m.sessionId); }
```

- [ ] **Step 4: Проверить синтаксис всех трёх файлов**

Run: `node --check tg-hub/hub.mjs && node --check tg-hub/panel/interposer.mjs && node --check tg-hub/panel/headless.mjs`
Expected: пусто, код возврата 0

- [ ] **Step 5: Проверить накопление счётчика на записанном потоке**

Смоук `smoke-headless-e2e.mjs` поднимает реального движка и мог бы задеть боевой демон, поэтому его НЕ запускаем. Вместо него — throwaway-скрипт во временной папке (не в репозитории, в `git status` ничего нового появиться не должно), который повторяет вставленную логику счётчика и скармливает ей последовательность событий: `user`, `assistant` с `usage.output_tokens: 100`, `assistant` с `300`, `user`, `assistant` с `50`. Проверить, что после второго `assistant` сумма равна 400, а после `user` счётчик обнулился и стал 50. Вывод скрипта вставить в отчёт, скрипт удалить.

- [ ] **Step 6: Отложенная живая проверка**

Записать в отчёт как непроведённую: пузырь должен показывать `Thinking… · 1.2k tokens · 14 с` с растущим числом у stream-сессии и `Thinking… · 14 с` без токенов у channels-сессии. Требует перезапуска демона, который запрещён.

- [ ] **Step 7: Commit (только если коммиты разрешены)**

```bash
git add tg-hub/hub.mjs tg-hub/panel/interposer.mjs tg-hub/panel/headless.mjs
git commit -m "feat(hub+panel): report per-turn token totals for the thinking bubble"
```

---

### Task 5: Документация

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: всё предыдущее.
- Produces: ничего.

- [ ] **Step 1: Прогнать все юнит-наборы**

Run: `node tg-hub/rich-test.mjs && node tg-hub/access-test.mjs && node tg-hub/chat-target-test.mjs`
Expected: три строки `✅ …пройдено`

- [ ] **Step 2: Добавить раздел в README**

Вставить после раздела про рендер/команды, до «Бот в группе»:

```markdown
## Как выглядят ответы

Ответы сессий уходят Rich Messages (Bot API 10.1): Markdown модели отдаётся Telegram как
есть, и клиент рисует его сам — таблицы с границами и выравниванием, заголовки, списки,
блоки кода с подсветкой и меткой языка, цитаты. Конвертации на нашей стороне нет.

Побочный эффект: лимит сообщения 32768 символов вместо 4096, поэтому длинные ответы почти
перестали резаться на куски (а таблица больше не рвётся посередине).

Если Telegram отказал — например, `TELEGRAM_API_ROOT` указывает на self-hosted Bot API
server старее 10.1, или ответ упёрся в лимит (500 блоков, 20 колонок, 16 уровней
вложенности) — сообщение уходит прежним путём, через Markdown→HTML. Ничего не теряется.

Пока сессия работает, в **личке** висит живой индикатор `Thinking… · 1.8k tokens · 23 с`:
время идёт всегда, токены показываются для stream-сессий (панель VSCode / `HUB_STREAM=1`),
у channels-сессий движок их не отдаёт. Индикатор гаснет с приходом ответа и на время
ожидания аппрува. В группах его нет — Telegram разрешает такие черновики только в личных
чатах.
```

- [ ] **Step 3: Убрать устаревшее утверждение про 4096**

Run: `grep -n "4096" README.md`
Для каждой найденной строки: если она обещает нарезку по 4096 как единственное поведение — дописать «(для ответов сессий действует лимит rich-сообщений, 32768; нарезка остаётся для запасного пути)». Если совпадений нет — ничего не делать и записать это в отчёт.

- [ ] **Step 4: Обновить CLAUDE.md**

В абзац «Сделано» дописать:

```markdown
**нативный рендер ответов** (Rich Messages Bot API 10.1: Markdown модели уходит в Telegram
как есть — таблицы, заголовки, подсвеченный код; плюс живой пузырь `Thinking…` с временем и
токенами в личке — см. [`docs/specs/2026-07-29-rich-messages.md`](docs/specs/2026-07-29-rich-messages.md)),
```

- [ ] **Step 5: Commit (только если коммиты разрешены)**

```bash
git add README.md CLAUDE.md
git commit -m "docs: rich message rendering and the thinking bubble"
```
