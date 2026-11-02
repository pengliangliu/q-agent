$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try {
    # The client owns startup and keeps WSL alive for the lifetime of its window.
    $client = Join-Path $PSScriptRoot 'client\QAgent.exe'
    if (-not (Test-Path -LiteralPath $client -PathType Leaf)) { throw 'Q-agent client is not installed. Run Install.ps1 first.' }
    Start-Process -FilePath $client -WorkingDirectory (Split-Path $client -Parent) -WindowStyle Normal
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Q-agent', 'OK', 'Error') | Out-Null
    exit 1
}
