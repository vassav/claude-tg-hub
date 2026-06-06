# claude-tg-hub — инструкции для Claude

## О проекте
Единый Telegram-бот-сервис (демон) для управления сессиями Claude Code: список сессий,
двусторонне (ввод/команды/статус/ответ), уведомления, аппрувы — **равноценно для CLI и для панели VSCode**.
**Стек:** сейчас Node.js + `.mjs` (zero-build); целевой порт — TypeScript. **Подход:** свой
channels-хаб (см. Статус). *(Исходная стратегия fork-plus-build не понадобилась — путь к движку
оказался через нативные `channels`.)*

## Язык и стиль
- Отвечай на русском. Код — TypeScript.
- Не коммить без явного запроса. Перед крупными изменениями уточняй подход.
- Для архитектурных развилок давай разбор ТЕКСТОМ (пользователь не любит AskUserQuestion-кнопки для таких решений).

## Статус и как продолжать
**Рабочий инструмент (beta), запушен в публичный репо** `github.com/vassav/claude-tg-hub`.
Реализован **CLI-режим через нативные `channels`** (research-preview): один Telegram-бот ↔ много
сессий Claude Code. Код — в [`hub-demo/`](hub-demo/) на `.mjs` (имя папки историческое).
Проверено end-to-end на `claude` 2.1.167.

Сделано: мульти-сессионный хаб (один поллер + per-session shim по TCP), маршрутизация, аппрувы
кнопками, история проектов + resume, **durable-реестр** (переживает рестарт/краш демона: живые
переподцепляются, мёртвые → ⏸ resume; защита от двойного запуска по PID, краш-safe запись),
**авто-именование** сессий моделью (`set_title`, иначе слаг первого запроса).

Источник правды сейчас:
- [`README.md`](README.md) — обзор, установка, команды.
- [`docs/specs/2026-06-06-channels-validated-and-hub-design.md`](docs/specs/2026-06-06-channels-validated-and-hub-design.md) — проверенный контракт channels + дизайн хаба.

Дальше (не сделано): TS-пакет вместо `.mjs`; кроссплатформенные пути (`TMP`/`CLAUDE_BIN` → env,
сейчас захардкожены под Windows); многопользовательский доступ; **режим VSCode-панели**
(через `claudeProcessWrapper`-интерпозер — research в `docs/`, не реализован).

Историческое (исходный дизайн до перехода на channels): [`docs/specs/2026-06-05-claude-tg-hub-design.md`](docs/specs/2026-06-05-claude-tg-hub-design.md), [`docs/research/2026-06-05-panel-engine-and-wrapper.md`](docs/research/2026-06-05-panel-engine-and-wrapper.md), [`docs/research/2026-06-05-stack-and-existing-tools.md`](docs/research/2026-06-05-stack-and-existing-tools.md).

## Ключевые решения
- **CLI-режим реализован через `channels`** (не через SDK `can_use_tool`/`--permission-prompt-tool`,
  как планировалось вначале): движок сам пушит входящие и запросы аппрува channel-MCP-серверу
  (shim), ассистент отвечает MCP-tool'ом `reply`. Это и оказалось рабочим путём к движку.
- **fork-plus-build не понадобился** — channels закрыли задачу своим кодом (`hub-demo/`). Из
  доноров (ccgram/telclaude/офиц. telegram-плагин) взяты идеи UX аппрувов и модели доступа, не форк.
- **Режим VSCode-панели — на будущее**, отдельным путём (`claudeProcessWrapper`-интерпозер
  stream-json; research см. «Жёсткие факты»). Общее ядро с CLI: registry + approval-bus + Telegram-слой.
- **Целевой стек — TypeScript** (паритет SDK); текущая рабочая версия — на `.mjs` (zero-build).

## Жёсткие факты (чтобы не переисследовать)
- Панель = webview-UI поверх `claude.exe`; разговор/аппрувы по stdio `stream-json` + `control_request{can_use_tool}`. Webview↔host приватен (in-process). Перехват чужой панели снаружи невозможен — только через `claudeProcessWrapper`.
- `claudeProcessWrapper`: расширение зовёт `<wrapper> <node> <cli.js> …args` с теми же stdio-пайпами. **Условия:** `useTerminal=false` + абсолютный путь (баги #11647/#10500/#13022/#56648). Проверить на целевой версии (спайк).
- IDE-ws (`~/.claude/ide/<port>.lock`, authToken) — только 12 редакторских tools, не разговор.
- Telegram — один поллер на токен (single-instance lock у хаба). Аппрув claude.exe может таймаутить >~5 мин → мгновенные кнопки/pause-resume.
- Лицензии: НЕ брать claudecodeui (AGPL), claude-code-proxy (NonCommercial). У hub будет свой бот-токен. Модель доступа (allowlist/pairing) — как в офиц. telegram-плагине.

## Связанное
Идея и весь ресёрч — из сессии LabPack/LiquidCrafts (там же навык publish-release и рабочий telegram-плагин с отдельным ботом).
