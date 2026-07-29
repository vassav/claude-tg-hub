# Allowlist для групповых чатов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Люди, внесённые владельцем в список, могут работать с ботом в групповых чатах; системный вывод и аппрувы при этом остаются в личке владельца.

**Architecture:** Два новых модуля с чистыми функциями (`access.mjs` — список и предикат гейта, `chat-target.mjs` — адресация ответов), которые тестируются напрямую, плюс проводка в `hub.mjs`: замена `owns`, три команды владельца и карта `lastInbound` (одна запись на сессию), из которой берутся адресат реплая и чат ask-карточки. Спека: [docs/specs/2026-07-29-group-allowlist.md](../specs/2026-07-29-group-allowlist.md).

**Tech Stack:** Node.js `.mjs`, zero-build, grammY ^1.30, тесты — обычные node-скрипты на `node:assert/strict` (фреймворка в проекте нет).

## Global Constraints

- **НЕ коммитить без явного запроса пользователя** (правило проекта из `CLAUDE.md`). Шаги «Commit» в каждой задаче выполнять только если пользователь попросил; иначе показать `git status`/`git diff` и ждать.
- Новых переменных окружения **не появляется**. `HUB_CHAT_ID` не трогать: он и дальше значит «куда идёт системный вывод», по умолчанию — личка владельца.
- Стиль существующего кода: компактный `.mjs`, комментарии по-английски, тексты в Telegram по-русски.
- Владелец (`HUB_OWNER_ID`) в `access.json` **не хранится** — он приходит из env и проверяется отдельно.
- **Номера строк во всех задачах указаны по исходному `hub.mjs` (до правок этого плана).** Задачи 3 и 5 добавляют строки выше по файлу, поэтому в задачах 4-6 ищи место по приведённому фрагменту кода, а не по номеру.
- Файл списка: `~/.claude/channels/hub/access.json`, рядом с `registry.json`. Запись атомарная (tmp → fsync → rename), чтение отказоустойчивое (ENOENT → пусто, битый JSON → бэкап `.corrupt-<ts>` и пустой список).
- Рестарт демона (нужен в задачах 3-6, чтобы правки в `hub.mjs` вступили в силу) — этой командой; живые сессии переподключаются сами за 2 с:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'hub\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'"  | Where-Object { $_.CommandLine -match 'hub\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 700
$cmd = 'cmd /c ""C:\Program Files\nodejs\node.exe" d:/Projects/vassav/claude-tg-hub/tg-hub/hub.mjs > d:\Projects\vassav\claude-tg-hub\tg-hub\hub-daemon.log 2>&1"'
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = 'd:\Projects\vassav\claude-tg-hub' }
Start-Sleep -Seconds 3
Get-Content d:\Projects\vassav\claude-tg-hub\tg-hub\hub-daemon.log -Tail 5
```

- **Отклонение от спеки, принятое на этапе плана:** вместо устаревшего `reply_to_message_id` используется `reply_parameters: { message_id, allow_sending_without_reply: true }` (Bot API 7.0+, поддержан grammY 1.30). Флаг `allow_sending_without_reply` заставляет Telegram отправить сообщение обычным, а не вернуть ошибку, если процитированное сообщение удалили — поэтому третья ступень фолбэка в `sendTg`, описанная в §4а спеки, не нужна и не делается.

---

### Task 1: `access.mjs` — список доступа и предикат гейта

**Files:**
- Create: `tg-hub/access.mjs`
- Test: `tg-hub/access-test.mjs`

**Interfaces:**
- Consumes: ничего (первая задача).
- Produces:
  - `roleOf(id) → 'owner' | null`
  - `add(id, name, by) → boolean` (false, если уже в списке)
  - `remove(id) → boolean`
  - `list() → [{ id, name, role, added, by }]`
  - `reload() → void`
  - `canUse({ userId, chatType, isBot }, { owner }) → boolean`
  - `parseTarget(arg, replyFrom) → { id, name } | null`

- [ ] **Step 1: Написать падающий тест**

```js
// tg-hub/access-test.mjs
// Unit test for access.mjs — no network, no Telegram. Redirects HOME/USERPROFILE to a
// temp dir BEFORE importing the module, so the real ~/.claude/channels/hub is untouched.
// Run from repo root:  node tg-hub/access-test.mjs
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(join(tmpdir(), 'access-test-'));
process.env.HOME = HOME; process.env.USERPROFILE = HOME;   // must happen BEFORE the import below
const CFG = join(HOME, '.claude', 'channels', 'hub');

const access = await import('./access.mjs');
let n = 0; const ok = m => { n++; console.log('  ✓', m); };

// 1. пустой старт — файла нет
assert.equal(access.roleOf('123'), null);
assert.deepEqual(access.list(), []);
ok('пустой старт: файла нет, ошибок нет');

// 2. add
assert.equal(access.add('123', 'ivan', '300447655'), true);
assert.equal(access.roleOf('123'), 'owner');
assert.equal(access.add('123', 'ivan', '300447655'), false);      // повторное добавление
const [u] = access.list();
assert.equal(u.id, '123'); assert.equal(u.name, 'ivan'); assert.equal(u.by, '300447655');
assert.ok(u.added, 'added — ISO-таймстамп');
ok('add: роль, имя, by, added; повтор → false');

// 3. персист
access.reload();
assert.equal(access.roleOf('123'), 'owner');
ok('персист переживает reload()');

// 4. remove
assert.equal(access.remove('123'), true);
assert.equal(access.remove('123'), false);
access.reload();
assert.equal(access.roleOf('123'), null);
ok('remove: удаляет в памяти и на диске');

// 5. битый JSON
access.add('777', 'x', '1');
writeFileSync(join(CFG, 'access.json'), '{ not json');
access.reload();
assert.equal(access.roleOf('777'), null);
assert.ok(readdirSync(CFG).some(f => f.startsWith('access.json.corrupt-')), 'бэкап создан');
ok('битый JSON: бэкап создан, список пуст, исключения нет');

// 6. canUse — таблица гейта из §2 спеки
const OWNER = '300447655';
access.add('123', 'ivan', OWNER);
const can = (userId, chatType, isBot = false) => access.canUse({ userId, chatType, isBot }, { owner: OWNER });
assert.equal(can(OWNER, 'private'), true, 'владелец в личке');
assert.equal(can(OWNER, 'supergroup'), true, 'владелец в группе');
assert.equal(can('123', 'group'), true, 'списочник в группе');
assert.equal(can('123', 'supergroup'), true, 'списочник в супергруппе');
assert.equal(can('123', 'private'), false, 'списочник в личке — нельзя');
assert.equal(can('999', 'group'), false, 'чужак в группе');
assert.equal(can('123', 'group', true), false, 'бот');
access.remove('123');
assert.equal(can('123', 'group'), false, 'пустой список — не проходит никто, кроме владельца');
assert.equal(can(OWNER, 'private'), true);
ok('canUse: таблица гейта');

// 7. parseTarget
assert.deepEqual(access.parseTarget('', { id: 55, username: 'vasya' }), { id: '55', name: 'vasya' });
assert.deepEqual(access.parseTarget('', { id: 55, first_name: 'Вася' }), { id: '55', name: 'Вася' });
assert.deepEqual(access.parseTarget('42 Петя', null), { id: '42', name: 'Петя' });
assert.deepEqual(access.parseTarget('42', null), { id: '42', name: '42' });
assert.equal(access.parseTarget('не число', null), null);
assert.equal(access.parseTarget('', null), null);
ok('parseTarget: реплай, "<id> имя", "<id>", мусор');

console.log(`\n✅ access-test: ${n} групп проверок пройдено`);
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node tg-hub/access-test.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND: Cannot find module '.../tg-hub/access.mjs'`

- [ ] **Step 3: Написать модуль**

```js
// tg-hub/access.mjs
// Access list: who — besides the owner — may drive the bot from a group chat.
// The owner comes from env (HUB_OWNER_ID) and is NEVER stored here; this file holds
// only the people the owner let in. Format and durability mirror registry.json:
// atomic write (tmp -> fsync -> rename), tolerant read (missing = empty, corrupt =
// backed up and empty), so a broken file degrades to "owner only", never to "open".
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';

const DIR = join(homedir(), '.claude', 'channels', 'hub');
const FILE = join(DIR, 'access.json');
const users = new Map();   // id(string) -> { id, name, role, added, by }

export function reload() {
  users.clear();
  let raw;
  try { raw = readFileSync(FILE, 'utf8'); }
  catch (e) { if (e?.code !== 'ENOENT') console.error('[access] read failed:', e?.message); return; }
  try {
    for (const [id, u] of Object.entries(JSON.parse(raw).users || {})) users.set(String(id), { ...u, id: String(id) });
  } catch {
    try { renameSync(FILE, FILE + '.corrupt-' + Date.now()); } catch {}
    console.error('[access] access.json corrupt — backed up, starting empty');
  }
}
function save() {
  try {
    mkdirSync(DIR, { recursive: true });
    const data = JSON.stringify({ version: 1, users: Object.fromEntries(users) }, null, 2);
    const tmp = FILE + '.tmp';
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, FILE);
  } catch (e) { console.error('[access] save failed:', e?.message); }
}

export const roleOf = id => users.get(String(id))?.role || null;
export const list = () => [...users.values()];
export function add(id, name, by) {
  const key = String(id || '');
  if (!key || users.has(key)) return false;
  users.set(key, { id: key, name: String(name || key), role: 'owner', added: new Date().toISOString(), by: String(by || '') });
  save();
  return true;
}
export function remove(id) {
  const ok = users.delete(String(id || ''));
  if (ok) save();
  return ok;
}

// The gate. Owner passes anywhere (DM included). Anyone on the list passes in ANY
// group chat but never in a DM — DMs with the bot stay owner-only.
export function canUse({ userId, chatType, isBot }, { owner }) {
  if (isBot) return false;
  if (String(userId) === String(owner)) return true;
  return chatType !== 'private' && !!roleOf(userId);
}

// `/allow` target: the quoted message's author if the command was a reply, else the
// "<id> [name]" typed inline. Bot API can't resolve @username -> id, so a bare nick
// is deliberately NOT accepted.
export function parseTarget(arg, replyFrom) {
  if (replyFrom?.id) return { id: String(replyFrom.id), name: String(replyFrom.username || replyFrom.first_name || replyFrom.id) };
  const m = /^(\d+)(?:\s+([\s\S]+))?$/.exec(String(arg || '').trim());
  return m ? { id: m[1], name: (m[2] || m[1]).trim() } : null;
}

reload();
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `node tg-hub/access-test.mjs`
Expected: PASS — семь строк `✓` и `✅ access-test: 7 групп проверок пройдено`

- [ ] **Step 5: Commit (только по явному запросу пользователя)**

```bash
git add tg-hub/access.mjs tg-hub/access-test.mjs
git commit -m "feat(hub): access list module — allowlist storage + gate predicate"
```

---

### Task 2: `chat-target.mjs` — адресация ответов и карточек

**Files:**
- Create: `tg-hub/chat-target.mjs`
- Test: `tg-hub/chat-target-test.mjs`

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `isGroup(chatId) → boolean`
  - `replyExtra(last, chatId) → {} | { reply_parameters: { message_id: number, allow_sending_without_reply: true } }`, где `last` — запись `lastInbound` вида `{ chat_id, message_id, user }` (Task 5)
  - `askChatFor(last, homeChat) → string`

- [ ] **Step 1: Написать падающий тест**

```js
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
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node tg-hub/chat-target-test.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND: Cannot find module '.../tg-hub/chat-target.mjs'`

- [ ] **Step 3: Написать модуль**

```js
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
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `node tg-hub/chat-target-test.mjs`
Expected: PASS — три строки `✓` и `✅ chat-target-test: 3 групп проверок пройдено`

- [ ] **Step 5: Commit (только по явному запросу пользователя)**

```bash
git add tg-hub/chat-target.mjs tg-hub/chat-target-test.mjs
git commit -m "feat(hub): chat-target helpers — reply attribution + ask card address"
```

---

### Task 3: Гейт в `hub.mjs` — `owns` через `access.canUse`, `/id` для групп

**Files:**
- Modify: `tg-hub/hub.mjs:26` (импорт), `tg-hub/hub.mjs:677-686` (гейт и `/id`)

**Interfaces:**
- Consumes: `access.canUse`, `access.roleOf` (Task 1).
- Produces: `owns(ctx) → boolean` — гейт, которым уже пользуются все существующие обработчики (`bot.command('sessions'|'projects'|…)`, `callback_query:data`, `message:text`, `:file`); их править не нужно.

- [ ] **Step 1: Добавить импорт**

В `tg-hub/hub.mjs` после строки 26 (`import { askOf } from './panel/ask.mjs';`):

```js
import * as access from './access.mjs';
```

- [ ] **Step 2: Заменить гейт**

Заменить строки 677-681 целиком:

```js
// ── Telegram ─────────────────────────────────────────────────────────────────
// Access gate: the owner (in any chat, DM included) OR anyone on the access list —
// but only from a GROUP chat. DMs with the bot stay owner-only. See access.mjs.
const owns = ctx => access.canUse(
  { userId: ctx.from?.id, chatType: ctx.chat?.type, isBot: ctx.from?.is_bot },
  { owner: OWNER });
```

Прежняя клауза `String(ctx.chat?.id) === CHAT` уходит: она пускала в домашний чат кого угодно. При незаданном `HUB_CHAT_ID` (текущее состояние `.env`) это ничего не меняет — `CHAT === OWNER`, и клауза лишь дублировала проверку на владельца.

- [ ] **Step 3: Открыть `/id` для групповых чатов**

Заменить строку 686:

```js
// Discover a chat's id. Open to everyone in a GROUP (it reveals only the caller's own
// id and the chat's) — that's how a newcomer can hand the owner their id. In a DM it
// stays owner-only, like every other DM interaction.
bot.command('id', async ctx => {
  if (ctx.chat?.type === 'private' && String(ctx.from?.id) !== OWNER) return;
  await ctx.reply(`chat_id: ${ctx.chat.id}\ntype: ${ctx.chat.type}\nyour user_id: ${ctx.from?.id}`);
});
```

- [ ] **Step 4: Проверить синтаксис**

Run: `node --check tg-hub/hub.mjs`
Expected: пустой вывод, код возврата 0

- [ ] **Step 5: Перезапустить демон и убедиться, что он поднялся**

Run: команду рестарта из «Global Constraints»
Expected: в хвосте лога `[hub] IPC on 127.0.0.1:8799` и `[hub] polling as @my_local_claud_bot; owner=300447655; home chat=300447655 (owner DM)`; строк с `[access]` нет (файла списка ещё нет — это норма)

- [ ] **Step 6: Проверить вживую, что владелец не потерял доступ**

В личке боту отправить `/sessions`.
Expected: бот отвечает списком сессий (как раньше).

- [ ] **Step 7: Commit (только по явному запросу пользователя)**

```bash
git add tg-hub/hub.mjs
git commit -m "feat(hub): gate access through the allowlist; open /id in groups"
```

---

### Task 4: Команды `/allow`, `/deny`, `/who`

**Files:**
- Modify: `tg-hub/hub.mjs` — вставка сразу после обработчика `/id` (Task 3)

**Interfaces:**
- Consumes: `access.add`, `access.remove`, `access.list`, `access.parseTarget` (Task 1); `owns` (Task 3).
- Produces: ничего для следующих задач.

- [ ] **Step 1: Добавить три команды**

Вставить в `tg-hub/hub.mjs` сразу после обработчика `bot.command('id', …)`:

```js
// ── access list management (owner only) ──────────────────────────────────────
// Managing the list is owner-only even though listed people otherwise have full
// rights: a list that can extend itself stops being a list. Bot API cannot turn an
// @username into a user_id, so a target is either the quoted message's author or an
// explicit numeric id.
const isOwner = ctx => String(ctx.from?.id) === OWNER;
const ALLOW_USAGE = 'usage: /allow <user_id> [имя]\nили ответь этой командой на сообщение человека';

bot.command('allow', async ctx => {
  if (!isOwner(ctx)) { if (owns(ctx)) await ctx.reply('только владелец может менять список'); return; }
  const t = access.parseTarget(ctx.match, ctx.message?.reply_to_message?.from);
  if (!t) { await ctx.reply(ALLOW_USAGE); return; }
  if (t.id === OWNER) { await ctx.reply('это ты — владелец, тебе список не нужен'); return; }
  await ctx.reply(access.add(t.id, t.name, ctx.from.id)
    ? `✅ ${t.name} (${t.id}) добавлен — может писать боту в групповых чатах`
    : `${t.name} (${t.id}) уже в списке`);
});

bot.command('deny', async ctx => {
  if (!isOwner(ctx)) { if (owns(ctx)) await ctx.reply('только владелец может менять список'); return; }
  const t = access.parseTarget(ctx.match, ctx.message?.reply_to_message?.from);
  if (!t) { await ctx.reply(ALLOW_USAGE.replace(/allow/g, 'deny')); return; }
  await ctx.reply(access.remove(t.id) ? `🚫 ${t.name} (${t.id}) удалён из списка` : `${t.name} (${t.id}) в списке и не был`);
});

bot.command('who', async ctx => {
  if (!owns(ctx)) return;
  const rows = access.list().map(u => `• ${u.name} (${u.id}) — добавил ${u.by || '?'}, ${String(u.added || '').slice(0, 10)}`);
  await ctx.reply([`👤 владелец: ${OWNER}`, ...(rows.length ? rows : ['список пуст — /allow реплаем на сообщение человека'])].join('\n'));
});
```

- [ ] **Step 2: Проверить синтаксис**

Run: `node --check tg-hub/hub.mjs`
Expected: пустой вывод, код возврата 0

- [ ] **Step 3: Перезапустить демон**

Run: команду рестарта из «Global Constraints»
Expected: `[hub] polling as @…; owner=300447655; home chat=300447655 (owner DM)`

- [ ] **Step 4: Проверить вживую**

В личке боту: `/who` → «👤 владелец: 300447655» и «список пуст…».
Там же: `/allow 999000111 Тест` → «✅ Тест (999000111) добавлен…»; `/who` → строка с ним; `/deny 999000111` → «🚫 … удалён»; `/allow` без аргументов → подсказка по формату.

Проверить, что файл появился:

Run: `cat ~/.claude/channels/hub/access.json`
Expected: валидный JSON с `"version": 1` и объектом `users`

- [ ] **Step 5: Commit (только по явному запросу пользователя)**

```bash
git add tg-hub/hub.mjs
git commit -m "feat(hub): /allow, /deny, /who — owner-managed access list"
```

---

### Task 5: `lastInbound` и атрибуция ответов в группе

**Files:**
- Modify: `tg-hub/hub.mjs:72` (новая карта), `:258-270` (`sendTg`), `:359-366` (`routeTo`), `:593` (ветка `t:'reply'`)

**Interfaces:**
- Consumes: `replyExtra` (Task 2).
- Produces: `lastInbound: Map<sessionId, { chat_id, message_id, user }>` — карта, из которой Task 6 берёт адрес ask-карточки.

- [ ] **Step 1: Добавить импорт и карту**

К импорту из Task 3 добавить строку:

```js
import { replyExtra, askChatFor } from './chat-target.mjs';
```

Рядом с `const outMsgToSession = new Map();` (строка 72) добавить:

```js
const lastInbound = new Map();  // sessionId -> { chat_id, message_id, user } of the message that most recently drove it
```

- [ ] **Step 2: Заполнять карту в `routeTo`**

Заменить тело `routeTo` (строки 359-366):

```js
async function routeTo(ctx, id, body) {
  const meta = {
    chat_id: String(ctx.chat.id), message_id: String(ctx.message.message_id),
    user: ctx.from.username || String(ctx.from.id), user_id: String(ctx.from.id), ts: new Date().toISOString(),
  };
  if (!sendToSession(id, { t: 'inbound', content: body, meta })) { await ctx.reply('⚠️ session not connected'); return; }
  // A session runs one turn at a time, so "who wrote to it last" is who its next
  // output answers — that's what we attribute replies and ask cards to.
  lastInbound.set(id, { chat_id: meta.chat_id, message_id: meta.message_id, user: meta.user });
  armAutoName(id, body); // first request → name the session (model set_title, else slug fallback)
}
```

- [ ] **Step 3: Научить `sendTg` ставить параметры на ПЕРВЫЙ кусок**

`extra` кладётся на последний кусок (там клавиатура), а цитата должна висеть на первом. Заменить сигнатуру и построение `opts` в `sendTg` (строки 258-262):

```js
async function sendTg(chatId, text, sid, extra = {}, firstExtra = {}) {
  const parts = chunkText(String(text ?? ''));
  let last = null;
  for (let i = 0; i < parts.length; i++) {
    // keyboard only on the last chunk; reply-quote only on the first
    const opts = { link_preview_options: { is_disabled: true }, ...(i === 0 ? firstExtra : {}), ...(i === parts.length - 1 ? extra : {}) };
```

Остальное тело `sendTg` (строки 263-269) не трогать.

- [ ] **Step 4: Цитировать автора в ветке `t:'reply'`**

Заменить строку 593:

```js
      } else if (m.t === 'reply') {
        const to = m.chat_id || CHAT;
        sendTg(to, `[${labelOf(m.sessionId)}]\n${m.text}`, m.sessionId, {}, replyExtra(lastInbound.get(m.sessionId), to));
```

- [ ] **Step 5: Проверить синтаксис и перезапустить**

Run: `node --check tg-hub/hub.mjs`, затем команду рестарта из «Global Constraints»
Expected: `node --check` без вывода; в логе `[hub] polling as @…`

- [ ] **Step 6: Проверить вживую**

В личке боту написать любой запрос к активной сессии.
Expected: ответ приходит как раньше, **без** цитаты (личка — не группа).

- [ ] **Step 7: Commit (только по явному запросу пользователя)**

```bash
git add tg-hub/hub.mjs
git commit -m "feat(hub): attribute session replies to the asker in group chats"
```

---

### Task 6: Ask-карточки уходят в чат-источник

**Files:**
- Modify: `tg-hub/hub.mjs:596-599` (создание карточки), `:610-613` (`approval_cancel`), `:805-811` (отмена), `:829-846` (перерисовка/финал)

**Interfaces:**
- Consumes: `askChatFor` (Task 2), `lastInbound` (Task 5).
- Produces: поле `chatId` в записи `askState`; `permMsg` начинает хранить `{ mid, chat }` вместо голого `message_id`.

- [ ] **Step 1: Запоминать чат карточки при создании**

Заменить строки 596-607 (обе ветки `permission_request`):

```js
        if (m.ask) {                                   // stream path: structural questions -> option buttons
          // The card belongs where the question came from: a person asking from a group
          // must be able to answer it there. Approvals below stay in CHAT (owner's DM).
          const askChat = askChatFor(lastInbound.get(m.sessionId), CHAT);
          askState.set(m.request_id, { sessionId: m.sessionId, qs: m.ask, picks: m.ask.questions.map(() => []), cur: 0, chatId: askChat });
          const c = askCard(m.request_id);
          sendTg(askChat, c.text, m.sessionId, { reply_markup: c.kb }).then(sent => { if (sent?.message_id) permMsg.set(m.request_id, { mid: sent.message_id, chat: askChat }); });
        } else {                                       // channels (or any other tool): Allow/Deny as before
          const kb = new InlineKeyboard().text('✅ Allow', `perm:${m.request_id}:allow`).text('❌ Deny', `perm:${m.request_id}:deny`).row();
          // …plus the engine's own "don't ask again" offers (stream sessions only)
          (m.suggestions || []).slice(0, 4).forEach((s, i) => kb.text(btnLabel(suggestLabel(s)), `psug:${m.request_id}:${i}`).row());
          const pv = (m.input_preview && askDigest(m.tool_name, m.input_preview)) || m.input_preview;
          const body = `🔐 [${labelOf(m.sessionId)}] ${m.tool_name}` + (m.description ? `\n${m.description}` : '') + (pv ? `\n${pv}` : '');
          sendTg(CHAT, body, m.sessionId, { reply_markup: kb }).then(sent => { if (sent?.message_id) permMsg.set(m.request_id, { mid: sent.message_id, chat: CHAT }); });
        }
```

- [ ] **Step 2: Починить `approval_cancel` под новую форму `permMsg`**

Заменить строки 610-613:

```js
        pendingPerm.delete(m.request_id); askState.delete(m.request_id);
        const card = permMsg.get(m.request_id); permMsg.delete(m.request_id);
        if (card) bot.api.editMessageText(card.chat, card.mid, `🔐 [${labelOf(m.sessionId)}] ${m.tool || 'tool'} — ✅ обработано в панели`).catch(() => {});
```

- [ ] **Step 3: Отмена ask-карточки — редактировать в её чате**

Заменить строку 811:

```js
    await editTg(st.chatId, ctx.callbackQuery.message.message_id, `❓ [${labelOf(st.sessionId)}] — ❌ отменено`);
```

- [ ] **Step 4: Перерисовка и финальное summary — там же**

Заменить строку 833:

```js
        await editTg(st.chatId, mid, c.text, { reply_markup: c.kb });
```

строку 841:

```js
      await editTg(st.chatId, mid, c.text, { reply_markup: c.kb });
```

и строку 846:

```js
    await editTg(st.chatId, mid, askSummary(st));
```

- [ ] **Step 5: Проверить, что других чтений `permMsg` не осталось**

Run: `grep -n "permMsg" tg-hub/hub.mjs`
Expected: только `new Map()`, две записи `.set(…, { mid, chat })`, чтение в `approval_cancel` и три `.delete(…)` — ни одного места, где значение используется как число

- [ ] **Step 6: Проверить синтаксис и перезапустить**

Run: `node --check tg-hub/hub.mjs`, затем команду рестарта из «Global Constraints»
Expected: `node --check` без вывода; в логе `[hub] polling as @…`

- [ ] **Step 7: Проверить вживую, что личка не сломалась**

Спровоцировать аппрув из личной сессии (например, попросить сессию выполнить команду, требующую подтверждения).
Expected: карточка `🔐` приходит в личку и кнопки работают, как раньше.

- [ ] **Step 8: Commit (только по явному запросу пользователя)**

```bash
git add tg-hub/hub.mjs
git commit -m "feat(hub): route AskUserQuestion cards back to the chat that asked"
```

---

### Task 7: Живая проверка в группе и документация

**Files:**
- Modify: `README.md` (раздел «Бот в группе» ~строки 154-168, таблица команд ~строка 80, фраза про доступ ~строка 85)
- Modify: `CLAUDE.md` (раздел «Статус и как продолжать»)

**Interfaces:**
- Consumes: всё предыдущее.
- Produces: ничего.

- [ ] **Step 1: Прогнать оба юнит-теста**

Run: `node tg-hub/access-test.mjs && node tg-hub/chat-target-test.mjs`
Expected: обе строки `✅ …пройдено`

- [ ] **Step 2: Живая проверка в группе (сценарий из §7 спеки)**

Подготовка: создать/взять группу, добавить туда бота **администратором** (иначе privacy mode отдаст ему только команды и упоминания), пригласить второй аккаунт.

Проверить по шагам:
1. второй аккаунт пишет в группу до `/allow` → бот молчит;
2. он же пишет боту в личку → бот молчит;
3. владелец отвечает `/allow` реплаем на его сообщение → «✅ … добавлен»;
4. тот же человек пишет в группу снова → ответ приходит **в группу, цитатой на его сообщение**;
5. задача из группы упирается в аппрув → карточка `🔐` приходит **владельцу в личку**, в группе её нет;
6. модель задаёт AskUserQuestion по задаче из группы → карточка с кнопками **в группе**, кнопки работают;
7. владелец делает `/deny` → человек снова не проходит.

- [ ] **Step 3: Обновить README — раздел «Бот в группе»**

Заменить существующий раздел (сейчас описывает только сценарий «`HUB_CHAT_ID` = весь вывод в группу») на два сценария:

```markdown
## Бот в группе

Два независимых сценария — их можно использовать порознь.

**1. Несколько человек работают с ботом в группе (список доступа).** Вывод остаётся в
личке владельца, `.env` не меняется.

1. Добавь бота в группу и сделай его **администратором** — иначе Telegram (privacy mode)
   отдаст ему только команды, реплаи на его сообщения и упоминания.
2. Пусть человек что-нибудь напишет в группе. Ответь на его сообщение командой `/allow` —
   бот возьмёт user_id из цитаты. Или `/allow <user_id> [имя]`, если id уже известен
   (человек может узнать свой через `/id` в группе).
3. Всё: его сообщения в **любом** групповом чате, где есть бот, теперь обрабатываются.
   Рестарт хаба не нужен, список читается горячо.

`/who` — посмотреть список, `/deny` — убрать. Менять список может только владелец.

Что при этом НЕ уезжает в группу: уведомления хаба и карточки аппрувов инструментов —
они по-прежнему приходят владельцу в личку, поэтому нажать ✅ на `Bash(rm -rf …)`
участник группы не может: кнопки перед ним просто нет. В группу уходят ответы сессий
(цитатой на сообщение автора) и карточки AskUserQuestion по задачам этой группы.

Личка с ботом остаётся только у владельца: человек из списка, написавший боту в ЛС,
доступа не получит.

⚠️ Человек из списка может позвать бота в любую свою группу. Управлять ботом посторонние
там не смогут, но увидят ответы — а в них содержимое твоих проектов. Добавляй в список
только тех, кому доверяешь эти данные.

**2. Вести весь вывод бота в группе вместо лички.** Задать `HUB_CHAT_ID=-100…` и
перезапустить хаб — тогда уведомления и аппрувы уходят туда. Сценарий для «личного» чата,
где ты один; в общей группе не используй — аппрувы станут видны и доступны всем из списка.
```

- [ ] **Step 4: Обновить README — таблица команд и фраза про доступ**

В таблицу команд (около строки 80) добавить строки:

```markdown
| `/allow` | (владелец) добавить человека в список доступа — реплаем на его сообщение или `/allow <id> [имя]` |
| `/deny` | (владелец) убрать человека из списка |
| `/who` | показать список доступа |
```

Строку про `/id` заменить на:

```markdown
| `/id` | показать `chat_id` текущего чата и свой `user_id` (в группе доступна всем) |
```

Фразу про доступ (около строки 85) заменить на:

```markdown
Доступ — у `HUB_OWNER_ID` (в любом чате) и у людей из списка `~/.claude/channels/hub/access.json`
(только в групповых чатах; список ведётся командами `/allow` и `/deny`). См. «Бот в группе».
```

Предупреждение около строки 168 («любой её участник может управлять ботом и подтверждать аппрувы») удалить — после этой правки оно неверно по обоим пунктам.

- [ ] **Step 5: Обновить CLAUDE.md**

В разделе «Статус и как продолжать» в абзац «Сделано» добавить:

```markdown
**многопользовательский доступ** (список `access.json` + `/allow`/`/deny`/`/who`: люди из
списка работают с ботом в групповых чатах, вывод и аппрувы остаются в личке владельца —
см. [`docs/specs/2026-07-29-group-allowlist.md`](docs/specs/2026-07-29-group-allowlist.md)),
```

и убрать «многопользовательский доступ» из перечисления «Дальше (не сделано)».

- [ ] **Step 6: Commit (только по явному запросу пользователя)**

```bash
git add README.md CLAUDE.md
git commit -m "docs: group allowlist — setup, commands, access model"
```
