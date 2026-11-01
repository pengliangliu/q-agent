$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try {
    $configurationFile = Join-Path $PSScriptRoot 'wsl.json'
    if (-not (Test-Path -LiteralPath $configurationFile -PathType Leaf)) { throw 'Run Install.ps1 to configure the WSL connection first.' }
    $configuration = Get-Content -LiteralPath $configurationFile -Raw | ConvertFrom-Json
    if (-not $configuration.distro -or $configuration.distro -match '[\x00-\x1f"]' -or $configuration.distro.StartsWith('-') -or
        $configuration.user -notmatch '^[A-Za-z0-9_.-]{1,64}$') { throw 'The local WSL configuration is invalid. Run Install.ps1 again.' }
    $wslArguments = @('-d', [string]$configuration.distro, '-u', [string]$configuration.user, '--exec',
        'systemctl', '--user', 'start', 'agent-deck-web-local.service', 'agent-deck-desktop.service')
    & wsl.exe @wslArguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Q-agent services could not start. Check WSL systemd user services and rerun Install.ps1 if needed.' }
    $ready = $false
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8421/' -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw 'Q-agent is not responding on localhost:8421.' }
    $client = Join-Path $PSScriptRoot 'client\QAgent.exe'
    if (-not (Test-Path -LiteralPath $client -PathType Leaf)) { throw 'Q-agent client is not installed. Run Install.ps1 first.' }
    Start-Process -FilePath $client -WorkingDirectory (Split-Path $client -Parent) -WindowStyle Normal
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Q-agent', 'OK', 'Error') | Out-Null
    exit 1
}
