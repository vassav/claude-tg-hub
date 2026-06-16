# Панельные команды в Telegram: `/context`, `/rc`, `/limits`, `/compact`, `/interrupt`

Дата: 2026-06-16. Статус: **дизайн утверждён, не реализовано**.
Опирается на [мост панели](2026-06-11-vscode-panel-bridge.md) (stdio-интерпозер).

## Задача
Дать пользователю из Telegram дёргать клиентские возможности **панельной** сессии VSCode,
которые обычно «открывают окно» в самой панели и недоступны как обычный ход модели:
- `/context` — разбивка использования контекста;
- `/rc` — включить remote-control и получить ссылку для подхвата сессии с телефона/в claude.ai;
- `/limits` — процент использованного 5-часового лимита;
- `/compact` — сжать контекст;
- `/interrupt` — прервать текущий ход.

**Только для панельных сессий.** CLI-сессии (через channels) этих команд не получают —
там клиентского слоя нет. Всё **аддитивно и обратносовместимо**: контракт `inbound`/
`permission_decision`/`stop`, существующие IPC-сообщения и Telegram-команды не меняются.

## Почему так (а не инжект текста команды)
Слэш-команды панели — это **клиентский control-протокол**, а не ход модели. Если прислать
`/context` как user-turn, движок получит буквальный текст «/context» (окна/данных не будет).
Панель шлёт их движку как `control_request` с конкретным `subtype` и читает структурный
`control_response`. Значит интерпозер должен сам выступить «виртуальным клиентом панели»:
эмитить нужный `control_request` и ловить ответ. (Исключение — `/compact`: это turn-команда,
см. таблицу.)

## Жёсткие факты протокола (проверено на реальных логах интерпозера, claude 2.1.178)
Направления: **IN** = расширение→движок (stdin), **OUT** = движок→расширение (stdout).
Полный набор виденных `control_request.subtype`: `can_use_tool, generate_session_title,
get_context_usage, get_settings, hook_callback, initialize, interrupt, mcp_message,
remote_control, set_permission_mode`.

1. **`/context`** — IN `control_request{subtype:"get_context_usage"}` → OUT `control_response`:
   ```json
   {"subtype":"success","request_id":"<id>","response":{
     "categories":[{"name":"Messages","tokens":106869,"color":"…"}, …],
     "totalTokens":118967,"maxTokens":1000000,"percentage":12,"gridRows":[…]}}
   ```
2. **`/rc`** — IN `control_request{subtype:"remote_control","enabled":true}` → OUT `control_response`:
   ```json
   {"subtype":"success","request_id":"<id>","response":{
     "session_url":"https://claude.ai/code/session_…","connect_url":"…","environment_id":""}}
   ```
   (сопровождается `system/bridge_state` ready→connected — не требуется для моста.)
3. **Лимит** — OUT приходит сам, периодически:
   ```json
   {"type":"rate_limit_event","rate_limit_info":{
     "rateLimitType":"five_hour","utilization":0.96,"status":"allowed_warning","resetsAt":1781627400}}
   ```
   В стриме виден **только `five_hour`**; `utilization` — доля (0..1). **Недельного нет** — не показываем.
4. **`/compact`** — IN **user-turn** `{"type":"user","message":{"content":[{"type":"text","text":"/compact"}]}}`
   → OUT `system/status{status:"compacting"}`, затем `system/status{compact_result, compact_error?}`
   + assistant-текст. (Т.е. обычный инжект, как сообщение из TG.)
5. **`/interrupt`** — IN `control_request{subtype:"interrupt"}` (ответ ловить не нужно).

Замечание: `/clear` тоже user-turn, но **меняет `session_id`** (новый `system/init`) — в набор
не входит, осознанно не поддерживаем.

## Дизайн

### Интерпозер ([tg-hub/panel/interposer.mjs](../../tg-hub/panel/interposer.mjs))
- **Origination control-запросов.** Helper `issueControl(subtype, extra, { chat_id })`: генерит
  свой `request_id` с префиксом (напр. `tg_<rand>`), пишет
  `{type:'control_request', request_id, request:{subtype, ...extra}}` в `child.stdin` — тем же
  путём, что уже используются инжект user-turn'ов и вердиктов. Запоминает `request_id → {chat_id, kind}`
  в `pendingControl`.
- **Capture + drop.** В `onOut`: если `o.type==='control_response'` и `o.response?.request_id ∈ pendingControl`
  → форматирую и `sendHub({t:'reply', sessionId, chat_id, text})`, затем **`return DROP`** (расширение
  этого ответа не запрашивало). Точный аналог уже существующего перехвата `can_use_tool`.
- **Пассивный трекинг лимита.** В `onOut` запоминаю последний `rate_limit_event.rate_limit_info`
  (для `five_hour`); строку **форвардлю как обычно** (не дроплю — расширение его использует).
- **`/compact`** → `injectUser('/compact')`; опционально слежу за ближайшим `system/status`
  с `compact_result`/`compact_error`, чтобы ответить «сжато»/«ошибка».
- **`/interrupt`** → `issueControl('interrupt')` (fire-and-forget), ответ-подтверждение в TG.
- **Новый обработчик IPC** в `onHub`: `else if (m.t === 'command') handleCommand(m.name, m.chat_id)`.
  `handleCommand` мапит `name` → нужный механизм (см. таблицу).
- **Capability в register.** В `tryRegister` добавить `kind:'panel'` к `{t:'register', …}`.
- **Таймаут.** Если на control-запрос нет ответа ~8с → ответить в TG «панель не ответила».

### Хаб ([tg-hub/hub.mjs](../../tg-hub/hub.mjs))
- **Хранить `kind`.** В ветке `register` IPC-сервера: `sessions.set(sid, { conn, cwd, label, kind: m.kind || 'cli' })`.
  Хелпер `isPanel(id) = sessions.get(id)?.kind === 'panel'`.
- **Telegram-команды** (`bot.command`): `context`, `rc`, `limits`, `compact`, `interrupt`.
  Каждая: `owns(ctx)` → взять активную (или адресную) сессию → если `isPanel` →
  `sendToSession(id, { t:'command', name, chat_id: String(ctx.chat.id) })`, иначе ответить
  «команда доступна только для панельной сессии VSCode».
- **Инлайн-кнопки.** В `sessionInline()` для панельных сессий добавить ряд:
  `🧮 Контекст · 🌐 Remote · ⏳ Лимиты · 🗜 Compact · ⏹ Прервать`, `callback_data = cmd:<id>:<name>`.
  Новый `bot.callbackQuery(/^cmd:/, …)` → `owns` → `sendToSession(id, {t:'command', name, chat_id})`.
  NB: `⏹ Прервать` (= `interrupt`, прерывает текущий ход) — это НЕ существующая 🛑 (`stop:<id>`,
  завершает/убивает сессию); кнопки разные.

### Маппинг команд
| Команда | Механизм | Ответ в Telegram |
|---|---|---|
| `/context` | `issueControl('get_context_usage')` → `categories/percentage/totalTokens/maxTokens` | `🧮 Контекст: 12% (118 967 / 1 000 000)` + топ-категории |
| `/rc` | `issueControl('remote_control', {enabled:true})` → `session_url` | `🌐 Remote: <session_url>` (+ подсказка открыть на телефоне) |
| `/limits` | кэш последнего `rate_limit_event` (`five_hour`) | `⏳ 5ч-лимит: 96% (allowed_warning), сброс ~HH:MM` |
| `/compact` | `injectUser('/compact')` + следить за `system/status.compact_result` | `🗜 Контекст сжат` / `⚠️ compact: <error>` |
| `/interrupt` | `issueControl('interrupt')` | `⏹ Прервано` |

### Форматирование (в интерпозере; рендер Markdown→TG-HTML делает хаб)
- **context**: процент + `totalTokens/maxTokens`; затем топ-N категорий по токенам (кроме `Free space`),
  числа в человекочитаемом виде (k).
- **rc**: ссылка `session_url` как есть (хаб сам сделает её кликабельной).
- **limits**: `Math.round(utilization*100)`%, `status`, время сброса из `resetsAt` (epoch→локальное HH:MM).

## Edge-cases
- `/limits` до первого `rate_limit_event` → «лимит ещё неизвестен (придёт после первого ответа модели)».
- Ответы команд идут на `chat_id` инициатора (не зависят от `boundChatId`) — работают и до привязки чата.
- Команда в CLI-сессию: хаб не отправляет (фильтр `isPanel`); даже если бы отправил — shim игнорирует
  неизвестный `t`, безопасно.
- Параллельные команды: `pendingControl` по `request_id`, ответы независимы.

## Вне scope
- Недельный лимит (в stream-json не приходит).
- `/clear` (меняет `session_id`).
- Универсальный проброс произвольных `/`-команд/скиллов — только перечисленные именованные.
- TS-порт, кроссплатформенные пути интерпозера (отдельные задачи).

## Проверка (end-to-end, в живой панели + Telegram)
1. **Смоук control-origination (первым делом):** интерпозер шлёт `get_context_usage`, инициированный
   им самим (не расширением) → приходит `control_response` с `categories`. Это снимает единственный
   неподтверждённый момент; остальное доказано логами.
2. `/context` из TG (команда и кнопка) → корректная разбивка; ответ не «протёк» в панель (DROP работает).
3. `/rc` → в TG приходит `session_url`; открыть на телефоне — сессия подхватывается.
4. `/limits` → процент 5ч-лимита; до первого события — корректное «неизвестно».
5. `/compact` → в панели контекст сжимается; в TG приходит итог; `/interrupt` во время хода — ход прерывается.
6. CLI-сессия активна → команды отвечают «только для панели».
7. Регресс панели: обычный разговор, зеркалирование, аппрувы кнопками — без изменений.
