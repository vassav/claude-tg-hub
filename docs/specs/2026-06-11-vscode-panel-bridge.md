# VSCode-панель ↔ Telegram-хаб: мост через stdio-интерпозер

Дата: 2026-06-11. Статус: **реализовано и проверено end-to-end**
(панельный `claude` 2.1.165, расширение `anthropic.claude-code-2.1.165`).

## Задача
Подключить сессию **панели VSCode** (не CLI) к тому же Telegram-хабу: видеть ответы
панели в Telegram, писать в неё с телефона, подтверждать инструменты кнопками — наравне
с CLI-сессиями.

## Почему интерпозер, а не channels
Панель запускает `claude.exe` в режиме SDK stream-json (`--input-format stream-json
--output-format stream-json`), а turn-loop ведёт расширение. Channel-инъекция
(`notifications/claude/channel`) в этом режиме **не запускает ход модели** (сообщение лишь
встаёт в очередь) — путь-2 для панели мёртв. Рабочий путь — **stdio-интерпозер**: садимся
на поток между расширением и движком и читаем/пишем настоящие stream-json сообщения.

## Как расширение запускает движок
Расширение зовёт бинарь из настройки `claudeCode.claudeProcessWrapper` (без shell, теми же
stdio-пайпами):
```
<wrapper> <claudeExe> --output-format stream-json --verbose --input-format stream-json \
  --max-thinking-tokens N --permission-prompt-tool stdio --setting-sources=… \
  --permission-mode plan --include-partial-messages --debug --debug-to-stderr \
  --enable-auth-status --no-chrome --replay-user-messages
```
- Для **служебных** запусков (`auth status`, …) `--input-format` нет → wrapper прозрачно зовёт
  claude напрямую.
- Для **сессии** (есть `--input-format`) wrapper маршрутизирует через
  `node interposer.mjs <claudeExe> <args>`.
- `node.exe` и путь к `interposer.mjs` сейчас захардкожены в `panel-wrapper.cs` (правятся под
  машину перед сборкой).
- Node spawn без shell не запускает `.cmd/.bat` (EINVAL после CVE) → wrapper это **.exe**
  (компилируется из `.cs`). Условие настройки: `useTerminal=false`, абсолютный путь.

## Проверенный stream-json (что нужно для моста)
Направления: **IN** = расширение→движок (stdin claude), **OUT** = движок→расширение (stdout).

1. **User-turn (IN)** — как инжектить сообщение из Telegram:
   ```json
   {"type":"user","uuid":"<uuid>","session_id":"","parent_tool_use_id":null,
    "message":{"role":"user","content":[{"type":"text","text":"…"}]}}
   ```
2. **Assistant-turn (OUT)** — как зеркалить: приходит готовым блоком
   `{"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}`
   (deltas из `stream_event` игнорируем). На ход — отдельные строки `thinking`/`tool_use`/`text`;
   зеркалим `text`.
3. **Запрос аппрува (OUT)**:
   `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool",
   "tool_name":"…","input":{…},"description":"…","tool_use_id":"toolu_…"}}`.
4. **Вердикт аппрува (IN)**:
   `{"type":"control_response","response":{"subtype":"success","request_id":"<uuid>",
   "response":{"behavior":"allow","updatedInput":{…},"updatedPermissions":[],"toolUseID":"toolu_…"}}}`
   (deny → `{"behavior":"deny","message":"…"}`).

Бонусы: `--replay-user-messages` → движок эхает инжектнутый user-turn на OUT, так что в панели
он отрисуется как обычный пузырёк (UI остаётся консистентным). `generate_session_title` (IN) →
движок отвечает `{title:"…"}` (OUT) — берём как имя сессии в хабе.

Важно: аппрувы панели идут по **control-протоколу `can_use_tool`**, а не channels → на
`claude` ≥ 2.1.168 они НЕ авто-аппрувятся (в отличие от channels-регрессии). Путь 3 чинит
кнопки аппрува именно для панели.

## Архитектура моста
`hub-demo/panel/interposer.mjs` = «shim панели»: прозрачно форвардит данные в обе стороны
И подключается к хабу тем же IPC, что обычный shim (`register/reply/title/permission_request`
↔ `inbound/permission_decision/stop`). Идентичность сессии — `session_id` движка (UUID,
отличает её от CLI-shim, у которого `<папка>-<pid>`). Регистрируется как **не-managed** — хаб
её не резюмит (панелью владеет VSCode).

- **Зеркало (3b)**: на каждый assistant-`text` шлём `reply` в хаб → Telegram (если чат привязан).
- **Инжект (3c)**: на `inbound` из хаба пишем `{type:"user"}` в stdin движка.
- **Аппрув (3d, перехват при привязке)**: когда сессией рулит Telegram (есть `boundChatId`),
  `can_use_tool` **перехватывается** — в панель НЕ форвардится (иначе её диалог зависает), уходит
  кнопками в TG, вердикт инжектится в stdin. Без привязки — пропускается в панель (локальный
  аппрув). request_id панели — UUID, а кнопки хаба ждут `[a-z]{5}` → интерпозер держит карту
  synthId↔uuid. (Поэтому OUT форвардится **построчно**, а не byte-pipe — чтобы уметь «дропнуть»
  перехваченную строку.)

Привязка чата: `boundChatId` ставится на первом `inbound`; до этого панель работает локально,
в Telegram ничего не зеркалится (нет спама от чисто-локальной работы).

## Рендеринг в Telegram
Сессии (панель и CLI) пишут Markdown. Хаб рендерит его в **Telegram HTML** (`mdToTgHtml`):
`**bold**`, `` `code` ``, ```fences```, ссылки, заголовки→жирный, списки→•. Файловые ссылки
(`[f](относительный/путь)`) → `<code>` — Telegram принимает в `<a href>` только URL с доменом
(FQDN/TLD), иначе отвергает всё сообщение. Фолбэк на plain-текст, если Telegram отверг сущности;
разбивка сообщений >4096.

## Установка
1. Поправь пути в [`hub-demo/panel/panel-wrapper.cs`](../../hub-demo/panel/panel-wrapper.cs)
   (`NodeExe`, `Interposer`) под свою машину.
2. Скомпилируй `.cs` в консольный `.exe` (например, в PowerShell):
   ```powershell
   Add-Type -TypeDefinition (Get-Content panel-wrapper.cs -Raw) `
     -OutputType ConsoleApplication -OutputAssembly panel-wrapper-i.exe
   ```
   (или `csc.exe panel-wrapper.cs`.)
3. В VSCode задай настройку `claudeCode.claudeProcessWrapper` = абсолютный путь к `.exe`
   (расширение мигрирует её в global scope; `useTerminal` должен быть `false`).
4. Запусти хаб (`npm run hub`). Открой панель Claude в нужном проекте — сессия зарегистрируется
   в хабе (~2 с) и появится в `/sessions`. Сделай её активной и пиши с телефона.

## Ограничения / дальше
- Пути в wrapper'е и `node.exe` захардкожены (как и в остальном хабе) → env-параметризация в планах.
- Пока сессия привязана к Telegram, аппрув только с телефона (в панели диалога нет — by design,
  чтобы ничего не зависало). Локально (без привязки) — диалог панели как обычно.
- OUT форвардится построчно; backpressure не управляется (объём потока мал — текст и control).
- Жирный, оборачивающий инлайн-код (`**текст с `код` внутри**`), не схлопывается (косметика).
- `bridge=false` (env `PANEL_BRIDGE=0`) — отключить мост, оставить чистый passthrough.
