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

Метка сессии (`label`) — имя по папке проекта (basename от cwd, с дедупом).

| Команда / действие | Что делает |
|---|---|
| `/start` | приветствие + клавиатура |
| `/sessions` | живые сессии (● активная, 🛑 стоп) **и** ⏸ resumable (🗑 — забыть) |
| обычный текст | в активную сессию |
| тап по метке на клавиатуре | сделать эту сессию активной |
| `/to <label> <текст>` · reply на `[label]` | отправить в конкретную сессию, не меняя активную |
| `/projects` | история по проектам (cwd) → ▶ Resume или ➕ новая сессия |
| `/new <путь>` | создать новую сессию в указанной папке |
| `/stop <label>` (или 🛑) | остановить сессию |

Аппрувы приходят кнопками **только на реальные действия** (Bash/Write/…); ответы ассистента
(`reply`) авто-разрешены. Доступ — только у `HUB_OWNER_ID`.

## Установка

### Требования

- **Node.js ≥ 22.** `hub-demo` тянет нативную зависимость `node-pty` — обычно ставится
  из prebuilt-бинаря; если для твоей версии Node его нет, понадобится тулчейн сборки
  (на Windows — «Desktop development with C++» из Visual Studio Build Tools + Python 3;
  на Linux/macOS — `build-essential`/Xcode CLT).
- **Claude Code CLI** (`claude` ≥ 2.1.80; проверено на 2.1.167) с выполненным входом
  в аккаунт **Pro/Max или Console** и доступом к **channels** (research preview,
  первопартийный провайдер). Проверка: `claude --version`.
- **Telegram-бот** от [@BotFather](https://t.me/BotFather) (получишь токен) и **твой
  Telegram user id** (узнать у [@userinfobot](https://t.me/userinfobot)).
- **git**.

### Шаги

1. **Клонировать и поставить зависимости:**
   ```bash
   git clone https://github.com/vassav/claude-tg-hub.git
   cd claude-tg-hub/hub-demo
   npm install
   ```

2. **Создать `.env` в корне репозитория** (он в `.gitignore` — токен сюда, не в код):
   ```dotenv
   HUB_BOT_TOKEN=<токен от BotFather>
   HUB_OWNER_ID=<твой Telegram user id>     # только он сможет управлять ботом
   HUB_PORT=8799                            # локальный TCP-порт IPC (любой свободный)
   HUB_TOKEN=<любой локальный секрет>        # общий секрет hub↔shim
   # CLAUDE_BIN=C:\path\to\claude.exe       # см. шаг 3
   ```

3. **Указать путь к `claude` (если он не дефолтный).** [`session.mjs`](hub-demo/session.mjs)
   по умолчанию ищет `claude.exe` по моему пути установки. На своей машине задай
   переменную `CLAUDE_BIN` (в `.env` или в окружении) на свой бинарь:
   - Windows: `where.exe claude` → возьми путь к `…\bin\claude.exe`;
   - Linux/macOS: `which claude`.

4. **Поправить рабочий каталог сессий.** В демо путь захардкожен под мою машину —
   замени `TMP` в [`hub.mjs`](hub-demo/hub.mjs#L28) и [`launch.mjs`](hub-demo/launch.mjs#L20)
   на свою папку (например, `%LOCALAPPDATA%\Temp\hubsessions` или `/tmp/hubsessions`).
   *(Это временные cwd для тестовых сессий `launch.mjs`; для реальной работы создавай
   сессии в нужных проектах через `/new <путь>` или `/projects`.)*

5. **Запуск** (два терминала из `hub-demo`):
   ```bash
   npm run hub       # терминал 1 — демон-бот (один поллер Telegram + IPC + реестр)
   npm run launch    # терминал 2 — опционально: поднять тестовые сессии sess-A/sess-B
   ```
   При первом запуске сессии PTY сами подтверждают стартовые промпты Claude
   (доверие к папке, предупреждение dev-channels) — нажатий не требуется.

6. **Проверка.** В Telegram из аккаунта владельца: `/start`, затем `/sessions` —
   переключайся между сессиями, пиши в активную, подтверждай действия кнопками.
   Реестр сессий сохраняется в `~/.claude/channels/hub/registry.json`, поэтому
   при рестарте демона живые сессии **переподцепляются**, а завершённые предлагаются
   как ⏸ resume (с полной историей).

> Сессии хаба переживают рестарт демона: каждая привязана к UUID разговора Claude
> (через `--session-id`), хаб хранит `uuid+cwd` и проверяет живость процесса по PID,
> чтобы не запустить один разговор дважды.

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
