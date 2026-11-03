param(
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version = '0.1.0',
    [string]$InnoCompiler = '',
    [switch]$SkipClientBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\')
$release = Join-Path $repository 'release'

function Assert-RegularPath([string]$Path, [string]$Root) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -ne $Root -and -not $full.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A packaging path is outside the expected directory.'
    }
    $item = Get-Item -LiteralPath $full -Force
    while ($item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Packaging inputs and outputs must not be links.' }
        if ($item.FullName -eq $Root) { break }
        $item = if ($item -is [IO.DirectoryInfo]) { $item.Parent } else { $item.Directory }
    }
}

Assert-RegularPath $repository $repository
if (-not $InnoCompiler) {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) { $InnoCompiler = $command.Source }
    else {
        foreach ($folder in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
            if ($folder) {
                $candidate = Join-Path $folder 'Inno Setup 7\ISCC.exe'
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { $InnoCompiler = $candidate; break }
            }
        }
    }
}
if (-not $InnoCompiler -or -not (Test-Path -LiteralPath $InnoCompiler -PathType Leaf)) {
    throw 'Install Inno Setup 7 or pass -InnoCompiler with its ISCC.exe path.'
}
if (-not $SkipClientBuild) { & (Join-Path $repository 'desktop-client\build-client.ps1') }

# A finite list deliberately excludes profiles, logs, tests, credentials and build caches.
$clientNames = @(
    'QAgent.exe', 'QAgent.exe.config', 'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'agent-deck.ico',
    'agent-deck-192.png', 'WebView2-LICENSE.txt', 'WebView2-NOTICE.txt'
)
$files = @(
    'Install.ps1', 'LICENSE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
    'desktop-client/install-client.ps1',
    'installer/Verify-Bundle.ps1', 'installer/Setup-Environment.ps1',
    'installer/Setup-QAgent.ps1', 'installer/Start-QAgent.ps1',
    'installer/bootstrap-wsl.sh', 'installer/bootstrap-wsl.py', 'installer/bootstrap-sources.md',
    'installer/initialize-user.sh'
)
$files += $clientNames | ForEach-Object { 'desktop-client/dist/' + $_ }
$files += @(
    'account-login.py', 'account-sessions.mjs', 'account-terminal.ps1', 'agent-deck-files.py', 'chat-backend.mjs', 'chat-history.py', 'chat-quota.mjs',
    'claude-slash-commands.json', 'claude-statusline.py', 'codex-slash-commands.json',
    'codex-suggestions.mjs', 'command-backend.mjs', 'completion-status.mjs',
    'deliver-now-control.mjs', 'deliver-now.mjs', 'desktop-diagnostics.mjs',
    'install-claude-statusline.py', 'install-web.py', 'install.py', 'message-paths.mjs',
    'model-controls.mjs', 'native-controls.mjs', 'native-suggestions.mjs',
    'Open-AgentDeck-Chinese.ps1', 'output-files.mjs', 'project-backend.mjs',
    'prompt-adapter.mjs', 'terminal-backend.mjs', 'web-server.mjs', 'windows-files.ps1', 'windows-proxy-stdio.py'
) | ForEach-Object { 'desktop-files/' + $_ }
$files += @(
    'desktop-contextmenus.js', 'desktop-ui.css', 'desktop-ui.js', 'favicon.ico',
    'manifest.webmanifest', 'sw.js'
) | ForEach-Object { 'desktop-files/web-ui/overrides/' + $_ }
$files += @(
    'activity.css', 'ActivityPanes.js', 'AppShell.js', 'chat-quota.css', 'chat.css',
    'ChatPanel.js', 'ChatQuota.js', 'codex-theme.css', 'codexLayout.js', 'CommandResult.js',
    'completionNotifications.css', 'CompletionNotifications.js', 'CreateSessionDialog.js',
    'DesktopAttachments.js', 'desktopPreferences.js', 'desktopSettings.css',
    'AccountSettings.js', 'SessionAccount.js', 'DesktopSettings.js', 'DiagnosticsSettings.js', 'icon.css', 'InlinePrompt.js',
    'main.js', 'NativeTerminalPanel.js', 'outputFileReferences.js', 'outputFiles.css',
    'OutputFiles.js', 'paneRegistry.js', 'project.css', 'ProjectActions.js',
    'ProjectDialog.js', 'SessionModelControls.js', 'Sidebar.js', 'SlashCommandMenu.js', 'slashCommandPolicy.js',
    'slashCommands.css', 'terminalLinks.js', 'TerminalPanel.js', 'Topbar.js',
    'uiOperations.js', 'uiState.js'
) | ForEach-Object { 'desktop-files/web-ui/overrides/static/app/' + $_ }
$files += @(
    'agent-deck-128.png', 'agent-deck-180.png', 'agent-deck-192.png', 'agent-deck-256.png',
    'agent-deck-32.png', 'agent-deck-48.png', 'agent-deck-512.png', 'agent-deck-64.png', 'agent-deck.ico'
) | ForEach-Object { 'desktop-files/web-ui/overrides/static/icons/' + $_ }

$clientRoot = Join-Path $repository 'desktop-client/dist'
$unexpected = @(Get-ChildItem -LiteralPath $clientRoot -Force | Where-Object { $_.PSIsContainer -or $_.Name -notin $clientNames })
if ($unexpected.Count) { throw 'The client distribution contains files outside the release allowlist.' }
$buildManifestPath = Join-Path $repository 'desktop-client/build-manifest.json'
Assert-RegularPath $buildManifestPath $repository
$buildManifest = Get-Content -LiteralPath $buildManifestPath -Raw | ConvertFrom-Json
if ($buildManifest.architecture -ne 'x64' -or @($buildManifest.files).Count -ne $clientNames.Count) {
    throw 'The client build manifest is missing or does not describe the expected x64 build.'
}
foreach ($name in $clientNames) {
    $entry = @($buildManifest.files | Where-Object { $_.name -eq $name })
    $inputFile = Join-Path $clientRoot $name
    Assert-RegularPath $inputFile $repository
    if ($entry.Count -ne 1 -or (Get-Item -LiteralPath $inputFile).Length -ne $entry[0].bytes -or
        (Get-FileHash -LiteralPath $inputFile -Algorithm SHA256).Hash -ne $entry[0].sha256) {
        throw "The client build manifest does not match: $name"
    }
    if ($name.EndsWith('.dll')) {
        $signature = Get-AuthenticodeSignature -LiteralPath $inputFile
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation(?:,|$)') {
            throw "Invalid Microsoft signature on client dependency: $name"
        }
    }
}
foreach ($relative in $files) {
    $source = Join-Path $repository $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing release input: $relative" }
    Assert-RegularPath $source $repository
}

if (Test-Path -LiteralPath $release) { Assert-RegularPath $release $repository }
else { [void][IO.Directory]::CreateDirectory($release) }
# Fresh staging prevents leftovers from a previous build entering an installer.
$payload = Join-Path $release ('payload-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($payload)
$inventory = @()
foreach ($relative in ($files | Sort-Object)) {
    $source = Join-Path $repository $relative
    $destination = Join-Path $payload $relative
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
    Copy-Item -LiteralPath $source -Destination $destination
    $digest = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($digest -ne (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash) { throw "Release copy verification failed: $relative" }
    $inventory += [ordered]@{ path = $relative; bytes = (Get-Item -LiteralPath $destination).Length; sha256 = $digest }
}
$manifest = [ordered]@{ schemaVersion = 1; files = $inventory }
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $payload 'bundle-manifest.json'), ($manifest | ConvertTo-Json -Depth 5), $utf8)
. (Join-Path $PSScriptRoot 'Verify-Bundle.ps1')
Test-QAgentBundle -Root $payload
if (@(Get-ChildItem -LiteralPath $payload -File -Recurse -Force).Count -ne $files.Count + 1) {
    throw 'The staged payload contains unexpected files.'
}

# These are the only additional application copies Inno owns outside the payload layout.
$copies = @($clientNames | ForEach-Object { [ordered]@{ source = 'desktop-client/dist/' + $_; destination = 'client/' + $_ } })
$copies += [ordered]@{ source = 'desktop-files/Open-AgentDeck-Chinese.ps1'; destination = 'Open-AgentDeck-Chinese.ps1' }
$copies += [ordered]@{ source = 'desktop-files/windows-files.ps1'; destination = 'windows-files.ps1' }
[IO.File]::WriteAllText((Join-Path $release 'installer-copy-map.json'),
    ([ordered]@{ schemaVersion = 1; copies = $copies } | ConvertTo-Json -Depth 5), $utf8)

$baseName = "Q-agent-Setup-$Version-windows-x64"
$arguments = @('--no-ide-signtools', '--no-signing', "--define=AppVersion=$Version",
    "--define=PayloadDir=$payload", "--output-dir=$release", "--output-filename=$baseName",
    (Join-Path $PSScriptRoot 'QAgent.iss'))
& $InnoCompiler @arguments
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed with exit code $LASTEXITCODE" }
$installer = Join-Path $release ($baseName + '.exe')
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Inno Setup did not produce the expected installer.' }
$sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $release 'SHA256SUMS'), "$sha256  $baseName.exe`n", $utf8)
[pscustomobject]@{ Installer = $installer; Payload = $payload; Files = $inventory.Count;
    Bytes = (Get-Item -LiteralPath $installer).Length; SHA256 = $sha256 }
