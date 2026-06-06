# Интерактивный тест нашего channel-сервера.
# Запуск:  pwsh -File sandbox\run.ps1   (или просто ./run.ps1 из sandbox)
$ErrorActionPreference = 'Stop'
$root = 'D:\Projects\vassav\claude-tg-hub'
$mcp  = Join-Path $root 'sandbox\.mcp.json'
$log  = Join-Path $root 'sandbox\channel.log'

# чистим лог перед прогоном
Set-Content -Path $log -Value '' -Encoding utf8 -ErrorAction SilentlyContinue

Write-Host "→ Запускаю интерактивную сессию claude с нашим каналом 'hub'."
Write-Host "  Лог канала: $log"
Write-Host "  Inbound-тест (в ДРУГОМ окне): echo привет > $($root)\sandbox\inject.txt"
Write-Host "  Аппрув-тест: попроси в сессии действие с подтверждением (напр. создать файл)."
Write-Host ""

claude --mcp-config "$mcp" --strict-mcp-config --channels server:hub
