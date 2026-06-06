# claude-tg-hub — Design / Spec

> Обновлено: 2026-06-05. Стек: **Node.js + TypeScript**. Стратегия: **fork-plus-build**.
> Детальные находки вынесены в `docs/research/`. Архитектура — в `docs/specs/...-dualmode-architecture.md` (добавляется по готовности).

## 1. Контекст и цель
Улучшить работу с Claude Code, связав его с Telegram. Один бот-сервис (демон), через который
можно управлять сессиями Claude Code — **равноценно для CLI и для панели расширения VSCode**.

## 2. Требования
1. Список всех активных сессий (по проектам/машинам).
2. Двусторонне с любой сессией: сообщение/команда, статус, ответ.
3. Уведомления (завершение, нужен ввод, ошибки).
4. Аппрувы/селекторы permission-промптов.
5. **И CLI-сессии, И сессии панели расширения VSCode — оба режима первоклассны, должны работать хорошо.**

## 3. Принятые решения
- Строим **своё**, Telegram-first, как отдельный сервис/демон.
- Стек: **TypeScript** (официальный Claude Agent SDK; единый стек; см. `docs/research/2026-06-05-stack-and-existing-tools.md`).
- **Оба режима равноценны** (требование пользователя): единое ядро + два адаптера движка.
- **Стратегия — fork-plus-build:** форк Happy Coder (движок) + Telegram-слой + доноры (ccgram/telclaude) + кирпичи (claude-code-parser/FastMCP); сами пишем wrapper-интерпозер панели, двойной режим и единый registry.

## 4. Два режима подключения движка (ключевое)
Движок везде один и тот же — `claude.exe` (он же CLI). Различается только способ запуска/подключения:

- **CLI-режим:** хаб сам запускает движок (managed) через Claude Agent SDK (`can_use_tool` + streaming input + resume/listSessions) и/или `--permission-prompt-tool <mcp>`. Возможный альтернативный канал аппрувов — `claude --rc` + Anthropic WS (изучить).
- **Панель-режим:** через штатную настройку расширения **`claudeCode.claudeProcessWrapper`** — наш TS-бинарь, который расширение запускает как `<wrapper> <node> <cli.js> …args`, проксирует stdio `stream-json` и переписывает `control_request{can_use_tool}` → Telegram. Без UI-automation/инъекции. Детали и баги — в `docs/research/2026-06-05-panel-engine-and-wrapper.md`.
  - Обязательные условия: `useTerminal=false`, **абсолютный путь** к wrapper (баги #11647/#10500/#13022/#56648).

Оба режима кладут события/аппрувы/сессии в **общее ядро** (session-registry + approval-bus + Telegram-слой + типы stream-json).

## 5. Матрица возможностей (обновлено с учётом wrapper)

| Требование | CLI-режим | Панель-режим (через wrapper) |
|---|---|---|
| 1 список сессий | ✓ (managed registry) | ✓ (wrapper регистрирует каждую панель-сессию) |
| 2 ввод/статус/ответ | ✓ (SDK streaming) | ✓ (инжект `user` в stdin; чтение стрима) — ввод с косметикой (панель не отрисует вписанное) |
| 3 уведомления | ✓ | ✓ (wrapper видит `result`) |
| 4 аппрувы | ✓ (`can_use_tool`/MCP) | ✓ (перехват `control_request{can_use_tool}`) |
| 5 поддержка | CLI/терминал | панель расширения VSCode |

IDE-websocket (`~/.claude/ide/<port>.lock`) — опциональный слой редакторских действий (12 tools: диффы/диагностика/селект), не разговор/аппрувы.

## 6. Главный технический инсайт
Панель = тонкий webview-UI поверх того же `claude.exe` по `stream-json`/`control_request`-контракту.
Перехват чужой панель-сессии «снаружи» невозможен, **но** `claudeProcessWrapper` ставит нас на путь запуска движка — это чистый, штатный мост. См. research-доку по панели.

## 7. (Бывш. открытый вопрос — РЕШЕНО)
Путь входящего/аппрувов для панели: **не UI-automation, а `claudeProcessWrapper`-интерпозер (stream-json MITM).** UI-automation/CDP — только аварийный фолбэк, если когда-нибудь понадобится драйвить именно нативную панель помимо протокола.

## 8. Риски (сводно; подробно в research)
- Нестабильность `claudeProcessWrapper` на версиях расширения → **Phase-0 спайк обязателен** до ставки.
- Перехват панели нигде не реализован (green-field) → риск смены недокументированных подтипов `control_request`.
- Windows-спавн (у Happy открытые issue) → валидировать.
- Таймаут аппрува claude.exe (~5 мин) → мгновенные кнопки / pause-resume.
- Telegram: один поллер на токен → single-instance lock у хаба.
- Биллинг: с 15.06.2026 Agent SDK/`claude -p` на подписке тратят отдельный месячный кредит — заложить лимиты/мониторинг.
- Лицензии: не брать claudecodeui (AGPL) и claude-code-proxy (NonCommercial); подтвердить лицензию claude-code-parser.

## 9. Phase-0 спайк (немедленный следующий шаг)
Собрать тривиальный TS-прокси, прописать его в `claudeCode.claudeProcessWrapper` (абсолютный путь, `useTerminal=false`), и на ЦЕЛЕВОЙ версии расширения проверить:
1. панель продолжает нормально работать через wrapper;
2. видим `stream-json`-разговор в обе стороны;
3. ловим `control_request{can_use_tool}` и можем ответить `control_response` из Telegram.
Зелёный спайк → форкаем Happy и идём по плану.

## 10. Дальнейшие шаги (после спайка)
fork-plus-build по плану из `docs/research/2026-06-05-stack-and-existing-tools.md`. Детальная двухрежимная архитектура (компоненты/интерфейсы/фазы) — в `docs/specs/2026-06-05-dualmode-architecture.md` (добавляется по готовности воркфлоу).

## Ссылки
- `docs/research/2026-06-05-panel-engine-and-wrapper.md` — как устроена панель + `claudeProcessWrapper`.
- `docs/research/2026-06-05-stack-and-existing-tools.md` — выбор стека + fork-plus-build.
