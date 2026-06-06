# claude-tg-hub — двухрежимная архитектура (CLI + панель VSCode)

> 2026-06-05. Написано напрямую из собранных находок (research-доки + реверс), т.к. design-воркфлоу оборвался.
> Принцип: **единое ядро + два адаптера движка**; CLI и панель равноценны.

## Обзор

```
                         ┌─────────────────────────── HUB (демон, один процесс, single-instance lock) ───────────────────────────┐
   Telegram  ⇄  TelegramGateway  ⇄  Core { SessionRegistry · ApprovalBus · NotificationService · StreamJsonCodec }                 │
                         │                                   ▲              ▲                                                      │
                         │                                   │ EngineAdapter (интерфейс)                                          │
                         │                  ┌────────────────┴───────────────────────────┐                                       │
                         │          CliEngineAdapter (managed)              PanelWrapperAdapter (через WrapperBridge IPC)          │
                         └──────────────────┼───────────────────────────────────┼────────────────────────────────────────────────┘
                                            │ spawn + stdio stream-json          │ локальный IPC (named pipe / UDS / localhost ws+token)
                                            ▼                                    ▲
                                       claude.exe (managed)            wrapper-bin  ⇄  claude.exe   ← запущен VSCode-расширением как
                                                                       (proxy stdio)                  claudeProcessWrapper: <wrapper> <node> <cli.js> …
```

Движок везде один — `claude.exe`. Различается только способ запуска и кто держит его stdio.

## Компоненты и интерфейсы

### EngineAdapter (ключевая абстракция)
```ts
interface EngineAdapter {
  readonly sessionId: string
  readonly mode: 'cli' | 'panel'
  send(userMessage: string): Promise<void>          // инжект {type:'user'} в stream-json
  interrupt(): Promise<void>
  respondApproval(id: string, d: ApprovalDecision): void   // -> control_response / can_use_tool result
  stop(): Promise<void>
  on(ev: 'assistant'|'result'|'status'|'approval-request'|'closed', cb): void
}
type ApprovalDecision =
  | { behavior:'allow', updatedInput?:any, updatedPermissions?:any[] }
  | { behavior:'deny', message?:string, interrupt?:boolean }
```
- **CliEngineAdapter** — хаб сам спавнит `claude` (`--input-format stream-json --output-format stream-json --verbose`) или через Agent SDK; аппрувы через `can_use_tool`-колбэк и/или `--permission-prompt-tool <mcp>`. Полный контроль, managed-сессия.
- **PanelWrapperAdapter** — не спавнит движок сам: он **является** процессом-wrapper'ом, которого запускает VSCode. Проксирует stdio реального `claude.exe` (берёт из argv), парсит stream-json, **мостит** события/аппрувы в хаб через WrapperBridge и принимает инъекции/решения обратно.

### Core
- **SessionRegistry** — единый реестр: `{id, mode, cwd, title, status: starting|busy|idle|waiting-approval|ended, topicId, createdAt, lastActivity}`. Persist на диск (переживать рестарт хаба) + сверка с `~/.claude/projects/**/*.jsonl` для видимости и чужих сессий.
- **ApprovalBus** — единая модель аппрувов поверх ОБОИХ адаптеров: создаёт `approvalId`, шлёт в Telegram inline-кнопки (Allow / Deny / Always / опции селектора), ждёт решение, роутит назад в нужный адаптер. Политика таймаута (см. ниже).
- **StreamJsonCodec** — NDJSON парсер/сериализатор stream-json + `control_request`/`control_response` (взять `claude-code-parser` ⚠лиц. или свой на `ndjson`). Общий для обоих адаптеров.
- **NotificationService** — завершение хода / нужен ввод / ошибка → проактивно в Telegram.

### TelegramGateway
- Единственный владелец бота (grammY) и **единственный getUpdates-поллер** (single-instance lock; иначе 409). Сессия = forum-topic (или чат). Маппинг topic ↔ sessionId.
- Команды: `/sessions`, выбор сессии, ввод текста, кнопки аппрувов/опций. Рендер стрима ассистента, статусов, уведомлений.

### WrapperBridge (важный нюанс)
Wrapper запускается **VSCode**, а не хабом, и это **отдельный процесс на каждую панель-сессию**. Значит он должен **подключиться к долгоживущему хабу**:
- Хаб поднимает локальный IPC-эндпоинт: **named pipe (Windows) / UDS (mac/Linux)** за одним интерфейсом, либо `localhost ws + token` единообразно.
- Каждый wrapper при старте: коннектится к хабу, регистрирует сессию, релеит stdio-события и принимает инъекции/решения.
- **Прозрачность при сбое:** если хаб недоступен/мост упал — wrapper работает как **чистый passthrough** (панель продолжает нормально работать, просто без моста). Wrapper не должен ронять панель-сессии **никогда**.

## Потоки данных
- **CLI:** Telegram → Gateway → CliEngineAdapter.send → stdin claude. stdout claude → adapter → события → Gateway → Telegram. Аппрув: `control_request{can_use_tool}` → ApprovalBus → кнопки в Telegram → решение → `control_response`.
- **Панель:** VSCode спавнит wrapper → wrapper коннектится к WrapperBridge, регистрирует сессию. Юзер в панели → host → wrapper.stdin → (форвард в claude.stdin) **и** зеркало в хаб (Telegram видит). claude.stdout → wrapper → (форвард в host = панель рисует) **и** зеркало в хаб. Аппрув панели — режимы: **(a)** Telegram-only (wrapper сам отвечает, диалог панели подавляется — не форвардить в host), **(b)** дуально (host + Telegram, кто первый), **(c)** observe (форвард в host, плюс уведомление). Инъекция из Telegram → bridge → wrapper пишет `{type:'user'}` в claude.stdin (косметика: панель не отрисует вписанное).

## Единая модель аппрувов и таймаут
- Кнопки: Allow / Deny / Always-allow(tool) / опции (для AskUserQuestion-селектора).
- `claude.exe` может таймаутить аппрув (~5 мин) → политика: **мгновенные inline-кнопки**; если ответа нет к дедлайну — **pause/resume сессии** либо конфигурируемый дефолт (deny + уведомление). Always-allow кэшируется в правах сессии.

## Кросс-платформа
- Ядро (TS/Node), stream-json, registry, Telegram, ApprovalBus — OS-агностичны.
- WrapperBridge IPC — named pipe / UDS / localhost-ws за одним интерфейсом.
- Wrapper-бинарь — node-скрипт или SEA; в настройке **абсолютный путь**; требовать **`useTerminal=false`** (баги #11647/#10500/#13022/#56648), при старте **детектить**, что настройка применилась.
- Демонизация: node-windows / launchd / systemd (PM2 опц.).

## Phase-0 спайк (до любого форка)
Тривиальный TS-прокси в `claudeCode.claudeProcessWrapper` (абсолютный путь, `useTerminal=false`). Проверить на ЦЕЛЕВОЙ версии расширения: (1) панель работает через wrapper; (2) видим stream-json в обе стороны; (3) ловим `control_request{can_use_tool}` и можем ответить `control_response`. Зелёно → форкаем Happy.

## Фазы реализации
- **P0** — wrapper-спайк (валидация интерпозиции + перехвата аппрува).
- **P1** — каркас ядра: SessionRegistry + TelegramGateway + StreamJsonCodec + WrapperBridge; **CliEngineAdapter** (managed): список/ввод/уведомления для хаб-сессий. (Ускорить форком Happy: pty+stream-json+мульти-сессии.)
- **P2** — ApprovalBus + аппрувы для CLI (`can_use_tool` / `--permission-prompt-tool` MCP на FastMCP). UX-кнопок — донор ccgram.
- **P3** — **PanelWrapperAdapter**: панель-сессии в реестре, чтение/уведомления + relay аппрувов (transparent-on-failure).
- **P4** — инъекция ввода в панель (с косметикой) + опц. IDE-ws редакторские действия + модель прав (telclaude) + persist/resume.

## Открытые риски
- `claudeProcessWrapper` нестабилен/версионно-хрупок → P0-спайк обязателен; завязка на недокументированный `control_request` (мониторить версии).
- Wrapper на пути ВСЕХ панель-сессий → обязателен прозрачный passthrough и изоляция сбоев.
- Windows-спавн (Happy #551) → валидировать.
- Дуальный роутинг аппрува (панель+Telegram) без дублей — аккуратная машина состояний.
- Объём «своего» (двойной режим + bridge + registry + обходы багов) недооценивать нельзя.
