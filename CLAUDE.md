# claude-tg-hub — инструкции для Claude

## О проекте
Единый Telegram-бот-сервис (демон) для управления сессиями Claude Code: список сессий,
двусторонне (ввод/команды/статус/ответ), уведомления, аппрувы — **равноценно для CLI и для панели VSCode**.
**Стек:** Node.js + TypeScript. **Стратегия:** fork-plus-build.

## Язык и стиль
- Отвечай на русском. Код — TypeScript.
- Не коммить без явного запроса. Перед крупными изменениями уточняй подход.
- Для архитектурных развилок давай разбор ТЕКСТОМ (пользователь не любит AskUserQuestion-кнопки для таких решений).

## Статус и как продолжать
Этап: дизайн завершён, кода нет. **Следующий шаг — Phase-0 спайк wrapper'а** (см. спеку §9), затем fork-plus-build.
- Спека: [`docs/specs/2026-06-05-claude-tg-hub-design.md`](docs/specs/2026-06-05-claude-tg-hub-design.md) — читать первой.
- Research: [`docs/research/2026-06-05-panel-engine-and-wrapper.md`](docs/research/2026-06-05-panel-engine-and-wrapper.md) (как устроена панель + claudeProcessWrapper),
  [`docs/research/2026-06-05-stack-and-existing-tools.md`](docs/research/2026-06-05-stack-and-existing-tools.md) (стек + fork-plus-build).
- Архитектура (двухрежимная): `docs/specs/2026-06-05-dualmode-architecture.md` — добавляется по готовности.

## Ключевые решения (зафиксированы)
- **Стек = TypeScript** (паритет SDK с Python; перевес Python по UI-automation испаряется, т.к. путь к панели — wrapper/stream-json, не UI-automation).
- **Два равноценных режима** движка `claude.exe`: CLI (SDK `can_use_tool`/`--permission-prompt-tool`) и Панель (`claudeCode.claudeProcessWrapper`-интерпозер stream-json). Общее ядро: session-registry + approval-bus + Telegram-слой + типы stream-json.
- **fork-plus-build:** форк Happy Coder (движок, MIT) + Telegram (grammY/telegraf) + доноры ccgram (UX аппрувов) + telclaude (права) + кирпичи claude-code-parser (⚠ лицензия) + FastMCP (CLI-аппрувы). Сами: wrapper-интерпозер панели + двойной режим + единый registry.

## Жёсткие факты (чтобы не переисследовать)
- Панель = webview-UI поверх `claude.exe`; разговор/аппрувы по stdio `stream-json` + `control_request{can_use_tool}`. Webview↔host приватен (in-process). Перехват чужой панели снаружи невозможен — только через `claudeProcessWrapper`.
- `claudeProcessWrapper`: расширение зовёт `<wrapper> <node> <cli.js> …args` с теми же stdio-пайпами. **Условия:** `useTerminal=false` + абсолютный путь (баги #11647/#10500/#13022/#56648). Проверить на целевой версии (спайк).
- IDE-ws (`~/.claude/ide/<port>.lock`, authToken) — только 12 редакторских tools, не разговор.
- Telegram — один поллер на токен (single-instance lock у хаба). Аппрув claude.exe может таймаутить >~5 мин → мгновенные кнопки/pause-resume.
- Лицензии: НЕ брать claudecodeui (AGPL), claude-code-proxy (NonCommercial). У hub будет свой бот-токен. Модель доступа (allowlist/pairing) — как в офиц. telegram-плагине.

## Связанное
Идея и весь ресёрч — из сессии LabPack/LiquidCrafts (там же навык publish-release и рабочий telegram-плагин с отдельным ботом).
