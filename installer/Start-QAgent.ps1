$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (Test-Path -LiteralPath (Join-Path $root 'wsl.json')) {
    & (Join-Path $root 'Open-AgentDeck-Chinese.ps1')
} else {
    & (Join-Path $PSScriptRoot 'Setup-QAgent.ps1')
}
