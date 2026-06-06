# Как устроена связь панели VSCode с движком Claude + точка интеграции `claudeProcessWrapper`

> Источник: реверс-инжиниринг установленного расширения **anthropic.claude-code v2.1.165** (Windows) +
> веб-ресёрч, июнь 2026. Это фактическая база для архитектуры claude-tg-hub.

## 1. Архитектура панели (подтверждено в бандле)

```
[webview/index.js]  — UI панели (чистый фронт, React)
      ↕  приватный VSCode postMessage-bridge: webview.onDidReceiveMessage → fromClientStream
      ↕  свой RPC-конверт панели: launch_claude / io_message / request{tool_permission_request} / response{tool_permission_response}
[extension.js]      — host расширения (встроенный Claude Agent SDK)
      ↕  child_process.spawn(claude.exe, {stdio:["pipe","pipe",...], windowsHide:true})
      ↕  АНОНИМНЫЕ stdin/stdout, формат NDJSON `stream-json`
         (--output-format stream-json --input-format stream-json --verbose [--permission-prompt-tool] ...)
[resources/native-binary/claude.exe]  — движок (~240 МБ, ТОТ ЖЕ, что CLI)
```

- **Движок панели = тот же `claude.exe`, что и CLI.** Панель — лишь другой фронтенд.
- **Разговор** идёт по приватным stdio-пайпам в `stream-json` (NDJSON, по строке на сообщение, нужен flush).
- **Webview↔host** — приватный in-process канал VSCode (`postMessage`), снаружи не адресуется/не аутентифицируется.

## 2. Поток аппрувов (permission)

- Движок шлёт в stdout `control_request` с `request.subtype === "can_use_tool"`.
- Host вызывает колбэк `canUseTool(toolName, input, {suggestions})` → ретранслирует в webview как
  `request{type:"tool_permission_request", toolName, inputs, suggestions}`.
- Webview рисует кнопки Allow/Deny/опции; ответ → `response{type:"tool_permission_response", result:{behavior:"allow", updatedInput, updatedPermissions | behavior:"deny", message, interrupt}}`.
- Host превращает ответ обратно в `control_response` движку (в stdin).
- Та же шина `control_request` используется для проброса MCP (`subtype:"mcp_message"`).
- Спец-инструменты в панели: Edit/Write → `openDiff`, ExitPlanMode → markdown preview, AskUserQuestion → свои кнопки опций.

## 3. IDE-websocket (НЕ путь к разговору)

- Host поднимает loopback ws-сервер, пишет `~/.claude/ide/<PORT>.lock`:
  `{pid, workspaceFolders, ideName, transport:"ws", authToken, runningInWindows}`. Имя файла = порт.
- Авторизация входящих: заголовок `x-claude-code-ide-authorization` == authToken (иначе `close(1008)`).
- Порт отдаётся движку через env `CLAUDE_CODE_SSE_PORT`; **именно `claude.exe` подключается к этому ws как клиент инструментов.**
- На ws ровно **12 редакторских tools**: `openDiff, getDiagnostics, close_tab, closeAllDiffTabs, openFile, getOpenEditors, getWorkspaceFolders, getCurrentSelection, checkDocumentDirty, saveDocument, getLatestSelection, executeCode`.
- **Разговор и аппрувы по этому ws НЕ идут.** Внешний клиент может подключиться (зная PORT+authToken), но получит только эти 12 tools. Спека: [coder/claudecode.nvim PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md). Учесть CVE-2025-52882 (валидация токена).
- Есть ещё ws-транспорт для **teleport/remote** режима (`this.ws.send`, серверная выдача ws_url) — это удалённая фича, не локальная панель.

## 4. Точка интеграции: `claudeCode.claudeProcessWrapper` ⭐

Настройка расширения (`package.json`): `claudeCode.claudeProcessWrapper` (string) — *"Executable path used to launch the Claude process."*

Декодированный `resolveClaudeBinary()` из `extension.js`:
```js
resolveClaudeBinary() {
  const wrapper = config.get("claudeProcessWrapper");          // твой executable
  const env     = resolvedShellEnv;
  let realEntry = resolveBundled() || asAbsolutePath("resources/claude-code/cli.js");
  // если cli.js — запускается через node: i = process.execPath, r = cli.js
  if (wrapper) return {
     pathToClaudeCodeExecutable: wrapper,                        // ← запускается ТВОЙ wrapper
     executableArgs: realEntry ? [node, cliJs] /* или [realEntry] */ : [],  // реальный движок — в аргументах
     env
  };
  ...
}
```

**Смысл:** при заданном wrapper расширение спавнит `<твой-wrapper> <node> <cli.js> …args` **с теми же stdio-пайпами**, по которым идёт `stream-json`. Твой wrapper садится MITM на канал host↔движок и может:
- **читать весь разговор** (user-сообщения от host, стрим ассистента от движка) → список/статус/ответы панели;
- **аппрувы**: перехватывать `control_request{can_use_tool}` из stdout движка и (а) наблюдать, (б) **сам отвечать `control_response`** (тогда подтверждение приходит из Telegram, панель диалог не показывает), (в) дуально (панель + Telegram);
- **инжектить ввод**: дописывать `{"type":"user",…}` в stdin движка (ответ ассистента вернётся в панель; само вписанное сообщение панель не отрисует — косметика);
- **уведомления**: видеть `result` (завершение хода) → пинг в Telegram.

Всё это — **штатной настройкой, без UI-automation и без инъекции в процесс, кросс-платформенно** (wrapper = обычный Node-исполняемый). Протокол, который он трогает (`stream-json`/`control_request`), — это де-факто публичный SDK-контракт, стабильнее минифицированного webview-RPC.

### ⚠️ Баги/ограничения `claudeProcessWrapper` (начало 2026)
- Игнорируется при `useTerminal=true` → **требуется `useTerminal=false`** ([#11647](https://github.com/anthropics/claude-code/issues/11647), [#10500](https://github.com/anthropics/claude-code/issues/10500)).
- Нет var-substitution в пути → **только абсолютный путь** ([#13022](https://github.com/anthropics/claude-code/issues/13022)).
- Была регрессия молчаливого игнора настройки в v2.1.131 ([#56648](https://github.com/anthropics/claude-code/issues/56648)).
- → надёжность только при `useTerminal=false` + абсолютный путь, **и это надо проверить на целевой версии расширения (Phase-0 спайк).**

## 5. Вердикт по перехвату панели
- **Перехват СУЩЕСТВУЮЩЕЙ панель-сессии «снаружи» по сети — невозможно** (webview↔host приватен, stdio анонимны, IDE-ws несёт только tools).
- **Чисто и штатно — только через `claudeProcessWrapper`** (мы сами оказываемся на пути запуска движка). Это и есть путь для режима «панель».
- Для CLI-режима — свой движок через SDK `can_use_tool` и/или `--permission-prompt-tool <mcp>`.

## 6. Исходники
- **Нативное расширение — закрытое:** в Marketplace только минифицированные `extension.js`/`webview/index.js`, исходного TS в публичном репозитории нет. (В марте 2026 полный TS кратко утёк через sourcemap → «human error»; опираться нельзя/неэтично.)
- **Движок открыто распространяется** (`@anthropic-ai/claude-code`, тот же `claude.exe`); его `stream-json`/SDK-контракт и IDE-протокол **задокументированы** ([docs](https://code.claude.com/docs/en/vs-code)); есть рабочие сторонние хосты IDE-протокола (nvim/Obsidian/NetBeans).
- Внутренний webview↔host RPC (`launch_claude`/`io_message`/`tool_permission_request`) — **не документирован**, восстановлен реверсом, не стабильный API (нам он и не нужен — работаем на уровне stdio движка).
