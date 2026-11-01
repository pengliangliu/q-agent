# Validate only relative payload entries; no installed profile or model state is read.
function Test-QAgentBundle {
    param([Parameter(Mandatory = $true)][string]$Root)

    $releaseRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $prefix = $releaseRoot + '\'
    if ((Get-Item -LiteralPath $releaseRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'The installer payload directory must not be a link.'
    }
    $manifestPath = Join-Path $releaseRoot 'bundle-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'The installer bundle manifest is missing.' }
    if ((Get-Item -LiteralPath $manifestPath).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'The installer bundle manifest must not be a link.'
    }
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json }
    catch { throw 'The installer bundle manifest cannot be read.' }
    if ($manifest.schemaVersion -ne 1 -or -not $manifest.files) { throw 'The installer bundle manifest format is unsupported.' }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $manifest.files) {
        $relative = [string]$file.path
        if (-not $relative -or $relative -match '[\\:\x00-\x1f]' -or $relative.StartsWith('/') -or
            @($relative.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -or
            $file.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -or $file.bytes -lt 0 -or -not $seen.Add($relative)) {
            throw 'The installer bundle manifest contains an invalid or duplicate entry.'
        }
        $target = [IO.Path]::GetFullPath((Join-Path $releaseRoot $relative))
        if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Missing installer payload file: $relative" }
        $item = Get-Item -LiteralPath $target
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The installer payload must not contain file links.' }
        $directory = $item.Directory
        while ($directory -and $directory.FullName -ne $releaseRoot) {
            if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The installer payload must not contain directory links.' }
            $directory = $directory.Parent
        }
        if ((Get-Item -LiteralPath $target).Length -ne $file.bytes -or
            (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256) {
            throw "Installer payload checksum mismatch: $relative"
        }
    }
    $required = @('QAgent.exe', 'QAgent.exe.config', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll',
        'WebView2Loader.dll', 'agent-deck.ico', 'agent-deck-192.png', 'WebView2-LICENSE.txt', 'WebView2-NOTICE.txt')
    foreach ($name in $required) {
        if (-not $seen.Contains('desktop-client/dist/' + $name)) { throw "Required client file is absent from the bundle manifest: $name" }
    }
    $unexpected = @(Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'desktop-client/dist') -Force |
        Where-Object { $_.PSIsContainer -or $_.Name -notin $required })
    if ($unexpected.Count) { throw 'The bundled client directory contains unexpected files.' }
}
