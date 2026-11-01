param(
    [ValidateSet('detect','wsl','distro','dependencies','systemd','restart','bridge','webview2')]
    [string]$Stage = 'detect',
    [string]$Distro = '',
    [string]$LinuxUser = '',
    [switch]$Claude,
    [switch]$Codex,
    [string]$ResultFile = '',
    [switch]$FunctionsOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Windows argv quoting, including embedded quotes and trailing backslashes.
function ConvertTo-QAgentArgument([string]$Value) {
    if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
function Invoke-QAgentNative([string]$File, [string[]]$Arguments, [int]$TimeoutSeconds = 120, [switch]$AllowFailure) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $File
    $info.Arguments = ($Arguments | ForEach-Object { ConvertTo-QAgentArgument $_ }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'Cannot start setup command.' }
        # Read bytes: wsl.exe management output may be UTF-16, Linux output is UTF-8.
        $stdout = New-Object IO.MemoryStream
        $stderr = New-Object IO.MemoryStream
        $outTask = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $errTask = $process.StandardError.BaseStream.CopyToAsync($stderr)
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            # Keep the worker and UI locked until the original command completes.
            # Returning a failure here would allow a second apt/WSL install to overlap it.
            Write-Warning 'Setup is taking longer than expected. Waiting for the original command; do not start another installation.'
            $process.WaitForExit()
        }
        [void]$outTask.GetAwaiter().GetResult()
        [void]$errTask.GetAwaiter().GetResult()
        $texts = foreach ($stream in @($stdout, $stderr)) {
            $bytes = $stream.ToArray()
            $encoding = [Text.Encoding]::UTF8
            if ($bytes.Length -gt 1 -and (($bytes[0] -eq 255 -and $bytes[1] -eq 254) -or $bytes[1] -eq 0)) {
                $encoding = [Text.Encoding]::Unicode
            }
            $encoding.GetString($bytes).Trim([char]0xFEFF).Trim()
        }
        $result = [pscustomobject]@{ code = $process.ExitCode; stdout = $texts[0]; stderr = $texts[1] }
        if ($result.code -ne 0 -and -not $AllowFailure) {
            # Dependency managers report useful errors; never print environment or auth files.
            throw ((Split-Path $File -Leaf) + ' failed (' + $result.code + '). ' + $result.stderr + ' ' + $result.stdout)
        }
        return $result
    } finally { $process.Dispose() }
}
function Get-QAgentWindowsStatus {
    $distros = @()
    $lxss = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    if (Test-Path $lxss) {
        foreach ($key in @(Get-ChildItem $lxss)) {
            $entry = Get-ItemProperty $key.PSPath
            if ($entry.PSObject.Properties['DistributionName']) {
                $distros += [pscustomobject]@{ name = $entry.DistributionName; version = $entry.Version }
            }
        }
    }
    $webview = $false
    foreach ($root in @('HKCU:\Software','HKLM:\SOFTWARE','HKLM:\SOFTWARE\WOW6432Node')) {
        $key = Join-Path $root 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
        $entry = Get-ItemProperty $key -ErrorAction SilentlyContinue
        if ($entry -and $entry.PSObject.Properties['pv'] -and $entry.pv -and $entry.pv -ne '0.0.0.0') { $webview = $true }
    }
    $framework = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue
    return [pscustomobject]@{
        distros = $distros; webview = $webview
        framework = [bool]($framework -and $framework.PSObject.Properties['Release'] -and $framework.Release -ge 528040)
        wslCommand = [bool](Get-Command wsl.exe -ErrorAction SilentlyContinue)
    }
}
if ($FunctionsOnly) { return }
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$root = Split-Path $PSScriptRoot -Parent
$result = [ordered]@{ ok = $false; stage = $Stage; message = '' }
try {
    if ($Distro -match '[\x00-\x1f"]' -or $Distro.StartsWith('-') -or
        ($LinuxUser -and ($LinuxUser -notmatch '^[A-Za-z0-9_.-]{1,64}$' -or $LinuxUser.StartsWith('-')))) {
        throw 'Invalid distribution or Linux user.'
    }
    if ($Stage -ne 'detect') {
        . (Join-Path $PSScriptRoot 'Verify-Bundle.ps1')
        Test-QAgentBundle -Root $root
    }
    if ($Stage -notin @('detect','wsl','distro','webview2')) {
        if (-not $Distro) { throw 'Select an initialized WSL distribution first.' }
        $known = @((Get-QAgentWindowsStatus).distros | Where-Object { $_.name -ceq $Distro })
        if ($known.Count -ne 1 -or $known[0].version -ne 2) { throw 'Select an existing WSL2 distribution. WSL1 is not converted automatically.' }
    }
    function Invoke-Selected([string[]]$Command, [switch]$RootUser, [switch]$AllowFailure, [int]$Timeout = 120) {
        $selection = @('-d', $Distro)
        if ($RootUser) { $selection += @('-u','root') }
        elseif ($LinuxUser) { $selection += @('-u',$LinuxUser) }
        if (-not $RootUser) {
            $Command = @('bash','-c','export PATH="$HOME/.local/bin:$PATH"; exec "$@"','q-agent') + $Command
        }
        Invoke-QAgentNative 'wsl.exe' ($selection + @('--exec') + $Command) -TimeoutSeconds $Timeout -AllowFailure:$AllowFailure
    }
    function Get-BootstrapPath {
        (Invoke-Selected @('wslpath','-u',(Join-Path $PSScriptRoot 'bootstrap-wsl.sh'))).stdout
    }
    switch ($Stage) {
        'detect' {
            $result.windows = Get-QAgentWindowsStatus
            if ($Distro) {
                $identity = Invoke-Selected @('id','-u') -AllowFailure
                $result.normalUser = $identity.code -eq 0 -and $identity.stdout -match '^\d+$' -and $identity.stdout -ne '0'
                if ($result.normalUser) {
                    $probe = Invoke-Selected @('bash',(Get-BootstrapPath),'check') -AllowFailure
                    try { $result.linux = $probe.stdout | ConvertFrom-Json }
                    catch { $result.message = 'Linux dependencies are not ready; run step 3.' }
                } else { $result.message = 'Initialize Ubuntu with a normal Linux user in step 2, or specify your existing user.' }
            }
        }
        'wsl' {
            Write-Output 'Installing Windows WSL components. A Windows restart may be required.'
            $command = Invoke-QAgentNative 'wsl.exe' @('--install','--no-distribution','--no-launch') -TimeoutSeconds 3600 -AllowFailure
            if ($command.code -notin @(0,3010)) { throw ('WSL installation failed. ' + $command.stdout + ' ' + $command.stderr) }
            $result.message = 'WSL components installed. If Windows requests a restart, save your work, restart, then reopen Q-agent setup.'
        }
        'distro' {
            if (@((Get-QAgentWindowsStatus).distros | Where-Object { $_.name -eq 'Ubuntu-24.04' }).Count) {
                throw 'Ubuntu-24.04 already exists. Select it and initialize its normal user instead of reinstalling.'
            }
            Write-Output 'Installing the official Ubuntu-24.04 distribution. Internet access is required.'
            Invoke-QAgentNative 'wsl.exe' @('--install','--distribution','Ubuntu-24.04','--no-launch') -TimeoutSeconds 3600 | Out-Null
            $result.message = 'Ubuntu installed. Select Ubuntu-24.04, then open step 2 to create its Linux user and password.'
        }
        'dependencies' {
            if ((Invoke-Selected @('id','-u')).stdout -eq '0') { throw 'Create/select a normal Linux user in step 2 before installing.' }
            $script = Get-BootstrapPath
            Write-Output 'Installing system dependencies in the selected distribution...'
            Invoke-Selected @('bash',$script,'system') -RootUser -Timeout 3600 | Out-Null
            Write-Output 'Installing and verifying Agent Deck, Node.js and the selected assistants...'
            $arguments = @('bash',$script,'user')
            if ($Claude) { $arguments += '--claude' }
            if ($Codex) { $arguments += '--codex' }
            Invoke-Selected $arguments -Timeout 3600 | Out-Null
            $result.message = 'Dependencies installed. Continue with systemd if needed, then connect the client. Sign in using your own assistant accounts.'
        }
        'systemd' {
            Invoke-Selected @('bash',(Get-BootstrapPath),'configure-systemd') -RootUser | Out-Null
            $result.message = 'systemd configured with a backup of the existing settings. Save all work in this distribution before selecting Restart selected WSL.'
        }
        'restart' {
            Invoke-QAgentNative 'wsl.exe' @('--terminate',$Distro) | Out-Null
            $result.message = 'The selected distribution has stopped. Detect again to start it and verify systemd.'
        }
        'bridge' {
            $status = Get-QAgentWindowsStatus
            if (-not $status.framework) { throw '.NET Framework 4.8 is required. Install Windows updates before continuing.' }
            if (-not $status.webview) { throw 'Install WebView2 using the button below before connecting the client.' }
            $parameters = @{ Distro = $Distro; LinuxUser = $LinuxUser; UseBundledClient = $true }
            & (Join-Path $root 'Install.ps1') @parameters -CheckOnly
            & (Join-Path $root 'Install.ps1') @parameters
            $result.message = 'Q-agent is configured. Open your assistant terminal to sign in, then launch the client.'
        }
        'webview2' {
            if (-not (Get-QAgentWindowsStatus).webview) {
                $downloadDir = Join-Path ([IO.Path]::GetTempPath()) ('q-agent-webview-' + [guid]::NewGuid().ToString('N'))
                New-Item -ItemType Directory -Path $downloadDir | Out-Null
                $installer = Join-Path $downloadDir 'MicrosoftEdgeWebview2Setup.exe'
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -UseBasicParsing -OutFile $installer
                $signature = Get-AuthenticodeSignature -LiteralPath $installer
                if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') {
                    throw 'Microsoft installer signature verification failed; it was not executed.'
                }
                Invoke-QAgentNative $installer @('/silent','/install') -TimeoutSeconds 900 | Out-Null
                if (-not (Get-QAgentWindowsStatus).webview) { throw 'WebView2 installation did not finish. Check the Microsoft installer and detect again.' }
            }
            $result.message = 'WebView2 is ready.'
        }
    }
    $result.ok = $true
} catch { $result.message = $_.Exception.Message }
if ($ResultFile) { $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ResultFile -Encoding UTF8 }
Write-Output $result.message
if (-not $result.ok) { exit 1 }
