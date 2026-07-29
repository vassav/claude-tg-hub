# `/browser` в пульте + `@browser` из TG — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подключение claude-in-chrome MCP к stream-сессии из Telegram: кнопка `🧭 браузер` в пульте + авторазворачивание `@browser` во входящем тексте.

**Architecture:** Общая логика — в `createCommands` (panel/commands.mjs), уже используемом интерпозером и headless. Регистрация — `control_request{mcp_set_servers}` с картой `{...база, 'claude-in-chrome': {type:'stdio', command:<движок>, args:[...,'--claude-in-chrome-mcp']}}`. Интерпозер дополнительно со-владеет картой с панелью (сниффинг/мерж/уважение явного отключения). Спека: [docs/specs/2026-07-27-tg-browser-command.md](../specs/2026-07-27-tg-browser-command.md).

**Tech Stack:** Node.js `.mjs`, zero-build; смоук-тесты по образцу `smoke-suggest.mjs` (mock-hub TCP + реальный интерпозер + мок-движок).

## Global Constraints

- НЕ коммитить без явного запроса пользователя (правило проекта).
- Стиль: существующий `.mjs`-код проекта (компактный, комментарии по-английски, ответы в TG по-русски).
- Тексты TG-ответов — ровно как в спеке: «🧭 браузер подключён — пиши задачу обычным текстом», «🧭 браузер уже подключён», «⚠️ не удалось подключить браузер…».
- Таймаут ожидания ответа движка — существующие 8 с из `issue()`.

---

### Task 1: Мок-движок + смоук-скелет (падающий тест)

**Files:**
- Create: `tg-hub/panel/mock-engine-browser.mjs`
- Create: `tg-hub/panel/smoke-browser.mjs`

**Interfaces:**
- Produces: mock-движок stream-json — пишет полученные `mcp_set_servers.servers` построчно (JSON) в файл `$MOCKENG_OUT`, эхоит user-turn'ы как `assistant` `ECHO:<text>`; смоук — mock-hub на TCP `127.0.0.1:8794`, спавнит `interposer.mjs <node> <mock-engine-browser.mjs>`, держит его stdin/stdout как «панель».

- [ ] **Step 1: Написать мок-движок**

```js
// tg-hub/panel/mock-engine-browser.mjs
// Mock stream-json engine for smoke-browser: records mcp_set_servers maps to
// $MOCKENG_OUT (one JSON line per request), echoes injected user turns as
// assistant text so the smoke can assert what actually reached the engine.
import { appendFileSync } from 'node:fs';
const OUT = process.env.MOCKENG_OUT;
const send = o => process.stdout.write(JSON.stringify(o) + '\n');
send({ type: 'system', subtype: 'init', session_id: process.env.MOCKENG_SID || 'mock-sid', cwd: process.cwd() });
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) handle(l); } });
function handle(line) {
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o.type === 'control_request') {
    if (o.request?.subtype === 'mcp_set_servers' && OUT) appendFileSync(OUT, JSON.stringify(o.request.servers || {}) + '\n');
    send({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
  } else if (o.type === 'user') {
    const t = (o.message?.content || []).map(b => b.text || '').join('');
    send({ type: 'assistant', session_id: 'mock-sid', message: { role: 'assistant', content: [{ type: 'text', text: 'ECHO:' + t }] } });
  }
}
```

- [ ] **Step 2: Написать смоук**

Каркас — как `smoke-suggest.mjs` (mock-hub TCP-сервер, verdict в конце), но движок мокнутый и панельная сторона — наши пайпы. Сценарий по шагам (каждый шаг ждёт своего условия, общий таймаут 30 с → FAIL):

```js
// tg-hub/panel/smoke-browser.mjs
// Smoke: /browser command + @browser expansion + host-map co-ownership.
// mock hub (TCP) + REAL interposer.mjs + mock engine. Run: node tg-hub/panel/smoke-browser.mjs
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8794, MOCKENG_OUT = join(tmpdir(), 'smoke-browser-maps-' + process.pid + '.jsonl');
rmSync(MOCKENG_OUT, { force: true });
const maps = () => { try { return readFileSync(MOCKENG_OUT, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const replies = []; let sock = null, child = null;
const failures = [];
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : '')); if (!cond) failures.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); } console.log('TIMEOUT waiting: ' + what); return false; }
const toHubSession = m => sock.write(JSON.stringify(m) + '\n');
const toPanelSide = o => child.stdin.write(JSON.stringify(o) + '\n');   // "extension -> engine" direction

const server = net.createServer(s => {
  sock = s; s.setEncoding('utf8'); let buf = '';
  s.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.t === 'reply') { replies.push(String(m.text || '')); console.log('[mockhub] REPLY:', JSON.stringify(String(m.text || '')).slice(0, 140)); }
    if (m.t === 'register') console.log('[mockhub] register', m.sessionId, m.kind);
  } });
});

server.listen(PORT, '127.0.0.1', async () => {
  const env = { ...process.env, HUB_PORT: String(PORT), HUB_TOKEN: 'smoke', PANEL_BRIDGE: '1', MOCKENG_OUT };
  child = spawn(process.execPath, [join(HERE, 'interposer.mjs'), process.execPath, join(HERE, 'mock-engine-browser.mjs')],
    { stdio: ['pipe', 'pipe', 'inherit'], env });
  child.stdout.on('data', () => {});   // panel side of the pipe — drained, unused

  // 1: bind the TG chat, plain echo round-trip
  await until(() => sock, 'register');
  toHubSession({ t: 'inbound', content: 'привет', meta: { chat_id: 'TEST' } });
  check('echo round-trip', await until(() => replies.some(r => r === 'ECHO:привет'), 'echo'));

  // 2: @browser in TG text -> registration first, then inject with instruction block
  toHubSession({ t: 'inbound', content: '@browser открой vc.ru', meta: { chat_id: 'TEST' } });
  check('enable confirmed', await until(() => replies.some(r => r.includes('браузер подключён')), 'подключён'));
  check('map has chrome', await until(() => maps().length === 1 && !!maps()[0]['claude-in-chrome'], 'map#1'),
    JSON.stringify(maps()[0] || null));
  check('bridge flag', (maps()[0]?.['claude-in-chrome']?.args || []).includes('--claude-in-chrome-mcp'));
  check('inject has hint+text', await until(() => replies.some(r => r.startsWith('ECHO:') && r.includes('browser_instruction') && r.includes('открой vc.ru') && !r.includes('@browser')), 'hinted echo'));

  // 3: repeat command -> "уже подключён", no extra mcp_set_servers
  toHubSession({ t: 'command', name: 'browser', chat_id: 'TEST' });
  check('already-on reply', await until(() => replies.some(r => r.includes('уже подключён')), 'уже'));
  check('no extra map', maps().length === 1, 'maps=' + maps().length);

  // 4: host update WITHOUT chrome -> augmented (our registration survives)
  toPanelSide({ type: 'control_request', request_id: 'host-1', request: { subtype: 'mcp_set_servers', servers: { mock: { type: 'stdio', command: 'x', args: [] } } } });
  check('augment', await until(() => maps().length === 2, 'map#2') && !!maps()[1]['claude-in-chrome'] && !!maps()[1].mock, JSON.stringify(maps()[1] || null));

  // 5: host enables chrome itself -> passthrough
  toPanelSide({ type: 'control_request', request_id: 'host-2', request: { subtype: 'mcp_set_servers', servers: { 'claude-in-chrome': { type: 'stdio', command: 'host', args: ['--claude-in-chrome-mcp'] } } } });
  check('host-enable passthrough', await until(() => maps().length === 3, 'map#3') && maps()[2]['claude-in-chrome']?.command === 'host');

  // 6: host explicit disable (had chrome -> dropped) -> respected, NOT augmented
  toPanelSide({ type: 'control_request', request_id: 'host-3', request: { subtype: 'mcp_set_servers', servers: {} } });
  check('disable respected', await until(() => maps().length === 4, 'map#4') && !maps()[3]['claude-in-chrome'], JSON.stringify(maps()[3] || null));

  // 7: /browser re-enables after the disable
  toHubSession({ t: 'command', name: 'browser', chat_id: 'TEST' });
  check('re-enable', await until(() => maps().length === 5, 'map#5') && !!maps()[4]['claude-in-chrome']);

  console.log('\n===== BROWSER SMOKE ===== ' + (failures.length ? 'FAIL: ' + failures.join(', ') : 'PASS'));
  try { child.kill(); } catch {}
  server.close();
  setTimeout(() => process.exit(failures.length ? 1 : 0), 300);
});
setTimeout(() => { console.log('GLOBAL TIMEOUT'); try { child?.kill(); } catch {}; process.exit(1); }, 60000);
```

- [ ] **Step 3: Запустить — убедиться, что падает по нужной причине**

Run: `node tg-hub/panel/smoke-browser.mjs`
Expected: `echo round-trip` PASS (это уже работает), дальше FAIL/TIMEOUT на «enable confirmed» — фичи ещё нет. Если падает раньше (register/echo) — чинить скелет, не фичу.

---

### Task 2: `commands.mjs` — конфиг моста, `case 'browser'`, разбор ответа, `injectBrowser`

**Files:**
- Modify: `tg-hub/panel/commands.mjs`

**Interfaces:**
- Produces (для Task 3/4):
  - `export function chromeBridgeConfig(exe, engineArgs)` → `{type:'stdio', command, args}`; если `engineArgs[0]` кончается на `.js` — включает его первым аргументом (форма `node cli.js`).
  - `export const BROWSER_MENTION = /@browser\b/` и `export const BROWSER_HINT` (инструкционный блок).
  - `createCommands` принимает новый НЕОБЯЗАТЕЛЬНЫЙ dep `browser: { bridge: () => cfg, servers: () => map, enabled: () => bool, setEnabled: (v) => void }` (все — функции: у интерпозера значения поздние).
  - Возвращаемый объект получает `injectBrowser(text, chat_id)`.

- [ ] **Step 1: Экспорты-хелперы** (после импортов, перед `fmtK`)

```js
// Chrome MCP bridge = the engine binary itself with a flag — exactly the config
// VS Code's ensureChromeMcpEnabled registers (validated: docs/specs/2026-07-27).
export function chromeBridgeConfig(exe, engineArgs) {
  const a = engineArgs?.[0];
  return { type: 'stdio', command: exe, args: [...(a && a.endsWith('.js') ? [a] : []), '--claude-in-chrome-mcp'] };
}
export const BROWSER_MENTION = /@browser\b/;
export const BROWSER_HINT = '<browser_instruction>К сессии подключён MCP-сервер claude-in-chrome '
  + '(инструменты mcp__claude-in-chrome__*, deferred). Подгрузи нужные ОДНИМ вызовом ToolSearch '
  + '(select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,'
  + 'mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__read_page — плюс нужные по задаче) '
  + 'и начни с tabs_context_mcp.</browser_instruction>';
```

- [ ] **Step 2: Расширить `createCommands`**

Сигнатура: `export function createCommands({ toEngine, sendHub, sessionId, owner, injectUser, browser })`.

`issue()` — добавить необязательный `done`-колбэк (нужен `@browser`-потоку, чтобы заинжектить текст и при таймауте):

```js
  function issue(subtype, extra, kind, chat_id, done) {
    const request_id = 'tg_' + randomUUID().slice(0, 12);
    const timer = setTimeout(() => { if (pending.delete(request_id)) { replyTo(chat_id, '⚠️ сессия не ответила на запрос'); done?.(false); } }, 8000);
    pending.set(request_id, { kind, chat_id, timer, done });
    toEngine({ type: 'control_request', request_id, request: { subtype, ...(extra || {}) } });
  }
  // /browser: register claude-in-chrome via mcp_set_servers (REPLACES the whole
  // dynamic server set — caller supplies the base map to merge into).
  function enableBrowser(chat_id, done) {
    if (!browser) { replyTo(chat_id, '⚠️ браузер недоступен в этом режиме'); done?.(false); return; }
    const servers = { ...(browser.servers() || {}), 'claude-in-chrome': browser.bridge() };
    issue('mcp_set_servers', { servers }, 'browser', chat_id, done);
  }
```

В `handle` — новый case (перед `default`):

```js
        case 'browser':
          if (browser?.enabled()) return replyTo(chat_id, '🧭 браузер уже подключён');
          return enableBrowser(chat_id);
```

В `onControlResponse` — ветка `browser` (после `usage`); учесть и `subtype:'error'`, и карту `errors` в ответе:

```js
      else if (pc.kind === 'browser') {
        const errMap = r.errors && Object.keys(r.errors).length ? Object.entries(r.errors).map(([k, v]) => `${k}: ${v}`).join('; ') : '';
        const err = o.response?.subtype === 'error' ? String(o.response.error || 'error') : errMap;
        if (!err) browser?.setEnabled(true);
        replyTo(pc.chat_id, err ? '⚠️ не удалось подключить браузер: ' + err : '🧭 браузер подключён — пиши задачу обычным текстом');
        pc.done?.(!err);
      }
```

В возвращаемый объект — `injectBrowser` (после `handle`):

```js
    // @browser in TG text: ensure the browser MCP is registered, then inject the
    // text with the mention replaced by an instruction block. On failure the raw
    // text is injected unchanged (the error already went to TG via the reply).
    injectBrowser(text, chat_id) {
      const withHint = (BROWSER_HINT + '\n\n' + text.replace(/@browser\b/g, '').trim()).trim();
      if (browser?.enabled()) return injectUser(withHint);
      enableBrowser(chat_id, ok => injectUser(ok ? withHint : text));
    },
```

- [ ] **Step 3: Прогнать смоук** — `node tg-hub/panel/smoke-browser.mjs`. Expected: шаги 2–3 всё ещё FAIL (интерпозер не передаёт dep `browser` и не зовёт `injectBrowser`) — это норма, идём дальше.

---

### Task 3: `interposer.mjs` — dep `browser`, `@browser` во входящих, со-владение картой

**Files:**
- Modify: `tg-hub/panel/interposer.mjs`

**Interfaces:**
- Consumes: `chromeBridgeConfig`, `BROWSER_MENTION`, `cmds.injectBrowser` из Task 2.
- Produces: протокольное поведение для смоука (Task 1, шаги 2–7).

- [ ] **Step 1: Импорт + состояние**

Импорт: `import { createCommands, chromeBridgeConfig, BROWSER_MENTION } from './commands.mjs';`

Рядом с `let hub = null, ...` (строка ~78):

```js
// browser MCP co-ownership with the panel: base = the panel's last dynamic-server
// map (chrome-less), flags track who enabled chrome and whether it is on now.
let hostServers = {}, hostHadChrome = false, browserOn = false;
```

- [ ] **Step 2: dep `browser` в `createCommands`** (строки ~128-131; `exe`/`rest` объявлены ниже по файлу — к моменту вызова инициализированы, поэтому все поля deps — функции)

```js
const cmds = createCommands({
  toEngine: obj => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) { log('ctl write err', String(e)); } },
  sendHub, sessionId: () => sessionId, owner: process.env.HUB_OWNER_ID || '', injectUser,
  browser: { bridge: () => chromeBridgeConfig(exe, rest), servers: () => hostServers,
    enabled: () => browserOn, setEnabled: v => { browserOn = v; } },
});
```

- [ ] **Step 3: `@browser` во входящих** — в `onHub`, ветка `inbound`:

```js
  if (m.t === 'inbound') {
    boundChatId = String(m.meta?.chat_id || boundChatId || '');
    const text = String(m.content ?? '');
    if (BROWSER_MENTION.test(text)) cmds.injectBrowser(text, boundChatId);
    else injectUser(text);
  }
```

- [ ] **Step 4: сниффинг/мерж карты в `onIn`** — в начало `onIn(o)` (до блока approvals):

```js
  // mcp_set_servers REPLACES the engine's whole dynamic-server set, and both we
  // and the panel send it. Track the panel's map as our merge base; after WE
  // enabled chrome, keep re-adding it to panel updates that lack it — but a map
  // where the panel ITSELF had chrome and dropped it is an explicit disable from
  // the panel UI: respect it.
  if (o.type === 'control_request' && o.request?.subtype === 'mcp_set_servers') {
    const servers = o.request.servers || {};
    const hasChrome = !!servers['claude-in-chrome'];
    const prevHostHadChrome = hostHadChrome;
    hostHadChrome = hasChrome;
    hostServers = { ...servers }; delete hostServers['claude-in-chrome'];
    if (hasChrome) { browserOn = true; return; }
    if (browserOn && prevHostHadChrome) { browserOn = false; log('panel disabled browser MCP'); return; }
    if (browserOn) return { ...o, request: { ...o.request, servers: { ...servers, 'claude-in-chrome': chromeBridgeConfig(exe, rest) } } };
    return;
  }
```

- [ ] **Step 5: поддержка ПОДМЕНЫ строки в `inForwarder`** — сейчас `onIn` умеет только DROP; научить форвардер принимать объект-замену:

```js
      if (!l.trim()) { child.stdin.write(l + '\n'); continue; }
      logLine('IN  >>', l);
      let o = null, drop = false, rewrite = null;
      try { o = JSON.parse(l); } catch {}
      if (o) { try { const r = onIn(o); if (r === DROP) drop = true; else if (r && typeof r === 'object') rewrite = JSON.stringify(r); } catch (e) { log('onIn err', String(e)); } }
      if (rewrite) log('REWRITE >>', rewrite.slice(0, 300));
      if (!drop) child.stdin.write((rewrite ?? l) + '\n');
```

- [ ] **Step 6: Прогнать смоук** — `node tg-hub/panel/smoke-browser.mjs`
Expected: `===== BROWSER SMOKE ===== PASS` (все 10 check'ов). Если нет — чинить по имени упавшего check'а.

---

### Task 4: `headless.mjs` — тот же dep + `@browser`

**Files:**
- Modify: `tg-hub/panel/headless.mjs`

**Interfaces:**
- Consumes: `chromeBridgeConfig`, `BROWSER_MENTION`, `cmds.injectBrowser` из Task 2. Панели нет → база серверов пустая, флаг локальный.

- [ ] **Step 1: Правки**

Импорт: `import { createCommands, chromeBridgeConfig, BROWSER_MENTION } from './commands.mjs';`

Строка ~85 (создание cmds):

```js
let browserOn = false;   // no panel here — the hub is the only writer of the dynamic set
const cmds = createCommands({ toEngine, sendHub, sessionId: SESSION_ID, owner: OWNER, injectUser,
  browser: { bridge: () => chromeBridgeConfig(exe, rest), servers: () => ({}),
    enabled: () => browserOn, setEnabled: v => { browserOn = v; } } });
```

Ветка `inbound` в `onHub`:

```js
  if (m.t === 'inbound') {
    boundChatId = String(m.meta?.chat_id || boundChatId || OWNER || '');
    const text = String(m.content ?? '');
    if (BROWSER_MENTION.test(text)) cmds.injectBrowser(text, boundChatId);
    else injectUser(text);
  }
```

- [ ] **Step 2: Синтакс-проверка** — `node --check tg-hub/panel/headless.mjs`
Expected: тишина (exit 0). Поведенческая проверка — e2e в Task 6.

---

### Task 5: `hub.mjs` — кнопка, regex, bot-команда

**Files:**
- Modify: `tg-hub/hub.mjs:280-284` (controlPad), `:718` (список команд), `:759` (regex callback'а)

- [ ] **Step 1: Три правки**

`controlPad` (первый ряд, к «контекст»/«remote»):

```js
function controlPad(id) {
  return new InlineKeyboard()
    .text('🧮 контекст', `cmd:${id}:context`).text('🌐 remote', `cmd:${id}:rc`).text('🧭 браузер', `cmd:${id}:browser`).row()
    .text('⏳ лимит', `cmd:${id}:limits`).text('🗜 compact', `cmd:${id}:compact`).text('⏹ прервать', `cmd:${id}:interrupt`).row();
}
```

Список bot-команд: `for (const name of ['context', 'rc', 'limits', 'compact', 'interrupt', 'browser']) {`

Regex callback'а: `if ((m = /^cmd:(.+):(context|rc|limits|compact|interrupt|browser)$/.exec(data))) {`

- [ ] **Step 2: Синтакс-проверка** — `node --check tg-hub/hub.mjs`
Expected: exit 0. (hub.mjs уже имеет незакоммиченные правки — не трогать чужие строки.)

---

### Task 6: E2E с реальным движком и Chrome

**Files:** нет новых — используется `smoke-browser` подход вручную либо одноразовый скрипт в scratchpad.

- [ ] **Step 1: E2E headless**: mock-hub + РЕАЛЬНЫЙ `claude` через `headless.mjs` (по образцу запуска из `smoke-suggest.mjs`: те же аргументы `--input-format stream-json ...`). Отправить `{t:'command', name:'browser'}` → ждать reply «🧭 браузер подключён». Затем `{t:'inbound', content:'@browser сколько вкладок открыто? назови число'}` → ждать содержательный reply (модель подгрузит tools и позовёт tabs_context_mcp; Chrome должен быть запущен). Аппрувы mock-hub отвечает `allow`.
Expected: подтверждение + ответ модели с числом вкладок.
- [ ] **Step 2: Финальный прогон смоука** — `node tg-hub/panel/smoke-browser.mjs` → PASS.
- [ ] **Step 3: Напомнить пользователю**: перезапустить хаб (hub.mjs изменился) и панельные сессии (interposer.mjs кэширован в запущенных процессах); живой тест из TG — кнопка в пульте + `@browser` — за пользователем.

---

## Self-review

- Покрытие спеки: кнопка/команда (Task 5), `case 'browser'`+ответы+таймаут (Task 2), `@browser`-разворачивание (Task 2+3+4), со-владение картой/явное отключение (Task 3), тесты 1–4 из спеки (Task 1: check'и 2–7 + re-enable), e2e (Task 6). Вне скоупа — как в спеке.
- Типы/имена сквозные: `chromeBridgeConfig(exe, engineArgs)`, `BROWSER_MENTION`, `BROWSER_HINT`, dep `browser{bridge,servers,enabled,setEnabled}` (всюду функции), `cmds.injectBrowser(text, chat_id)` — согласованы между задачами.
- Плейсхолдеров нет; каждый шаг с кодом и командой проверки.
