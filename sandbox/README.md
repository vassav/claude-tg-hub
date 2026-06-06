# sandbox — папка для тестовых запусков канала

Отсюда гоняем `claude` с нашим экспериментальным channel-MCP-сервером (`hub`,
реализация — `../spike/channel-server/channel-server.mjs`). Лог и файл-инъекция
складываются сюда же (`channel.log`, `inject.txt`) — заданы через `env` в `.mcp.json`.

## Что уже установлено (факты на v2.1.167)

- ✅ Наш сервер цепляется как MCP, движок читает `experimental:{claude/channel, claude/channel/permission}`
  (декларация 1:1 как у офиц. плагина `telegram`).
- ✅ `tengu_harbor: true` в `~/.claude.json` — фич-флаг канала включён.
- ❓ В **headless** (`-p` / `--input-format stream-json`) channel-PUSH (inbound + аппрувы) НЕ наблюдался.
  Гипотеза: канал активируется для **глобально зарегистрированного** сервера (плагин/настройки),
  а не для одноразового `--mcp-config`; либо headless гасит inbound. → проверяем интерактивно.

## Тест A — интерактивно через `--mcp-config` (быстрый)

```powershell
pwsh -File D:\Projects\vassav\claude-tg-hub\sandbox\run.ps1
```
В сессии:
1. **Аппрув:** попроси действие с подтверждением (напр. «создай файл foo.txt»). Не из allowlist → движок должен спросить.
2. **Inbound:** в другом окне:
   ```powershell
   "привет из канала" > D:\Projects\vassav\claude-tg-hub\sandbox\inject.txt
   ```

Смотрим `sandbox\channel.log`:
- `PERMISSION_REQUEST` → аппрувы по каналу работают ✅
- появился ли в сессии блок `<channel source=...>привет из канала` → inbound работает ✅

## Тест B — если A не активирует канал: глобальная регистрация

Гипотеза «работает только у глобально зарегистрированного». Тогда регистрируем `hub`
в пользовательских настройках MCP (или как плагин) и запускаем БЕЗ `--mcp-config`:

```powershell
# вариант: добавить hub в ~/.claude.json mcpServers, затем
claude --channels server:hub
```
Если и так нет — упаковываем наш сервер как полноценный **plugin** (`.claude-plugin/plugin.json`
+ marketplace), как офиц. telegram, и адресуем `--channels plugin:hub@<marketplace>`.

## Диагностика
- `channel.log` пишет ВСЕ JSON-RPC кадры (IN/OUT) + `PERMISSION_REQUEST`.
- Пусто после `initialize`/`tools/list` и без `PERMISSION_REQUEST`/inbound → канал не активирован (gate/режим).
