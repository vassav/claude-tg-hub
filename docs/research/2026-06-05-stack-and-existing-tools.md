# Выбор стека и обзор существующих решений (fork-plus-build)

> Источник: два многоагентных воркфлоу с веб/GitHub-ресёрчем и адверсариальной проверкой, июнь 2026.

## 1. Стек ядра: TypeScript

Оценка кандидатов (взвешенно: CC-интеграция 0.30, кросс-платформа 0.30, telegram 0.15, concurrency/deploy 0.15, team-fit 0.10):

| Стек | Скор (после adversarial verify) | Итог |
|---|---|---|
| Python | ~4.00 | паритет |
| **TypeScript/Node** | ~3.95 | **выбран** |
| Go | ~2.95 | отклонён |

- **CC-интеграция в паритете у TS и Python** (оба — единственные официальные языки Claude Agent SDK; `can_use_tool`/streaming/resume/listSessions). Go отклонён: нет официального SDK + нет зрелой UI-automation + не наш язык.
- Воркфлоу изначально склонялся к Python из-за бесплатного зрелого Windows-UIA. **Но** после находки `claudeProcessWrapper` основной путь к панели — stream-json-интерпозер (язык-нейтральный, без UI-automation), поэтому перевес Python испаряется → **TS** (team-fit, единый стек, официальный SDK).
- Если когда-нибудь понадобится нативная UI-automation (фолбэк), её выносим в **отдельный per-OS воркер за тонким RPC** (CDP — первичный, язык-нейтральный; нативная accessibility — фолбэк). Порядок платформ: Windows → Linux(X11 дёшево / Wayland дороже) → macOS (частично деградирует: TCC вручную, баг Electron AXManualAccessibility).

## 2. Вердикт по готовым решениям: **fork-plus-build**

Готового «всё-в-одном» под наш сценарий (панель через wrapper/stream-json + мульти-сессии + удалённые аппрувы + Telegram, кросс-платформенно, TS) **нет**. Перехват панели через `claudeProcessWrapper` — green-field (ни одного форка). 4 из 5 требований закрываются заимствованием.

### Форк-кандидаты (всё MIT, TypeScript)
- **🥇 Happy Coder** ([slopus/happy](https://github.com/slopus/happy), ~17k★) — **форк движка, ~70% ядра**: pty + парсинг stream-json + interceptor блокирующих аппрувов (тот же `can_use_tool`) + мульти-сессии + daemon/пуши.
  *Менять:* выкинуть E2E-relay + Expo-app, поставить Telegram (grammY/telegraf, сессия=forum-topic); добавить второй режим — wrapper для панели; валидировать Windows-spawn ([#551](https://github.com/slopus/happy/issues/551)).
- **🥈 OpenACP** ([Open-ACP/OpenACP](https://github.com/Open-ACP/OpenACP), ~404★) — готовый каркас TG-хаба (forum-topic сессии, inline Allow/Always/Reject, туннели). Транспорт — **ACP-адаптер**, не нативный stream-json; панель-wrapper всё равно дописывать. Брать, если ACP для CLI устроит.

### Доноры (паттерны, не база)
- **ccgram** ([jsayubi/ccgram](https://github.com/jsayubi/ccgram), MIT, TS) — лучший Telegram-UX блокирующих аппрувов (Allow/Deny/Always/Defer), session-routing, уведомления. (Транспорт у него hooks+PTY — заменить на stream-json.)
- **telclaude** (avivsinai, MIT, TS) — модель прав: тиры (READ_ONLY/WRITE_LOCAL/SOCIAL/FULL_ACCESS) + nonce-аппрув + опц. Haiku-скрининг команд.

### Переиспользуемые кирпичи
- **claude-code-parser** (udhaykumarbala, TS zero-dep) — типизированный парсер/сборщик `stream-json` (approve/deny-фреймы). ⚠️ **лицензию подтвердить** перед включением.
- **`--permission-prompt-tool <mcp>` + FastMCP** (MIT) — чистые remote-аппрувы для **CLI** через свой MCP-сервер.
- **openclaw-claude-bridge** (MIT, ~154★) — донор нативного stdio stream-json subprocess + persist-сессий (без аппрувов).
- **stream-json** (uhop, MIT, ESM/Node22+) / **ndjson.js** — низкоуровневый NDJSON парсер, если не брать claude-code-parser.
- **Conductor**-подход (`claude --rc` + Anthropic WS `wss://api.anthropic.com/v1/sessions/ws/{id}/subscribe`) — изучить как **возможно более надёжный** канал аппрувов CLI, чем ручной парсинг.

### Что пишем сами (gap — референса нет)
1. **Wrapper-интерпозер панели** (stream-json MITM, переписывание `control_request{can_use_tool}` → Telegram).
2. **Единый движок в двух режимах** (wrapper-панель + CLI-лончер) с общим session-registry и Telegram-слоем.
3. **Обходы багов wrapper** (`useTerminal=false`, абсолютный путь, регрессия #56648).
4. **Объединённый remote-approval-слой** (панель через `control_request` + CLI через `--permission-prompt-tool`), единая TG-UX, политика таймаута (claude.exe может таймаутить аппрув >~5 мин → мгновенные кнопки / pause-resume).

## 3. Рекомендованный план
Форк **Happy** (движок) + **Telegram-слой** (grammY/telegraf) + донор **ccgram** (UX аппрувов) + **telclaude** (права) + **claude-code-parser** (stream-json) + **FastMCP** (CLI-аппрувы). Сами: **wrapper-интерпозер + двойной режим + единый registry**.

## 4. Лицензионные ловушки (НЕ брать как базу)
- **claudecodeui** (siteboon) — **AGPL-3.0** (сетевой копилефт).
- **claude-code-proxy** (Rust) — **CC BY-NC-SA 4.0** (NonCommercial).
- **claude-code-parser** — лицензия не указана в README → подтвердить.
- Стек-мисматч (только референс, не форк): claude-code-telegram (Python, 2.7k★), Conductor (Python), ccbot (Go).

## 5. Главные риски
- `claudeProcessWrapper` нестабилен (см. research по панели) → валидировать на целевой версии до ставки.
- Перехват панели нигде не реализован → риск изменения недокументированных подтипов `control_request`.
- Happy: открытые Windows-spawn проблемы → валидировать Windows.
- Таймаут аппрува (~5 мин) → мгновенные кнопки / pause-resume.
- Объём «дописать самим» (двойной режим + registry + сшивка + обходы багов) сопоставим с заметной частью ядра — форк Happy экономит на pty+stream-json+аппрувах, но интеграционная склейка существенна.
