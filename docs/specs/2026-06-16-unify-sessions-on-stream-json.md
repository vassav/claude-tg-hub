# Унификация: TG-сессии на stream-json через headless-клиент

Дата: 2026-06-16. Статус: **дизайн утверждён, не реализовано**.
Связано: [мост панели](2026-06-11-vscode-panel-bridge.md), [панельные команды](2026-06-16-panel-commands-in-telegram.md).

## Задача
Сейчас сессии, поднятые **через ТГ** (`startSession`→`spawnSession`), работают в **channels-режиме**
(`claude` в PTY + MCP-shim). У этого режима **нет контрол-протокола**, поэтому команды
`/context`/`/rc`/`/limits`/`/interrupt` там недоступны (доказано: они есть только в stream-json).
Цель — поднимать TG-сессии **так же, как панель** (stream-json SDK-режим), где роль VSCode-расширения
играет наш **headless-клиент**. Тогда тот же мост и **все 5 команд** работают для TG-сессий
**идентично панели**, а транспорт становится единым.

Изменения **аддитивны для пользователя** (Telegram-UX, registry/resume/`/sessions`/`/projects`/аппрувы
сохраняются), но **меняют транспорт** hub-launched сессий с channels на stream-json.

## Ключевой факт (почему это посильно)
Агентный/тул-луп крутится **внутри движка** `claude` (в обоих режимах). Клиент (раньше — расширение,
теперь — наш headless) **тонкий**: делает стартовый хэндшейк, шлёт user-turn'ы, читает поток, отвечает
на `can_use_tool`/`hook_callback`, дёргает контрол-команды. Тул'ы исполняет движок и сам реплеит
`tool_result` (`--replay-user-messages`). Значит **turn-loop писать не нужно** — нужен тонкий клиент.

## Жёсткие факты протокола (из реальных логов интерпозера, claude 2.1.178)
Направления: **IN** = клиент→движок (stdin), **OUT** = движок→клиент (stdout).

- **Стартовый хэндшейк (IN, клиент инициирует):**
  - `control_request{subtype:"initialize", hooks:{…}, appendSystemPrompt:"…"}` — hooks ссылаются на
    `hook_0/1/2`; если послать **пустые hooks**, движок не шлёт `hook_callback` (их в логах 62 — иначе
    на каждый надо отвечать, иначе ход виснет). `appendSystemPrompt` опционален.
  - `control_request{subtype:"set_permission_mode", mode:"default"}` — тривиально.
  - `control_request{subtype:"get_settings"}` → ответ `{commands:[…]}` (опционально).
- **User-turn (IN):** `{type:"user", message:{role:"user", content:[{type:"text", text}]}}` (как `injectUser`).
- **Assistant (OUT):** `{type:"assistant", message:{content:[{type:"text"|"thinking"|"tool_use",…}]}}`; зеркалим `text`.
- **Аппрув (OUT→IN):** движок шлёт `control_request{subtype:"can_use_tool", tool_name, input, tool_use_id}`,
  клиент отвечает `control_response{response:{behavior:"allow"|"deny", updatedInput, toolUseID}}` (уже умеем).
- **Заголовок:** в stream-json вместо MCP `set_title` идёт `control_request{subtype:"generate_session_title"}`
  → ответ движка с `title` (интерпозер уже ловит `control_response.response.response.title`).
- **Команды:** `get_context_usage`, `remote_control{enabled:true}`, `interrupt`, пассивный `rate_limit_event`
  (см. [спек панельных команд](2026-06-16-panel-commands-in-telegram.md)).
- `result/success` — конец хода.

## Архитектура

### Общий модуль моста (рефактор из интерпозера)
Выделить из [interposer.mjs](../../tg-hub/panel/interposer.mjs) переиспользуемое ядро (без привязки к
middleman-пайпам) — напр. `panel/bridge-core.mjs`:
- IPC-клиент к хабу: `register`(+`kind`)/`reply`/`title`/`permission_request` ↔ `inbound`/
  `permission_decision`/`stop`/**`command`**; discovery `hub.json`.
- `injectUser(text)`, зеркало `assistant.text`, перехват+`DROP` `can_use_tool`, захват `title`.
- Контрол-команды: `issueControl(subtype, extra, {chat_id})` + capture/`DROP` своих `control_response`,
  кэш `rate_limit_event`, форматирование ответов, `handleCommand(name, chat_id)`.
- Принимает на вход: функцию `writeToEngine(obj)` и поток объектов от движка (`onEngineMsg(obj)`),
  не зная, откуда они (middleman-пайп панели **или** прямой child headless-клиента).

### Панельный клиент (существующий, рефактор-совместимый)
[interposer.mjs](../../tg-hub/panel/interposer.mjs) остаётся middleman'ом (расширение↔движок), но
проксирует bridge-логику через `bridge-core` (`writeToEngine = child.stdin.write`,
`onEngineMsg` из OUT-форвардера, `onIn` для «панель ответила первой» по аппруву). Хэндшейк по-прежнему
делает расширение. Поведение панели **не меняется**.

### Headless-клиент (НОВОЕ) — `panel/headless.mjs`
- Спавнит `claude --input-format stream-json --output-format stream-json --verbose
  --permission-prompt-tool stdio --include-partial-messages --replay-user-messages` (+ `--resume`/
  `--session-id`, + `--mcp-config` если есть `extraMcpServers`), **пайпами, не PTY**, без channels/shim.
- На старте сам выполняет хэндшейк: `initialize` (**пустые hooks**, опц. `appendSystemPrompt`),
  `set_permission_mode`. Затем работает через `bridge-core` (`writeToEngine = child.stdin.write`,
  `onEngineMsg` из child.stdout по строкам).
- К хабу подключается как обычно, `register` с capability-маркером (см. ниже).

### `session.mjs` / `hub.mjs`
- `spawnSession` для **hub-launched** сессий запускает headless-клиент (`node headless.mjs …`) вместо
  channels-PTY. Сигнатура и проброс `extraMcpServers`/`extraAllowedTools` сохраняются (теперь через
  `--mcp-config` headless-клиента).
- `startSession`/registry/resume/`/projects` — без изменений по API; внутри меняется лишь способ спавна.
- **Capability-маркер.** И панельный интерпозер, и headless-клиент регистрируются как control-capable
  (stream-json): `register` с `kind:'stream'` (это **уточняет** спек команд, где было `kind:'panel'`;
  хелпер — `isStream(id)` / control-capable). Channels-сессии — без маркера. Команды/кнопки `/context`
  и пр. хаб показывает и шлёт только control-capable сессиям.

### Что уходит для hub-launched сессий
Channels (`--dangerously-load-development-channels server:hub`) и `shim.mjs` для TG-сессий **больше не
используются** (headless-клиент сам и есть мост). `shim.mjs`/channels остаются только для возможных
**внешних** (plugin-launched) channels-сессий, которые подключаются сами — их не трогаем.

## Фазы (де-риск инкрементально)
0. **Смоук headless-клиента** *(первым делом, снимает главный риск)*: минимальный клиент спавнит
   `claude` в stream-json, делает `initialize`, гоняет один user-turn → получает `assistant`+`result`,
   и один `can_use_tool` → `allow` исполняется. Подтверждает минимально достаточный хэндшейк.
1. **Рефактор `bridge-core`** из интерпозера; панель работает по-прежнему (регресс-проверка панели).
2. **Headless-клиент** на `bridge-core`; `session.mjs` переводит hub-launched спавн на него.
   Переподтвердить: `--resume`, `--session-id`, durable-registry, авто-имя (`generate_session_title`),
   аппрувы (`can_use_tool`).
3. **5 команд** (`/context`/`/rc`/`/limits`/`/compact`/`/interrupt`) в `bridge-core` → работают и для
   панели, и для TG-сессий.

## Риски / на что смотреть
- **Минимальность хэндшейка** — снимается фазой 0.
- **Folder-trust в headless** (stream-json обычно минует TUI-промпты — проверить, не виснет ли старт).
- **Авторизация** движка — как и раньше, из env (`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`),
  наследуется дочернему процессу; отдельного кода не требует.
- **Паритет фич channels на stream-json** — resume/registry/title/аппрувы переподтвердить (фаза 2).
- **Кроссплатформенные пути** headless-клиента (node/exe) — env, как и для остального (отдельная задача).

## Вне scope
- Недельный лимит; `/clear`; универсальный проброс произвольных `/`-команд (см. спек команд).
- Удаление `shim.mjs`/channels (оставляем для внешних сессий).
- TS-порт.

## Проверка (end-to-end)
1. Фаза 0 смоук (см. выше).
2. TG-сессия (новая и `/projects`-resume) поднимается headless: разговор, зеркало, аппрувы кнопками,
   авто-имя, resume после рестарта хаба — как раньше.
3. Все 5 команд на TG-сессии (команда и кнопка) — как на панели.
4. Регресс: панельные сессии и внешние channels-сессии (если есть) — без изменений.
