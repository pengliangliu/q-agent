# Called by the local WSL bridge. The provider owns the interactive terminal.
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($data.tool -cnotin @('claude','codex') -or $data.distro -notmatch '^[^\x00-\x1f"-][^\x00-\x1f"]*$' -or
    $data.user -notmatch '^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$') { throw 'Invalid WSL target' }
foreach ($path in @($data.helper,$data.binary,$data.directory)) {
    if ($path -notmatch '^/' -or $path -match '[\x00-\x1f"]') { throw 'Invalid native path' }
}
$arguments = @('-d',$data.distro,'-u',$data.user,'--cd','~','--exec','/usr/bin/python3',$data.helper,
    'interactive',$data.tool,'--binary',$data.binary,'--directory',$data.directory)
$line = ($arguments | ForEach-Object {
    if ($_ -match '\s') { '"' + ($_ -replace '(\\+)$','$1$1') + '"' } else { $_ }
}) -join ' '
$wsl = Join-Path $env:ProgramFiles 'WSL\wsl.exe'
if (-not (Test-Path -LiteralPath $wsl -PathType Leaf)) { $wsl = Join-Path $env:WINDIR 'System32\wsl.exe' }
Start-Process -FilePath $wsl -ArgumentList $line -WindowStyle Normal
