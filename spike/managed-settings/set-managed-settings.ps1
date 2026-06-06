# Merge channelsEnabled + allowedChannelPlugins into ProgramData managed-settings.json.
# Non-destructive: preserves any existing managed keys. Writes UTF-8 without BOM.
# Run elevated (admin) — ProgramData is write-protected.
$ErrorActionPreference = 'Stop'
$dir  = 'C:\ProgramData\ClaudeCode'
$file = Join-Path $dir 'managed-settings.json'

if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$cfg = [pscustomobject]@{}
if (Test-Path $file) {
  try { $cfg = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $cfg = [pscustomobject]@{} }
}

$allow = @(
  [pscustomobject]@{ marketplace = 'claude-plugins-official'; plugin = 'telegram' },
  [pscustomobject]@{ marketplace = 'tg-hub-dev';              plugin = 'hub' }
)

$cfg | Add-Member -NotePropertyName channelsEnabled       -NotePropertyValue $true  -Force
$cfg | Add-Member -NotePropertyName allowedChannelPlugins -NotePropertyValue $allow -Force

$json = $cfg | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Output "WROTE $file"
Write-Output $json
