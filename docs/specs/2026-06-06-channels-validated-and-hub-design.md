# Нативные channels подтверждены + дизайн мультисессийного хаба

> 2026-06-06. Результаты реверса + **рабочего спайка** на движке `claude.exe` v2.1.167 (Windows).
> Дополняет `2026-06-05-dualmode-architecture.md`. Статус: **channels как путь интеграции — ВАЛИДИРОВАН на нашем коде.**

## 0. TL;DR

Свой MCP-сервер может стать **каналом** Claude Code и получить: **вход** (Telegram→сессия),
**аппрувы** (в обе стороны, гонка с локальным TUI) и **выход** (через MCP-tool `reply`).
Подтверждено сквозным прогоном. Единственный gate — allowlist; локально снимается dev-флагом.
`tengu_harbor` на этом аккаунте включён.

## 1. Что такое channel (проверенный контракт)

**Channel = обычный MCP-сервер, который в `initialize` объявляет экспериментальную capability, а движок ему ПУШИТ события.** Транспорт — тот же stdio JSON-RPC (newline-delimited), что у любого MCP-сервера.

Сервер объявляет:
```jsonc
capabilities: { tools: {}, experimental: { "claude/channel": {}, "claude/channel/permission": {} } }
```
- `claude/channel` — чат (inbound).
- `claude/channel/permission` — аппрувы (опционально; объявлять только если сервер аутентифицирует отвечающего).

### Протокол (наблюдённые кадры)
- **Inbound** (сервер→движок, notification): `notifications/claude/channel`
  `{ content, meta:{ chat_id, message_id, user, user_id, ts, image_path?, attachment_*? } }`.
  Движок инжектит как пользовательский ход (`priority:"next"`), рендерит как `<channel source=…>`-блок.
- **Аппрув-запрос** (движок→сервер, notification): `notifications/claude/channel/permission_request`
  `{ request_id, tool_name, description, input_preview }`.
- **Аппрув-решение** (сервер→движок, notification): `notifications/claude/channel/permission`
  `{ request_id, behavior:"allow"|"deny" }`. Гонится с локальным TUI-диалогом — кто первый.
- **Outbound текста ассистента движок НЕ пушит.** Наружу — только когда модель сама вызывает
  MCP-tool (у офиц. плагина — `reply`, плюс `react`, `edit_message`, `download_attachment`).

### Доказательство (спайк, `spike/channel-server/channel.log`)
Прогон через node-pty (настоящий TTY) `claude --dangerously-load-development-channels server:hub`:
```
OUT notifications/claude/channel            {content:"PING_FROM_CHANNEL reply ... PONG"}   ← мы инжектнули вход
IN  notifications/claude/channel/permission_request {request_id:"mvkqd", tool_name:"mcp__hub__reply", input:{text:"PONG"}}
OUT notifications/claude/channel/permission {request_id:"mvkqd", behavior:"allow"}          ← наш авто-allow
IN  tools/call reply {text:"PONG"}                                                          ← инструмент выполнился
```
В TUI модель ответила `● PONG`. То есть **вход + аппрув + выход** прошли на нашем сервере.

## 2. Gate активации канала (из бинаря, дословно)

Цепочка: capability → провайдер **firstParty** (не Bedrock/Vertex/Foundry) → фич-флаг
**`tengu_harbor`** (в `~/.claude.json` = `true`) → орг-политика `channelsEnabled` → имя в `--channels` →
**allowlist** (для не-dev).

Логика allowlist (декомпил): `if (!channel.dev) { if (!allowlist.some(e => e.plugin===name && e.marketplace===mp)) return skip }`.
- `allowedChannelPlugins` — **массив `{marketplace, plugin}`**, читается из **managed/policy-настроек**
  (`C:\ProgramData\ClaudeCode\managed-settings.json`, org/admin). Описание в коде: *«Managed-org allowlist of channel plugins»*.
- **`server:`-канал** (из `--mcp-config`) пары plugin/marketplace не имеет → в allowlist попасть НЕ может →
  для него **только `--dangerously-load-development-channels`** (движок прямо так и пишет).
- **`plugin:`-канал** → можно внести в `allowedChannelPlugins` (managed) → `--channels plugin:name@mp` без варнинга.

### Имена в `--channels`
Скрытый вариадик-флаг, пробел-разделённый: `plugin:<name>@<marketplace>` или `server:<name>` (голое имя отвергается).
Dev-вариант (тоже скрытый): `--dangerously-load-development-channels <servers...>` — на старте показывает
варнинг-промпт «I am using this for local development» (Enter подтверждает; пропускает allowlist-проверку).

## 3. Прод-gate: решение

| Сценарий сессии | Путь активации канала |
|---|---|
| **Хаб сам спавнит сессию** (managed/owned) | `--dangerously-load-development-channels server:hub` + **хаб авто-подтверждает варнинг** (владеет PTY/stdin). Без admin. ✅ воспроизведено |
| **Чистый запуск без флага / ручные интерактивные сессии юзера** | упаковать канал как **plugin** + внести `{marketplace,plugin}` в `allowedChannelPlugins` в **managed-settings** (admin). Без варнинга. **✅ применено 2026-06-06:** `C:\ProgramData\ClaudeCode\managed-settings.json` = `{channelsEnabled:true, allowedChannelPlugins:[{claude-plugins-official,telegram},{tg-hub-dev,hub}]}` (скрипт: `spike/managed-settings/set-managed-settings.ps1`). ⚠ allowlist **рестриктивный**: когда задан — ПОЛНОСТЬЮ заменяет дефолтный Anthropic-allowlist (поэтому telegram внесён явно). Канал активируется только если назван в `--channels` (быть в `.mcp.json` мало). **`server:`-каналы в allowlist попасть не могут** (только `{marketplace,plugin}`) → чистый запуск (без dev-флага) возможен лишь для hub, упакованного **плагином**. Осталось: упаковать `hub` плагином + установить + проверить `--channels plugin:hub@tg-hub-dev`. |

## 4. Дизайн мультисессийного хаба (channels + один бот)

Жёсткие ограничения, диктующие форму:
- **Один бот-токен = один `getUpdates`-поллер** (Telegram 409). Официальный плагин при старте
  **убивает чужой `bot.pid`** (single-instance). → ботом владеет **один долгоживущий процесс — хаб-демон**.
- **Канал-сервер спавнится движком на каждую сессию** (stdio, per-session). → per-session это **тонкий shim**,
  который НЕ поллит Telegram, а коннектится к хабу по локальному IPC.
- **Outbound движок не пушит** → для надёжных уведомлений/стрима хаб-owned сессий читаем stream-json;
  для не-owned (ручных) сессий — модель зовёт `reply`.

```
Telegram (1 бот) ─getUpdates─ HUB-демон { SessionRegistry · Router(topic↔session) · ApprovalBus · IPC-сервер }
                                   ▲ IPC                      ▲ IPC
                            channel-shim (MCP stdio)    channel-shim (MCP stdio)   ← наш канал на сессию
                                   ▲ stdio                    ▲ stdio                (dev-флаг локально / allowlist в проде)
                              claude #1                  claude #2
```

### Компоненты
- **channel-shim** (per-session): объявляет `claude/channel(+permission)`; вместо своего поллинга —
  коннектится к хабу (named pipe / UDS / localhost ws+token), регистрирует сессию, релеит
  `permission_request`/inbound. Прозрачный фолбэк при недоступности хаба (не ронять сессию).
- **HUB-демон** (один на токен): владеет ботом (grammY), реестром сессий, роутингом topic↔sessionId,
  approval-bus (inline-кнопки), IPC-эндпоинтом. Спавнит owned-сессии (`--channels` + stream-json для outbound).
- **Реестр/роутинг** — НАШ слой (канал сам по себе одно-сессийный); сессия = forum-topic.

### Потоки
- Вход: Telegram → хаб → (по IPC) нужный shim → `notifications/claude/channel` в свою сессию.
- Аппрув: сессия → shim → хаб → inline-кнопки в нужном топике → решение → shim → `permission`.
- Выход: owned — хаб читает stream-json; не-owned — модель зовёт `reply` (shim проксирует в хаб → Telegram).

## 5. Спайк-артефакты (как воспроизвести)

- `spike/channel-server/channel-server.mjs` — минимальный channel-сервер (env: `CHANNEL_LOG`, `CHANNEL_INJECT`).
- `spike/channel-server/test-pty.mjs` — node-pty харнесс: живой TTY, авто-Enter на стартовых промптах,
  инъекция входа, проверка `PONG`/`PERMISSION_REQUEST`.
- `spike/channel-server/mcp.json` — регистрация `hub` через `--mcp-config`.
- `spike/hub-marketplace/` — заготовка локального плагина+marketplace (для прод-allowlist пути).
- `sandbox/` — папка для ручных тестовых запусков (`run.ps1`, `.mcp.json`).

Команда (локальный dev): `claude --mcp-config <mcp.json> --strict-mcp-config --dangerously-load-development-channels server:hub`
(`--strict-mcp-config` исключает офиц. telegram-плагин → не конфликтует за бот-токен).

## 6. Риски / открытое
- `tengu_harbor` — серверный фич-флаг (могут выключить превью) → канал отвалится по «feature is not currently available».
- Протокол экспериментальный (методы/формы могут меняться меж версий) → мониторить.
- Dev-флаг = варнинг-промпт на запуск (для owned-сессий авто-подтверждаем; для ручных — упаковка-в-плагин+allowlist).
- Мультисессийный fan-out поверх одного бота — НАШ код (single-poller у движка не помогает).
- Outbound уведомлений для не-owned сессий зависит от того, что модель сама зовёт `reply`.

## 7. Дальше
1. (this doc) ✅ зафиксировать находки.
2. Демо «2 сессии → 2 топика, один бот, с аппрувами»: хаб-демон + shim + grammY + роутинг. Нужен свой бот-токен.
3. Опц. прод-путь: плагин-упаковка + managed `allowedChannelPlugins`.

## 8. Официальные доки (первоисточник — подтверждено, не реверс)

Channels **официально задокументированы** (research preview, требует CC ≥ v2.1.80; permission-relay ≥ v2.1.81):
- `https://code.claude.com/docs/en/channels.md` — обзор, supported channels (telegram/discord/imessage/fakechat), security, **Enterprise controls** (`channelsEnabled`, `allowedChannelPlugins`), сравнение с web/Slack/MCP/Remote Control.
- `https://code.claude.com/docs/en/channels-reference.md` — **полный контракт**: server options, notification format, reply-tool, gating, permission relay, «Package as a plugin», dev-флаг.
- Рабочие реализации: `github.com/anthropics/claude-plugins-official/tree/main/external_plugins` (telegram/discord/imessage/**fakechat** — fakechat ближе всего к нашему: web-UI + reply + вложения).

Ключевые авторитетные факты:
- **Контракт = ровно наш спайк.** Inbound `notifications/claude/channel{content, meta}` (ключи meta — только `[A-Za-z0-9_]`, иначе молча отбрасываются) → `<channel source="<имя сервера>" ...meta>content</channel>`. Permission: `permission_request{request_id, tool_name, description, input_preview}` → `permission{request_id, behavior:'allow'|'deny'}`. Relay покрывает **только** tool-use (Bash/Write/Edit) — НЕ project-trust и НЕ MCP-consent.
- **Доставка:** notifications не ack-аются; если канал не загружен/политика блокирует — **молча дропается**. События **очередятся per-session** и отдаются пачкой на следующем ходу. *«To process independent event streams concurrently, run separate sessions»* — официальный вердикт: **один-бот-много-сессий не поддержан → наш fan-out (hub-демон + per-session shim) обязателен.**
- **Активация:** «Being in `.mcp.json` isn't enough: a server also has to be named in `--channels`». `--channels` принимает несколько entries через пробел.
- **Gate:** `channelsEnabled` (мастер-свитч; **Pro/Max без орг — пропускают проверки, channels доступны**; Team/Enterprise — блок до включения админом; Console API-key — по умолчанию разрешено). `allowedChannelPlugins` — **заменяет** дефолтный allowlist; только `{marketplace, plugin}`; применяется лишь при `channelsEnabled:true`.
- **Кастом-канал:** в research preview `--channels` принимает только allowlist-плагины; кастом (`server:` или неофиц. плагин) — через **`--dangerously-load-development-channels`** (обходит ТОЛЬКО allowlist, `channelsEnabled` всё равно нужен). Чистый запуск кастома → упаковать плагином и внести в `allowedChannelPlugins` (на Pro/Max — через managed-settings, что мы и сделали).
- **⚠ research preview:** синтаксис `--channels` и контракт **могут меняться** между версиями — заложить версионную хрупкость.

