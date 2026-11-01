param(
    [string]$Distro = '',
    [string]$LinuxUser = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$wsl = (Get-Command wsl.exe -ErrorAction Stop).Source
$selection = @()
if ($Distro) { $selection += @('-d', $Distro) }
if ($LinuxUser) { $selection += @('-u', $LinuxUser) }
function Invoke-SelectedWsl([string[]]$CommandArguments) {
    $output = & $wsl @selection --exec @CommandArguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'WSL command failed. Check the selected distribution, Linux user, Python 3 and systemd user services.' }
    return (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
}

$installedRoot = Join-Path $env:LOCALAPPDATA 'Programs\QAgent'
$client = Join-Path $installedRoot 'client\QAgent.exe'
if (@(Get-Process -Name QAgent -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $client }).Count) {
    throw 'Close the Windows Q-agent client before installing. WSL model sessions can remain running.'
}
$probe = @'
import getpass,json,os,shutil
from pathlib import Path
h=Path.home()
def executable(name):
    candidate=shutil.which(name) or str(h/'.local/bin'/name)
    return candidate if Path(candidate).is_file() and os.access(candidate,os.X_OK) else None
print(json.dumps(dict(distro=os.environ.get('WSL_DISTRO_NAME',''),user=getpass.getuser(),home=str(h),deck=executable('agent-deck'),node=executable('node'))))
'@
try { $detected = Invoke-SelectedWsl @('python3', '-c', $probe) | ConvertFrom-Json }
catch { throw 'Cannot inspect WSL. Install and initialize the intended distribution, then check Python 3 is available.' }
if (-not $detected.distro -or -not $detected.user -or -not $detected.home -or -not $detected.deck -or -not $detected.node) {
    throw 'WSL prerequisites are missing. Install Agent Deck and Node.js for the selected Linux user, then retry.'
}
if ($detected.distro -match '[\x00-\x1f"]' -or $detected.distro.StartsWith('-') -or
    $detected.user -notmatch '^[A-Za-z0-9_.-]{1,64}$' -or $detected.home -notmatch '^/' -or $detected.deck -notmatch '^/') {
    throw 'WSL returned an invalid distribution, user or executable path.'
}
$selection = @('-d', [string]$detected.distro, '-u', [string]$detected.user)
$configuration = [ordered]@{ distro = $detected.distro; user = $detected.user; home = $detected.home; deck = $detected.deck }
if ((Test-Path -LiteralPath $installedRoot) -and ((Get-Item -LiteralPath $installedRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The installation directory must not be a link.'
}
New-Item -ItemType Directory -Path $installedRoot -Force | Out-Null
$helper = Join-Path $installedRoot 'windows-files.ps1'
$configurationFile = Join-Path $installedRoot 'wsl.json'
$backup = Join-Path $installedRoot ('backups\setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($file in @($helper, $configurationFile)) {
    if (Test-Path -LiteralPath $file) {
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        Copy-Item -LiteralPath $file -Destination (Join-Path $backup (Split-Path $file -Leaf))
    }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'desktop-files\windows-files.ps1') -Destination $helper -Force
$configuration | ConvertTo-Json | Set-Content -LiteralPath $configurationFile -Encoding UTF8

foreach ($name in @('install.py', 'install-web.py')) {
    $script = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('desktop-files\' + $name)))
    $linuxPath = Invoke-SelectedWsl @('wslpath', '-u', $script)
    if ($linuxPath -notmatch '^/' -or $linuxPath -match '[\r\n\x00]') { throw 'Cannot translate the checkout path into the selected WSL distribution.' }
    $arguments = @('python3', $linuxPath)
    if ($name -eq 'install.py') { $arguments += $helper }
    Invoke-SelectedWsl $arguments | Out-Null
}
& (Join-Path $PSScriptRoot 'desktop-client\build-client.ps1')
& (Join-Path $PSScriptRoot 'desktop-client\install-client.ps1')
Write-Output 'Q-agent installed. Open the Q-agent shortcut from the Start Menu.'
