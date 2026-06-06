# Phase-1 spike: свой Claude Code «channel»-сервер

Цель: доказать, что **наш** MCP-сервер цепляется как `--channels server:hub` и видит
реальный wire-протокол канала (вход + аппрувы) на целевой версии `claude.exe`.

## Как запустить тест (в отдельном терминале)

```powershell
claude --mcp-config D:\Projects\vassav\claude-tg-hub\spike\channel-server\mcp.json --strict-mcp-config --channels server:hub
```

- `--strict-mcp-config` — грузить ТОЛЬКО наш `hub`-сервер (чтобы не конфликтовать с
  уже работающим официальным telegram-плагином: один бот-токен = один поллер).
- `--channels server:hub` — включить наш сервер как канал. Если форма имени не примется,
  попробовать `server:hub` / просто `hub` / посмотреть ошибку в выводе claude.

## Что проверяем (смотреть в `channel.log`)

1. **`START` + `IN initialize` + `OUT ... experimental:{claude/channel,...}`** —
   движок спавнит нас и проходит MCP-handshake. (Базово — сервер поднялся.)
2. **`PERMISSION_REQUEST`** — в сессии попроси действие, требующее аппрува
   (например: «создай файл test.txt» или «запусти `dir`»). Если в логе появился
   `PERMISSION_REQUEST` и инструмент проехал на нашем авто-`allow` — **канал-аппрувы
   работают на нашем коде** (headline-фича подтверждена).
3. **Inbound:** в другом терминале `echo привет > inject.txt`
   (в этой папке). Если в сессии claude появился блок `<channel source=...>привет` —
   **вход через канал работает**.

## Диагностика

- Если `initialize` есть, но `PERMISSION_REQUEST` НЕ приходит (аппрув идёт обычным
  TUI/`--permission-prompt-tool`) → канал НЕ активировался: проверить gate
  (`tengu_harbor` фич-флаг, firstParty-провайдер, форму имени в `--channels`).
- `channel.log` и `inject.txt` — игнорятся git'ом (см. `.gitignore`).

> Спайк на `.mjs` намеренно (zero-build, наблюдаем протокол). После валидации
> портируем в TS-пакет хаба (hub-демон + per-session shim + Telegram).
