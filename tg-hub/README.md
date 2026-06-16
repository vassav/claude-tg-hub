# tg-hub — один Telegram-бот → N Claude-сессий через нативные channels

Демо мультисессийного хаба (валидирует дизайн из `docs/specs/2026-06-06-...`).

## Состав
- **hub.mjs** — демон: владеет ботом (grammY, один поллер), TCP-IPC (порт `HUB_PORT`),
  реестр сессий, роутинг topic/команда↔сессия, аппрув-кнопки. Доступ — только `HUB_OWNER_ID`.
- **shim.mjs** — per-session channel-MCP-сервер (zero-deps): stdio↔движок, TCP↔hub.
  Релеит вход (hub→сессия), аппрувы (обе стороны), `reply` (сессия→hub→Telegram).
- **launch.mjs** — спавнит N сессий `claude` в PTY с каналом `server:hub` (dev-флаг,
  автоподтверждение стартовых промптов). Сессии регистрируются в hub и ждут событий.

## Конфиг (`../.env`, gitignored)
```
HUB_BOT_TOKEN=...      # бот хаба (@my_local_claud_bot)
HUB_OWNER_ID=...       # твой Telegram user id (allowlist)
HUB_PORT=8799          # локальный IPC
HUB_TOKEN=...          # секрет shim↔hub
```

## Запуск
```powershell
cd tg-hub
npm install
# терминал 1: демон-бот
node hub.mjs
# терминал 2: поднять 2 сессии
node launch.mjs
```
В Telegram (@my_local_claud_bot, из аккаунта-владельца):
- `/sessions` — список (s1, s2).
- `/use s1` — выбрать активную; затем обычный текст → активной сессии.
- `/s2 <текст>` — отправить конкретной сессии.
- Когда сессия запросит аппрув инструмента → придут кнопки **Allow/Deny** с тегом `[sN]`.
- Ответ ассистента приходит как `[sN] <текст>` (модель зовёт `reply`).

> Демо на `.mjs` (быстрый, проверенный рантайм). После валидации — продакшн-порт в TS-пакет.
> channels — research preview; `server:` идёт через dev-флаг (см. спеку §8).
