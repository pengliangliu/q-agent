param(
    [string]$Distro = '',
    [string]$LinuxUser = '',
    [switch]$UseBundledClient,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
if ($Distro -match '[\x00-\x1f"]' -or $Distro.StartsWith('-') -or
    ($LinuxUser -and ($LinuxUser -notmatch '^[A-Za-z0-9_.-]{1,64}$' -or $LinuxUser.StartsWith('-')))) {
    throw 'The WSL distribution or Linux user argument is invalid.'
}
foreach ($relative in @('desktop-files\windows-files.ps1', 'desktop-files\Open-AgentDeck-Chinese.ps1',
    'desktop-files\install.py', 'desktop-files\install-web.py', 'desktop-client\install-client.ps1',
    'installer\Setup-Environment.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $relative) -PathType Leaf)) {
        throw "Missing installation file: $relative"
    }
}
if ($UseBundledClient) {
    . (Join-Path $PSScriptRoot 'installer\Verify-Bundle.ps1')
    Test-QAgentBundle -Root $PSScriptRoot
}
. (Join-Path $PSScriptRoot 'installer\Setup-Environment.ps1') -FunctionsOnly -Distro $Distro -LinuxUser $LinuxUser
$wsl = (Get-Command wsl.exe -ErrorAction Stop).Source
$selection = @()
if ($Distro) { $selection += @('-d', $Distro) }
if ($LinuxUser) { $selection += @('-u', $LinuxUser) }
function Invoke-SelectedWsl([string[]]$CommandArguments) {
    $arguments = $selection + @('--exec', 'bash', '-c', 'export PATH="$HOME/.local/bin:$PATH"; exec "$@"', 'q-agent') + $CommandArguments
    $output = Invoke-QAgentNative $wsl $arguments -AllowFailure
    if ($output.code -ne 0) { throw 'WSL command failed. Check the selected distribution, Linux user, Python 3 and systemd user services.' }
    return $output.stdout.Trim()
}

$installedRoot = Join-Path $env:LOCALAPPDATA 'Programs\QAgent'
$client = Join-Path $installedRoot 'client\QAgent.exe'
if (@(Get-Process -Name QAgent -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $client }).Count) {
    throw 'Close the Windows Q-agent client before installing. WSL model sessions can remain running.'
}
$probe = @'
import json,os,pwd,re,shutil,subprocess,sys
from pathlib import Path
h=Path.home()
def executable(name):
    candidate=shutil.which(name) or str(h/'.local/bin'/name)
    return candidate if Path(candidate).is_file() and os.access(candidate,os.X_OK) else None
result=dict(distro=os.environ.get('WSL_DISTRO_NAME',''),user=pwd.getpwuid(os.getuid()).pw_name,home=str(h),deck=executable('agent-deck'),node=executable('node'),errors=[])
errors=result['errors']
if sys.version_info < (3,8): errors.append('Python 3.8 or newer is required in WSL.')
if os.geteuid()==0: errors.append('Select a normal Linux user, not root.')
if not result['distro']: errors.append('The selected environment is not an initialized WSL distribution.')
def read(args):
    completed=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=15,
        env=dict(os.environ,AGENTDECK_SKIP_UPDATE_CHECK='1'))
    if completed.returncode: raise RuntimeError('command failed')
    return completed.stdout.strip()
if not result['deck']:
    errors.append('Agent Deck v1.16.35 is required in the selected WSL user environment.')
else:
    try:
        if not re.fullmatch(r'Agent Deck v1\.16\.35(?: \(update available: v[^)]+\))?',read([result['deck'],'version'])):
            errors.append('Install the supported Agent Deck release v1.16.35 before continuing.')
    except Exception: errors.append('Cannot verify the Agent Deck version in WSL.')
if not result['node']:
    errors.append('Node.js 22 or newer is required in WSL.')
else:
    try:
        if int(read([result['node'],'-p','process.versions.node.split(".")[0]'])) < 22:
            errors.append('Node.js 22 or newer is required in WSL.')
    except Exception: errors.append('Cannot verify the Node.js version in WSL.')
if not shutil.which('tmux'):
    errors.append('Install tmux in the selected WSL distribution.')
else:
    try:
        if not read(['tmux','-V']).startswith('tmux '): raise RuntimeError('unexpected tmux version')
    except Exception: errors.append('Cannot run tmux in the selected WSL distribution.')
if not shutil.which('wslpath'): errors.append('WSL Windows interoperability is required.')
try:
    if Path('/proc/1/comm').read_text().strip()!='systemd': raise RuntimeError('systemd not enabled')
    if not read(['systemctl','--user','show','--property=Version','--value']): raise RuntimeError('user manager unavailable')
except Exception: errors.append('Enable WSL systemd and ensure the selected Linux user has a working systemd user service manager.')
print(json.dumps(result))
'@
try { $detected = Invoke-SelectedWsl @('python3', '-c', $probe) | ConvertFrom-Json }
catch { throw 'Cannot inspect WSL. Install and initialize the intended distribution, then check Python 3 is available.' }
if (@($detected.errors).Count) { throw ('WSL prerequisites are not ready: ' + ($detected.errors -join ' ')) }
if (-not $detected.distro -or -not $detected.user -or -not $detected.home -or -not $detected.deck -or -not $detected.node) {
    throw 'WSL prerequisites are missing. Install Agent Deck and Node.js for the selected Linux user, then retry.'
}
if ($detected.distro -match '[\x00-\x1f"]' -or $detected.distro.StartsWith('-') -or
    $detected.user -notmatch '^[A-Za-z0-9_.-]{1,64}$' -or $detected.user.StartsWith('-') -or
    $detected.home -notmatch '^/' -or $detected.deck -notmatch '^/' -or
    $detected.home -match '[\x00-\x1f"]' -or $detected.deck -match '[\x00-\x1f"]') {
    throw 'WSL returned an invalid distribution, user or executable path.'
}
$selection = @('-d', [string]$detected.distro, '-u', [string]$detected.user)
$configuration = [ordered]@{ distro = $detected.distro; user = $detected.user; home = $detected.home; deck = $detected.deck }
foreach ($directory in @($installedRoot, (Join-Path $installedRoot 'client'))) {
    if ((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The installation directory must not be a link.'
    }
}
$linuxScripts = @{}
foreach ($name in @('install.py', 'install-web.py')) {
    $script = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('desktop-files\' + $name)))
    $linuxPath = Invoke-SelectedWsl @('wslpath', '-u', $script)
    if ($linuxPath -notmatch '^/' -or $linuxPath -match '[\r\n\x00]') { throw 'Cannot translate the checkout path into the selected WSL distribution.' }
    $linuxScripts[$name] = $linuxPath
}
Invoke-SelectedWsl @('python3', '-c', 'import pathlib,sys; assert all(pathlib.Path(p).is_file() for p in sys.argv[1:])',
    $linuxScripts['install.py'], $linuxScripts['install-web.py']) | Out-Null
if ($CheckOnly) {
    Write-Output 'WSL prerequisites and installation payload checks passed. No configuration or services were changed.'
    return
}
if (-not $UseBundledClient) {
    & (Join-Path $PSScriptRoot 'desktop-client\build-client.ps1')
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
    $arguments = @('python3', $linuxScripts[$name])
    if ($name -eq 'install.py') { $arguments += $helper }
    Invoke-SelectedWsl $arguments | Out-Null
}
& (Join-Path $PSScriptRoot 'desktop-client\install-client.ps1') -SkipShortcuts:$UseBundledClient
Write-Output 'Q-agent installed. Open the Q-agent shortcut from the Start Menu.'
