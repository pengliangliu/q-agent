param([switch]$SkipShortcuts)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$source = Join-Path $PSScriptRoot 'dist'
$installedRoot = Join-Path $env:LOCALAPPDATA 'Programs\QAgent'
$clientRoot = Join-Path $installedRoot 'client'
$workspaceLauncher = Join-Path (Split-Path $PSScriptRoot -Parent) 'desktop-files\Open-AgentDeck-Chinese.ps1'
$required = @('QAgent.exe', 'QAgent.exe.config', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll', 'agent-deck.ico', 'agent-deck-192.png', 'WebView2-LICENSE.txt', 'WebView2-NOTICE.txt')
foreach ($name in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $name) -PathType Leaf)) { throw "Missing client file; run build-client.ps1 first: $name" }
}
if (-not (Test-Path -LiteralPath $workspaceLauncher -PathType Leaf)) { throw 'Missing desktop-files launcher in this checkout.' }
foreach ($directory in @($installedRoot, $clientRoot)) {
    if ((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The installation directory must not be a link.'
    }
}
$running = @(Get-Process -Name QAgent -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $clientRoot 'QAgent.exe') })
if ($running.Count) { throw 'Close the installed Q-agent client before updating it. WSL model sessions can remain running.' }

$backup = Join-Path $installedRoot ('backups\client-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
New-Item -ItemType Directory -Path $clientRoot -Force | Out-Null
foreach ($name in $required) {
    $target = Join-Path $clientRoot $name
    if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination (Join-Path $backup $name) }
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination $target -Force
}
$launcher = Join-Path $installedRoot 'Open-AgentDeck-Chinese.ps1'
if (Test-Path -LiteralPath $launcher) { Copy-Item -LiteralPath $launcher -Destination (Join-Path $backup 'Open-AgentDeck-Chinese.ps1') }
Copy-Item -LiteralPath $workspaceLauncher -Destination $launcher -Force

$registered = @()
if (-not $SkipShortcuts) {
    $shell = New-Object -ComObject WScript.Shell
    $locations = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
    foreach ($folder in $locations) {
        if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
        $link = Join-Path $folder 'Q-agent.lnk'
        if (Test-Path -LiteralPath $link) { Copy-Item -LiteralPath $link -Destination (Join-Path $backup ('shortcut-' + $registered.Count + '.lnk')) }
        $shortcut = $shell.CreateShortcut($link)
        $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '"'
        $shortcut.WorkingDirectory = $installedRoot
        $shortcut.Description = 'Q-agent desktop client for local WSL sessions'
        $shortcut.IconLocation = (Join-Path $clientRoot 'QAgent.exe') + ',0'
        $shortcut.Save()
        $registration = Start-Process -FilePath (Join-Path $clientRoot 'QAgent.exe') -ArgumentList @('--register-shortcut', ('"' + $link + '"')) -WindowStyle Hidden -Wait -PassThru
        if ($registration.ExitCode -ne 0) { throw 'Could not register the Q-agent notification shortcut.' }
        $registered += $link
    }
}
foreach ($name in $required) {
    if ((Get-FileHash -LiteralPath (Join-Path $source $name) -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath (Join-Path $clientRoot $name) -Algorithm SHA256).Hash) { throw "Client verification failed: $name" }
}
# Keep generated installation reports free of usernames and absolute paths.
$report = [ordered]@{ installed = '%LOCALAPPDATA%\Programs\QAgent\client';
    launcher = 'Open-AgentDeck-Chinese.ps1'; backup = 'backups\' + (Split-Path $backup -Leaf);
    registeredShortcuts = $registered.Count; files = $required; verified = $true }
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'installation.json') -Encoding utf8
$report | ConvertTo-Json -Depth 4
