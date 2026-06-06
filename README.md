# claude-tg-hub

Один Telegram-бот, управляющий **несколькими CLI-сессиями Claude Code** одновременно:
переписка с любой сессией, подтверждение инструментов (аппрувы) кнопками, история проектов
и возобновление (resume), создание и остановка сессий — через нативную фичу Claude Code
**channels**.

> 🧪 Статус: **рабочее демо + спайки** (не продакшн). `channels` — research-preview Claude Code
> (нужен `claude` ≥ 2.1.80, первопартийный провайдер). Дизайн, находки и проверенные в бинаре
> факты — в [`docs/`](docs/).

## Идея

Управлять своими сессиями Claude Code с телефона: писать в них, видеть ответы, подтверждать
действия (Bash/Write/…) — пока ты не за терминалом.

Ключевой плюс над официальным channel-плагином (telegram/discord/…): тот поллит Telegram
**в каждой сессии** (один бот = одна сессия, конфликт `getUpdates`). Здесь бот держит **один
долгоживущий демон**, а каждая сессия подключается тонким shim'ом по локальному IPC →
**один бот обслуживает много сессий**.

## Архитектура

```
Telegram (1 бот) ─ getUpdates ─ HUB (демон): бот + IPC-сервер + реестр + роутинг + аппрувы
                                     ▲ локальный TCP IPC
                          channel-shim (на каждую сессию): MCP stdio ↔ движок,  TCP ↔ hub
                                     ▲ stdio  (claude --channels …)
                                  claude  (CLI-сессия)
```

- **`hub-demo/hub.mjs`** — демон: владеет ботом (grammY, единственный поллер), TCP-IPC, реестром
  сессий, маршрутизацией (команда / reply-to / клавиатура ↔ сессия), аппрув-кнопками, историей
  проектов + resume, созданием и остановкой сессий.
- **`hub-demo/shim.mjs`** — per-session channel-MCP-сервер (без зависимостей): объявляет
  `claude/channel` + `claude/channel/permission`, релеит вход / аппрувы / `reply`, сам находит
  хаб (discovery-конфиг) и присваивает себе id; останавливает свою сессию, убивая родителя-`claude`.
- **`hub-demo/session.mjs`** — запуск сессии в PTY (node-pty, с авто-подтверждением стартовых
  промптов); **`hub-demo/launch.mjs`** — поднять стартовые сессии.

## Команды бота

| Команда / действие | Что делает |
|---|---|
| `/sessions` | список живых сессий; кнопки переключения (●) и остановки (🛑) |
| обычный текст | в активную сессию |
| `/s2 <текст>` · reply на `[sN]` · кнопка `s1/s2` | отправить/переключиться на конкретную сессию |
| `/projects` | история по проектам (cwd) → ▶ Resume или ➕ новая сессия |
| `/new <путь>` | создать новую сессию в указанной папке |
| `/stop sN` (или 🛑) | остановить сессию |

Аппрувы приходят кнопками **только на реальные действия** (Bash/Write/…); ответы ассистента
(`reply`) авто-разрешены. Доступ — только у `HUB_OWNER_ID`.

## Быстрый старт (демо)

Требования: Node ≥ 22, аккаунт Claude (Pro/Max или Console), бот от
[@BotFather](https://t.me/BotFather), доступ к channels.

1. `.env` в корне репозитория (gitignored):
   ```dotenv
   HUB_BOT_TOKEN=<токен от BotFather>
   HUB_OWNER_ID=<твой Telegram user id>
   HUB_PORT=8799
   HUB_TOKEN=<любой локальный секрет для IPC>
   ```
2. Установка и запуск:
   ```bash
   cd hub-demo
   npm install
   node hub.mjs       # терминал 1 — демон-бот
   node launch.mjs    # терминал 2 — поднимает тестовые сессии
   ```
3. В Telegram из аккаунта владельца: `/sessions`, переключайся, пиши, подтверждай действия.

## Сессии, запущенные тобой (не хабом)

Любую свою сессию можно присоединить к работающему хабу:
```bash
HUB_JOIN=1 claude --dangerously-load-development-channels plugin:hub@tg-hub-dev
```
(плагин устанавливается из `spike/hub-marketplace`; на личном Pro/Max managed-allowlist для
запуска без dev-флага не действует — см. [спеку](docs/specs/2026-06-06-channels-validated-and-hub-design.md)).
shim сам найдёт хаб и зарегистрирует сессию; `HUB_JOIN=1` — явный opt-in, чтобы обычные
сессии не подключались.

## Как устроены channels (кратко)

`channel` = MCP-сервер, который в `initialize` объявляет
`capabilities.experimental: { "claude/channel": {}, "claude/channel/permission": {} }`.
Движок пушит ему входящие (`notifications/claude/channel`) и запросы аппрува
(`…/permission_request` → `…/permission`); наружу ассистент отвечает через MCP-tool `reply`.
Активируется флагом `--channels <plugin:name@marketplace | server:name>` (для кастома —
`--dangerously-load-development-channels`).

Полный разбор контракта, gate и проверенные в бинаре факты:
- [`docs/specs/2026-06-06-channels-validated-and-hub-design.md`](docs/specs/2026-06-06-channels-validated-and-hub-design.md)
- официальные доки: [channels](https://code.claude.com/docs/en/channels.md),
  [channels-reference](https://code.claude.com/docs/en/channels-reference.md)

## Ограничения

- `channels` — research-preview: синтаксис/контракт могут меняться между версиями.
- Кастомный канал активируется dev-флагом; managed-allowlist (`allowedChannelPlugins`) — фича
  Team/Enterprise, на личном Pro/Max не применяется.
- Голый `claude` без `--channels` подцепить задним числом нельзя (анонимный stdio).
- VSCode-панель не покрыта (отдельный путь — stdio-wrapper).
- Демо на `.mjs`; продакшн-порт в TS (hub + shim + persist + lifecycle) — в планах.

## Структура

| Папка | |
|---|---|
| `hub-demo/` | рабочее демо: `hub.mjs`, `shim.mjs`, `session.mjs`, `launch.mjs` |
| `spike/channel-server/` | спайк channel-сервера + PTY-тесты (валидация протокола) |
| `spike/hub-marketplace/` | канал, упакованный плагином (`hub`) + локальный marketplace |
| `spike/managed-settings/` | helper для `allowedChannelPlugins` |
| `sandbox/` | папка для тестовых запусков |
| `docs/` | дизайн и research |

## Лицензия

Пока не указана.
