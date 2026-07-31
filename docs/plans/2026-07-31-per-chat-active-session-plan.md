# Активная сессия на чат — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** У каждого чата свой указатель активной сессии; чат без активной сессии не теряет написанное; на кнопках виден проект; шапка ответа отделена от текста цитатой.

**Architecture:** Вся новая логика — чистые функции и фабрики в новом `tg-hub/routing.mjs`, тестируемые без сети. В `hub.mjs` глобальная `active` заменяется на карту по чатам, `pendingActivate` начинает помнить чат-заказчика, добавляется карта придержанных сообщений, а подпись кнопки и разбор тапа по ней сводятся к одной функции. Спека: [docs/specs/2026-07-31-per-chat-active-session.md](../specs/2026-07-31-per-chat-active-session.md).

**Tech Stack:** Node.js `.mjs`, zero-build, grammY, тесты — обычные node-скрипты на `node:assert/strict`.

## Global Constraints

- **НЕ коммитить без явного запроса пользователя** (правило проекта из `CLAUDE.md`). Шаги «Commit» выполнять только если пользователь разрешил коммиты для текущей ветки.
- **Демон не перезапускать без явного разрешения владельца.** На машине крутится боевой `hub.mjs` с живыми сессиями; правки на диске работающему процессу не мешают, он держит код в памяти. Проверка каждой задачи — статическая: юнит-тесты, `node --check`, грепы. Живые сценарии записывать в отчёт как отложенные, результат не выдумывать.
- Ничего не менять в `tg-hub/panel/` — шапка ответа приклеивается в хабе и только для исходящего в Telegram; панель этого не видит.
- Новых зависимостей и переменных окружения нет.
- Стиль: компактный `.mjs` как в `hub.mjs`, комментарии по-английски, тексты в Telegram по-русски.
- Формат шапки ответа — ровно `> <метка>`, пустая строка, текст. Шапка **безусловна**: в любом чате, при любом числе сессий.
- Подпись кнопки — `проект · метка`, проект обрезается до 14 символов, метка до 22.
- Номера строк даны по `main` на коммит `d9d47b5`. Место правки ищи по приведённому фрагменту кода, а не по номеру: задачи 2-5 сдвигают файл.

---

### Task 1: `routing.mjs` — карта активных, придержанные тексты, подпись кнопки

**Files:**
- Create: `tg-hub/routing.mjs`
- Test: `tg-hub/routing-test.mjs`

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `createActive()` → `{ get(chatId) → sessionId|null, set(chatId, sessionId), clearSession(sessionId), chatsFor(sessionId) → string[] }`
  - `createPending(ttlMs)` → `{ put(chatId, text, now?), take(chatId, now?) → string|null }`
  - `sessionButton({ label, cwd }) → string`
  - `stripActiveMark(text) → string`
  - `PENDING_TTL_MS = 600000`

- [ ] **Step 1: Написать падающий тест**

```js
// tg-hub/routing-test.mjs
// Unit test for routing.mjs — pure state and formatting, no I/O.
// Run from repo root:  node tg-hub/routing-test.mjs
import assert from 'node:assert/strict';
import { createActive, createPending, sessionButton, stripActiveMark, PENDING_TTL_MS } from './routing.mjs';

let n = 0; const ok = m => { n++; console.log('  ✓', m); };

// 1. активная сессия — своя в каждом чате
const A = createActive();
assert.equal(A.get('300447655'), null, 'пустая карта — null, не undefined');
A.set('300447655', 's1');
A.set('-100123', 's2');
assert.equal(A.get('300447655'), 's1');
assert.equal(A.get('-100123'), 's2', 'второй чат не затронут первым');
A.set('300447655', 's3');                       // повторный set заменяет
assert.equal(A.get('300447655'), 's3');
assert.equal(A.get('-100123'), 's2');
assert.equal(A.get(300447655), 's3', 'числовой chatId эквивалентен строковому');
ok('createActive: чаты независимы, set заменяет, ключ нормализуется');

// 2. clearSession убирает сессию изо всех чатов и только её
A.set('-100999', 's2');
assert.deepEqual(A.chatsFor('s2').sort(), ['-100123', '-100999']);
A.clearSession('s2');
assert.equal(A.get('-100123'), null);
assert.equal(A.get('-100999'), null);
assert.equal(A.get('300447655'), 's3', 'чужая сессия не тронута');
A.clearSession('никогда-не-было');              // не бросает
ok('clearSession: чистит все чаты сессии, остальные не трогает');

// 3. придержанный текст
const P = createPending(1000);
assert.equal(P.take('c1'), null, 'ничего не клали — null');
P.put('c1', 'первый', 0);
P.put('c1', 'второй', 10);                      // второе сообщение ЗАМЕНЯЕТ первое
assert.equal(P.take('c1', 20), 'второй');
assert.equal(P.take('c1', 20), null, 'take одноразовый');
P.put('c2', 'протухнет', 0);
assert.equal(P.take('c2', 1001), null, 'после ttl не отдаётся');
P.put('c3', 'ещё живой', 0);
assert.equal(P.take('c3', 999), 'ещё живой', 'внутри ttl отдаётся');
assert.equal(PENDING_TTL_MS, 600000);
ok('createPending: замена, одноразовость, протухание по ttl');

// 4. подпись кнопки
assert.equal(sessionButton({ label: 'Ревью-PRs', cwd: 'd:\\Projects\\vassav\\teamly' }), 'teamly · Ревью-PRs');
assert.equal(sessionButton({ label: 'Ревью-PRs', cwd: '/home/v/projects/teamly/' }), 'teamly · Ревью-PRs', 'хвостовой слэш не создаёт пустой проект');
assert.equal(sessionButton({ label: 'Ревью-PRs', cwd: '' }), 'Ревью-PRs', 'без cwd — только метка, без разделителя');
assert.equal(sessionButton({ label: 'Ревью-PRs' }), 'Ревью-PRs', 'cwd вообще отсутствует');
// обрезка: проект 27 симв. -> slice(0,13)+'…', метка 33 симв. -> slice(0,21)+'…'
assert.equal(sessionButton({ label: 'Давай-разберем-что-можно-и-нельзя', cwd: 'd:\\p\\very-long-project-name-here' }),
  'very-long-pro… · Давай-разберем-что-мо…', 'проект до 14, метка до 22, с многоточием');
ok('sessionButton: проект · метка, обрезка, отсутствующий cwd');

// 5. снятие отметки активной
assert.equal(stripActiveMark('teamly · Ревью-PRs ✓'), 'teamly · Ревью-PRs');
assert.equal(stripActiveMark('teamly · Ревью-PRs'), 'teamly · Ревью-PRs');
assert.equal(stripActiveMark('  teamly · Ревью ✓  '), 'teamly · Ревью');
ok('stripActiveMark: снимает галочку и пробелы, без неё не портит');

// 6. круг: подпись → строка → поиск находит ТУ ЖЕ сессию среди похожих
const live = [
  { id: 'a', label: 'Ревью-PRs', cwd: '/p/teamly' },
  { id: 'b', label: 'Ревью-PRs', cwd: '/p/other' },   // одинаковые метки, разные проекты
  { id: 'c', label: 'Ревью', cwd: '/p/teamly' },      // метка — префикс другой
];
for (const s of live) {
  const shown = sessionButton(s) + ' ✓';
  const found = live.find(x => sessionButton(x) === stripActiveMark(shown));
  assert.equal(found.id, s.id, `круг для ${s.id}`);
}
ok('круговой разбор: похожие метки различаются по проекту');

console.log(`\n✅ routing-test: ${n} групп проверок пройдено`);
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node tg-hub/routing-test.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND: Cannot find module '.../tg-hub/routing.mjs'`

- [ ] **Step 3: Написать модуль**

```js
// tg-hub/routing.mjs
// Where a chat's plain text goes, and how a session looks on a button.
// The hub used to keep ONE global `active` pointer, so switching in the group also
// switched the DM. Here each chat owns its own pointer.
import { basename } from 'node:path';

export const PENDING_TTL_MS = 600000;   // 10 min: a tap an hour later must not deliver a forgotten line

const key = chatId => String(chatId ?? '');

// chatId -> sessionId. One pointer per chat, nothing global.
export function createActive() {
  const m = new Map();
  return {
    get: chatId => m.get(key(chatId)) ?? null,
    set: (chatId, sessionId) => { m.set(key(chatId), sessionId); },
    // A dead session must stop being "active" everywhere at once — and must NOT be
    // replaced by a guess, or the next message would land in a random session.
    clearSession(sessionId) { for (const [c, s] of m) if (s === sessionId) m.delete(c); },
    chatsFor(sessionId) { return [...m].filter(([, s]) => s === sessionId).map(([c]) => c); },
  };
}

// Text written into a chat that has no active session yet. Held until the person picks
// a session, then delivered — so the message is neither lost nor guessed at.
export function createPending(ttlMs = PENDING_TTL_MS) {
  const m = new Map();
  return {
    put(chatId, text, now = Date.now()) { m.set(key(chatId), { text, ts: now }); },  // a second line REPLACES the first
    take(chatId, now = Date.now()) {
      const k = key(chatId), e = m.get(k);
      if (!e) return null;
      m.delete(k);
      return now - e.ts > ttlMs ? null : e.text;
    },
  };
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// Button caption AND the key we match a tap against — the bottom keyboard sends plain
// text, so caption and lookup must come from this one function or taps silently break.
export function sessionButton({ label, cwd }) {
  const proj = cwd ? basename(String(cwd).replace(/[\\/]+$/, '')) : '';
  const name = cut(String(label ?? ''), 22);
  return proj ? `${cut(proj, 14)} · ${name}` : name;
}
export const stripActiveMark = text => String(text ?? '').replace(/\s*✓\s*$/, '').trim();
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `node tg-hub/routing-test.mjs`
Expected: PASS — шесть строк `✓` и `✅ routing-test: 6 групп проверок пройдено`

- [ ] **Step 5: Commit (только если коммиты разрешены)**

```bash
git add tg-hub/routing.mjs tg-hub/routing-test.mjs
git commit -m "feat(hub): per-chat routing state and session button captions"
```

---

### Task 2: Указатель активной сессии — на чат

**Files:**
- Modify: `tg-hub/hub.mjs` — импорт; строка `let active = null;` ([:79](../../tg-hub/hub.mjs#L79)); `pendingActivate` ([:80](../../tg-hub/hub.mjs#L80)); `replyKeyboard` ([:332](../../tg-hub/hub.mjs#L332)); `sessionInline` ([:403](../../tg-hub/hub.mjs#L403)); `targetSession` ([:425](../../tg-hub/hub.mjs#L425)); `startSession` ([:466-484](../../tg-hub/hub.mjs#L466-L484)); ветка регистрации ([:638-641](../../tg-hub/hub.mjs#L638-L641)); `sock.on('close')` ([:749](../../tg-hub/hub.mjs#L749)); `/sessions` ([:811](../../tg-hub/hub.mjs#L811)); `/use` ([:827](../../tg-hub/hub.mjs#L827)); пятёрка команд пульта ([:853](../../tg-hub/hub.mjs#L853)); колбэк `switch:` ([:868](../../tg-hub/hub.mjs#L868)); `⚙ пульт` ([:1032](../../tg-hub/hub.mjs#L1032)); тап по метке ([:1048](../../tg-hub/hub.mjs#L1048)); хвост `message:text` ([:1054-1057](../../tg-hub/hub.mjs#L1054-L1057))

**Interfaces:**
- Consumes: `createActive` (Task 1).
- Produces: `const active = createActive();` — модульная константа; `activeIn(ctx)`; `replyKeyboard(chatId)`; `sessionInline(chatId)`; `startSession(cwd, { resumeUuid, chatId, … })`.

- [ ] **Step 1: Импорт и состояние**

Рядом с прочими импортами:

```js
import { createActive } from './routing.mjs';
```

Заменить `let active = null;` на:

```js
const active = createActive();                 // chatId -> sessionId; no global pointer
const activeIn = ctx => active.get(ctx.chat?.id);
```

Заменить `const pendingActivate = new Set();` на:

```js
const pendingActivate = new Map(); // sessionId -> chatId that asked for it (new/resume flow)
```

- [ ] **Step 2: Клавиатуры принимают чат**

`replyKeyboard` и `sessionInline` — добавить параметр и использовать его:

```js
function replyKeyboard(chatId) {
  const k = new Keyboard();
  const cur = active.get(chatId);
  if (order.length) { for (const id of order) k.text(labelOf(id) + (id === cur ? ' ✓' : '')); k.row(); }
  k.text('/sessions').text('/projects').text('⚙ пульт');
  return k.resized();
}
```

```js
function sessionInline(chatId) {
  const k = new InlineKeyboard();
  const cur = active.get(chatId);
  for (const id of order) { k.text((id === cur ? '● ' : '') + labelOf(id), `switch:${id}`).text('🛑', `stop:${id}`).row(); }
  for (const e of resumableEntries()) k.text(`⏸ ${e.label} — resume`, `resume:${e.id}`).text('🗑', `forget:${e.id}`).row();
  return k;
}
```

Run: `grep -n "replyKeyboard()\|sessionInline()" tg-hub/hub.mjs` — каждый вызов без аргумента заменить: там, где есть `ctx`, на `replyKeyboard(ctx.chat.id)`; внутри `notify(...)` и прочих мест без чата — на `replyKeyboard(CHAT)`.

- [ ] **Step 3: `targetSession` и хвост `message:text`**

```js
function targetSession(ctx) {
  const rid = ctx.message?.reply_to_message?.message_id;
  if (rid && outMsgToSession.has(rid)) return outMsgToSession.get(rid);
  return activeIn(ctx);
}
```

Хвост обработчика текста (ветку «нет активной» пока оставляем как есть — её заменит Task 3):

```js
  const cur = activeIn(ctx);
  if (!cur) { await ctx.reply('no active session — /projects to resume one, or start the launcher'); return; }
  // reply to a non-bot message (yours, someone else's, or a bot msg forgotten after a
  // restart) still carries its quote to the active session.
  await routeTo(ctx, cur, quoted + text);
```

- [ ] **Step 4: Остальные чтения**

- `/sessions`: `const cur = active.get(ctx.chat.id);` и в строке списка `${id === cur ? '● ' : '○ '}`; вызовы клавиатур — с `ctx.chat.id`.
- `/use`: вместо `active = id` → `active.set(ctx.chat.id, id)`.
- Пятёрка команд пульта и `⚙ пульт`: `const id = activeIn(ctx);`.
- Колбэк `switch:`: `active.set(ctx.chat.id, id);` вместо `active = id`, и обе клавиатуры с `ctx.chat.id`.
- Тап по метке: `active.set(ctx.chat.id, swId)`.

- [ ] **Step 5: Кто активирует новую сессию**

В `startSession` добавить `chatId` в опции и запоминать его:

```js
function startSession(cwd, { resumeUuid, chatId, extraMcpServers, extraAllowedTools } = {}) {
```

и вместо `pendingActivate.add(id)`:

```js
  pendingActivate.set(id, String(chatId || CHAT));   // activate it only in the chat that asked
```

Все `pendingActivate.delete(id)` остаются как есть. Вызовы дополнить чатом: `/new` → `startSession(cwd, { chatId: ctx.chat.id })`; колбэк `new:` → `startSession(p.cwd, { chatId: ctx.chat.id })`; колбэки `res:` и `resume:` → добавить `chatId: ctx.chat.id` к существующим опциям; внешний IPC `{t:'start'}` — не трогать, `chatId` там нет и подставится `CHAT`.

- [ ] **Step 6: Регистрация и отключение**

Ветку регистрации заменить на:

```js
        const wantChat = pendingActivate.get(sid);
        if (wantChat !== undefined) { active.set(wantChat, sid); pendingActivate.delete(sid); }
        else if (!active.get(CHAT)) active.set(CHAT, sid);   // first session ever → home chat
        console.error(`[hub] ${readopt ? 're-adopted' : 'registered'}: ${labelOf(sid)} = ${sid} (cwd ${m.cwd})`);
        notify(`${readopt ? '♻️ re-adopted' : '✅ registered'} ${labelOf(sid)}\ncwd: ${m.cwd}\nactive: ${labelOf(active.get(CHAT))}`, { reply_markup: replyKeyboard(CHAT) });
```

В `sock.on('close')` заменить строку `if (active === sid) active = order[order.length - 1] || null;` на:

```js
    active.clearSession(sid);   // no guessing a replacement — the next message would land somewhere random
```

- [ ] **Step 7: Проверить, что глобальной переменной не осталось**

Run: `grep -n "active" tg-hub/hub.mjs | grep -v "active\.\|activeIn\|pendingActivate\|// \|looks active\|become active"`
Expected: пусто — ни одного присваивания или чтения старой переменной.

Run: `node --check tg-hub/hub.mjs`
Expected: пустой вывод, код возврата 0. Демон не перезапускать.

- [ ] **Step 8: Отложенная живая проверка**

Записать в отчёт как непроведённую: переключение сессии в личке не меняет активную в группе и наоборот. Требует перезапуска демона, который без разрешения владельца запрещён.

- [ ] **Step 9: Commit (только если коммиты разрешены)**

```bash
git add tg-hub/hub.mjs
git commit -m "feat(hub): per-chat active session pointer"
```

---

### Task 3: Чат без активной сессии придерживает текст

**Files:**
- Modify: `tg-hub/hub.mjs` — состояние рядом с `active`; хвост `message:text`; колбэк `switch:`

**Interfaces:**
- Consumes: `createPending` (Task 1); `active`, `activeIn` (Task 2).
- Produces: `const pending = createPending();`

- [ ] **Step 1: Импорт и состояние**

Дополнить импорт из `routing.mjs`:

```js
import { createActive, createPending } from './routing.mjs';
```

Рядом с `const active = createActive();`:

```js
const pending = createPending();   // chatId -> text written before the chat had an active session
```

- [ ] **Step 2: Хвост `message:text` — придержать вместо отказа**

Заменить ветку «нет активной сессии» из Task 2 на:

```js
  const cur = activeIn(ctx);
  if (!cur) {
    // Don't drop what they wrote: hold it and let them pick a session — the tap delivers it.
    if (!order.length) { await ctx.reply('нет живых сессий — /projects, чтобы поднять'); return; }
    pending.put(ctx.chat.id, quoted + text);
    await ctx.reply('в этом чате нет активной сессии — выбери, куда отправить:', { reply_markup: sessionInline(ctx.chat.id) });
    return;
  }
  await routeTo(ctx, cur, quoted + text);
```

- [ ] **Step 3: Колбэк `switch:` доставляет придержанное**

В ветке `switch:`, сразу после `active.set(ctx.chat.id, id);` и ответа на колбэк, добавить:

```js
      const held = pending.take(ctx.chat.id);
      if (held) await routeTo(ctx, id, held);   // deliver what they wrote before picking
```

- [ ] **Step 4: Проверить синтаксис**

Run: `node --check tg-hub/hub.mjs`
Expected: пустой вывод, код возврата 0. Демон не перезапускать.

- [ ] **Step 5: Проверить, что `routeTo` вызывается с корректным `ctx`**

Run: `grep -n "routeTo(ctx" tg-hub/hub.mjs`
Expected: все вызовы — из обработчиков, где `ctx.chat` и `ctx.message` существуют. В колбэке `switch:` `ctx.message` — это сообщение с кнопкой (оно есть у callback_query), поэтому `routeTo` соберёт `meta.message_id` от него; отметить это в отчёте как известное следствие: цитата будет указывать на карточку выбора, а не на исходный текст.

- [ ] **Step 6: Отложенная живая проверка**

Записать в отчёт как непроведённую: написать в чат без активной сессии, выбрать кнопкой — придержанный текст уходит в выбранную сессию. Требует перезапуска демона.

- [ ] **Step 7: Commit (только если коммиты разрешены)**

```bash
git add tg-hub/hub.mjs
git commit -m "feat(hub): hold a message written into a chat with no active session"
```

---

### Task 4: Проект на кнопках и парный разбор тапа

**Files:**
- Modify: `tg-hub/hub.mjs` — `replyKeyboard`, `sessionInline`, тап по метке

**Interfaces:**
- Consumes: `sessionButton`, `stripActiveMark` (Task 1).
- Produces: ничего.

- [ ] **Step 1: Дополнить импорт**

```js
import { createActive, createPending, sessionButton, stripActiveMark } from './routing.mjs';
```

- [ ] **Step 2: Подпись в обеих клавиатурах**

В `replyKeyboard` и `sessionInline` заменить `labelOf(id)` на подпись с проектом. Понадобится `cwd`, он лежит в `sessions.get(id).cwd`:

```js
const btnOf = id => sessionButton({ label: labelOf(id), cwd: sessions.get(id)?.cwd });
```

Поставить это рядом с `labelOf` и использовать в обеих клавиатурах вместо `labelOf(id)`. `/sessions`-список, `/to`, шапка ответа и все уведомления продолжают использовать `labelOf` — там подпись кнопки не нужна.

- [ ] **Step 3: Парный разбор тапа**

Заменить разбор в `message:text`:

```js
  // bare button tap from the keyboard -> switch this chat's active session.
  // Caption and lookup MUST come from the same function: the bottom keyboard sends plain
  // text, so a format change on one side without the other silently turns taps into prompts.
  const bare = stripActiveMark(text);
  const swId = order.find(x => btnOf(x) === bare);
  if (swId) { active.set(ctx.chat.id, swId); await ctx.reply(`▶ active: ${labelOf(swId)}`, { reply_markup: replyKeyboard(ctx.chat.id) }); return; }
```

- [ ] **Step 4: Проверить синтаксис и отсутствие рассинхрона**

Run: `node --check tg-hub/hub.mjs`, затем `grep -n "btnOf(\|labelOf(" tg-hub/hub.mjs`
Expected: `node --check` пуст; в грепе `btnOf` встречается ровно в трёх местах — объявление, обе клавиатуры и разбор тапа (итого четыре вхождения), а `labelOf` больше не участвует в построении кнопок нижней клавиатуры. Перечислить найденное в отчёте построчно.

- [ ] **Step 5: Отложенная живая проверка**

Записать в отчёт как непроведённую: на кнопках виден проект, тап переключает активную сессию именно в этом чате.

- [ ] **Step 6: Commit (только если коммиты разрешены)**

```bash
git add tg-hub/hub.mjs
git commit -m "feat(hub): show the project on session buttons, parse taps with the same function"
```

---

### Task 5: Вид ответа — шапка-цитата и реплай на запрос в любом чате

**Files:**
- Modify: `tg-hub/hub.mjs` — ветка `m.t === 'reply'`
- Modify: `tg-hub/chat-target.mjs:14` — снять условие `isGroup` в `replyExtra`
- Modify: `tg-hub/chat-target-test.mjs:19` — перевернуть утверждение про личку

**Interfaces:**
- Consumes: ничего.
- Produces: ничего. Сигнатура `replyExtra(last, chatId)` не меняется, меняется её условие.

- [ ] **Step 1: Заменить склейку шапки**

Найти в ветке `m.t === 'reply'` строку, собирающую текст как `` `[${labelOf(m.sessionId)}]\n${m.text}` ``, и заменить выражение на:

```js
        // Header as a blockquote, ALWAYS, in every chat. The blank line is load-bearing:
        // rich messages are Markdown, where a single newline does NOT start a new block, so
        // `[label]\n` merged the header into the answer's first sentence. mdToTgHtml turns the
        // same `> ` line into <blockquote>, so the fallback path renders it as a quote too.
        const header = `> ${labelOf(m.sessionId)}\n\n`;
```

и передавать в отправку `header + m.text` вместо прежней строки. Остальное в ветке (выбор чата, `replyExtra`, сброс `pending`) не трогать.

- [ ] **Step 1b: Цитировать исходный запрос и в личке**

`replyExtra` сегодня отбрасывает цитату везде, кроме групп. Заменить первую строку её тела:

```js
export function replyExtra(last, chatId) {
  // Quote the message that asked, in ANY chat — group or DM. Two conditions remain: we
  // must know which message it was, and the answer must be going back to the very chat the
  // question came from (a session can be driven from several chats).
  if (!last?.message_id) return {};
```

Условие `String(last.chat_id) !== String(chatId)` и возврат `reply_parameters` ниже — не трогать. `isGroup` остаётся экспортированной: её использует пузырь `Thinking…` в `hub.mjs`.

- [ ] **Step 1c: Перевернуть устаревшее утверждение в тесте**

В `tg-hub/chat-target-test.mjs` строка 19 сейчас утверждает обратное новому поведению и упадёт. Заменить её на:

```js
assert.deepEqual(replyExtra(last, '-100123'), { reply_parameters: { message_id: 77, allow_sending_without_reply: true } });
assert.deepEqual(replyExtra({ chat_id: '300447655', message_id: '9' }, '300447655'),
  { reply_parameters: { message_id: 9, allow_sending_without_reply: true } }, 'в личке цитируем так же, как в группе');
```

Остальные утверждения группы (другой чат → `{}`, нет `lastInbound` → `{}`, нет `message_id` → `{}`) сохраняются: они проверяют условия, которые остались в силе. Обновить и текст `ok(...)` этой группы, если он говорит про группы.

- [ ] **Step 2: Проверить синтаксис**

Run: `node --check tg-hub/hub.mjs`
Expected: пустой вывод, код возврата 0.

- [ ] **Step 3: Проверить рендер обоих путей без сети**

Написать throwaway-скрипт во временной папке (не в репозитории — в `git status` ничего нового появиться не должно), который импортирует `mdToTgHtml`… — она не экспортируется, поэтому вместо импорта скопировать в скрипт текущее тело `mdToTgHtml` из `hub.mjs` и прогнать через него строку `> Ревью-PRs\n\nСобрал сводку.` Убедиться, что на выходе `<blockquote>Ревью-PRs</blockquote>` и текст отдельной строкой. Вывод вставить в отчёт, скрипт удалить.

- [ ] **Step 3b: Прогнать затронутый юнит-набор**

Run: `node tg-hub/chat-target-test.mjs`
Expected: PASS, число групп прежнее (4) — утверждение заменено, а не добавлено новой группой.

- [ ] **Step 4: Отложенная живая проверка**

Записать в отчёт как непроведённую: в личке и в группе ответ приходит реплаем на исходный запрос, а под ним шапка-цитата с именем сессии, отделённая пустой строкой.

- [ ] **Step 5: Commit (только если коммиты разрешены)**

```bash
git add tg-hub/hub.mjs tg-hub/chat-target.mjs tg-hub/chat-target-test.mjs
git commit -m "feat(hub): quote the asker in every chat; reply header as a blockquote"
```

---

### Task 6: Документация

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: всё предыдущее.
- Produces: ничего.

- [ ] **Step 1: Прогнать все юнит-наборы**

Run: `node tg-hub/routing-test.mjs && node tg-hub/rich-test.mjs && node tg-hub/access-test.mjs && node tg-hub/chat-target-test.mjs`
Expected: четыре строки `✅ …пройдено`

- [ ] **Step 2: Описать поведение в README**

Вставить в раздел про сессии и маршрутизацию:

```markdown
## Активная сессия — своя в каждом чате

Обычный текст уходит в активную сессию **того чата**, где он написан. Переключение в личке
не трогает группу и наоборот. Список живых сессий при этом общий: все чаты видят все сессии,
различается только отметка «активна».

На кнопках видно проект: `teamly · Ревью-PRs` — базовое имя каталога сессии и её название.

Если в чате активной сессии ещё нет, бот не теряет написанное: текст придерживается, а в ответ
приходит список сессий кнопками. Тап отправляет придержанное в выбранную сессию. Придержанное
живёт 10 минут; новое сообщение до выбора заменяет предыдущее.

Указатель очищается, когда сессия отключается, и никуда не перескакивает сам — иначе следующее
сообщение ушло бы в случайную сессию. Ответ на сообщение бота по-прежнему адресует сессию
напрямую, минуя указатель.
```

- [ ] **Step 3: Проверить, что старое описание не противоречит**

Run: `grep -n "активн" README.md`
Для каждой найденной строки убедиться, что она не обещает единственную глобальную активную сессию. Найденное и решение по каждой строке перечислить в отчёте.

- [ ] **Step 4: Commit (только если коммиты разрешены)**

```bash
git add README.md
git commit -m "docs: per-chat active session, project on buttons, held messages"
```

---

### Task 7: Придержанный текст доставляется и при подъёме сессии

**Files:**
- Modify: `tg-hub/hub.mjs` — ветка регистрации сессии в IPC-обработчике (там, где `pendingActivate` отдаёт чат-заказчика и вызывается `active.set`)

**Interfaces:**
- Consumes: `pending` (Task 3), `active`/`pendingActivate` (Task 2), существующие `sendToSession`, `armAutoName`, `lastInbound`, `nextInbound`.
- Produces: ничего.

**Зачем:** пикер в пустом чате строится функцией `sessionInline`, а она показывает не только живые сессии, но и возобновляемые — кнопкой `⏸ resume`. Такой тап идёт через `startSession`, а не через `switch:`, поэтому доставка, написанная только в обработчике переключения, его не покрывает: человек жмёт кнопку из предложенного ему списка и не получает ничего. Это прямо противоречит §2 спеки.

- [ ] **Step 1: Доставить придержанное там, где сессия становится активной**

В ветке регистрации, сразу после строки, которая делает сессию активной в чате-заказчике (`if (wantChat !== undefined) { active.set(wantChat, sid); pendingActivate.delete(sid); }`), добавить:

```js
        // The picker offered in an empty chat also lists ⏸ resumable sessions, and tapping one
        // goes through startSession — never through the switch: handler. Deliver here, where a
        // session becomes a chat's active one no matter how it got up: new, resumed or re-adopted.
        // No ctx and no original message_id, so this goes out like pendingFirstMsg does, and the
        // answer will carry no reply-quote.
        if (wantChat !== undefined) {
          const held = pending.take(wantChat);
          const meta = { chat_id: String(wantChat), message_id: '', user: 'hub', user_id: '', ts: new Date().toISOString() };
          if (held && sendToSession(sid, { t: 'inbound', content: held, meta })) {
            lastInbound.set(sid, nextInbound(lastInbound.get(sid), meta));
            armAutoName(sid, held);
          }
        }
```

- [ ] **Step 2: Проверить синтаксис**

Run: `node --check tg-hub/hub.mjs`
Expected: пустой вывод, код возврата 0. Демон не перезапускать.

- [ ] **Step 3: Проверить, что доставка ровно в двух местах**

Run: `grep -n "pending.take\|pending.put" tg-hub/hub.mjs`
Expected: `pending.take` — два вхождения (обработчик `switch:` и ветка регистрации), `pending.put` — два (первичное придерживание и возврат при неудачной доставке). Перечислить найденное в отчёте построчно.

- [ ] **Step 4: Проверить, что пустой `message_id` не породит цитату**

Run: `node tg-hub/chat-target-test.mjs`
Expected: PASS. В наборе уже есть утверждение «нет `message_id` → `{}`», которое и покрывает этот случай: ответ на доставленный так текст придёт без цитаты на запрос.

- [ ] **Step 5: Отложенная живая проверка**

Записать в отчёт как непроведённую: написать в чат без активной сессии, тапнуть `⏸ resume` — сессия поднимается и придержанный текст уходит в неё. Требует перезапуска демона.

- [ ] **Step 6: Commit (только если коммиты разрешены)**

```bash
git add tg-hub/hub.mjs
git commit -m "fix(hub): deliver held text when a session comes up, not only on switch"
```
