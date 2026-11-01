$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$buildRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$sdkVersion = '1.0.4314.35'
$sdkSha256 = '90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4'
$packageRoot = Join-Path $buildRoot 'packages'
$package = Join-Path $packageRoot "Microsoft.Web.WebView2.$sdkVersion.nupkg"
$sdkRoot = Join-Path $buildRoot "packages\Microsoft.Web.WebView2.$sdkVersion"
$frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $frameworkRoot 'csc.exe'
$staging = Join-Path $buildRoot '.build'
$distribution = Join-Path $buildRoot 'dist'
$iconRoot = [IO.Path]::GetFullPath((Join-Path $buildRoot '..\desktop-files\web-ui\overrides\static\icons'))
$sources = @('Program.cs', 'MainForm.cs', 'ShortcutRegistration.cs') | ForEach-Object { Join-Path $buildRoot $_ }
$manifest = Join-Path $buildRoot 'app.manifest'
$config = Join-Path $buildRoot 'QAgent.exe.config'
$icon = Join-Path $iconRoot 'agent-deck.ico'
$png = Join-Path $iconRoot 'agent-deck-192.png'
$dependencies = @(
    (Join-Path $sdkRoot 'lib\net462\Microsoft.Web.WebView2.Core.dll'),
    (Join-Path $sdkRoot 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'),
    (Join-Path $sdkRoot 'runtimes\win-x64\native\WebView2Loader.dll')
)
$frameworkReferences = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll') |
    ForEach-Object { Join-Path $frameworkRoot $_ }
$winrtReferences = @(
    (Join-Path $env:WINDIR 'System32\WinMetadata\Windows.UI.winmd'),
    (Join-Path $env:WINDIR 'System32\WinMetadata\Windows.Data.winmd'),
    (Join-Path $env:WINDIR 'System32\WinMetadata\Windows.Foundation.winmd'),
    (Join-Path $frameworkRoot 'System.Runtime.WindowsRuntime.dll')
)
foreach ($assembly in @('System.Runtime', 'System.Runtime.InteropServices.WindowsRuntime', 'System.ObjectModel')) {
    $winrtReferences += Join-Path $env:WINDIR "Microsoft.NET\assembly\GAC_MSIL\$assembly\v4.0_4.0.0.0__b03f5f7f11d50a3a\$assembly.dll"
}
$license = Join-Path $sdkRoot 'LICENSE.txt'
$notice = Join-Path $sdkRoot 'NOTICE.txt'
$required = @($compiler, $manifest, $config, $icon, $png) + $sources + $frameworkReferences + $winrtReferences
foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing build input: $file" }
}

foreach ($directory in @($packageRoot, $sdkRoot)) {
    if (Test-Path -LiteralPath $directory) {
        if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Package directory must not be a link: $directory" }
    } else { [void](New-Item -ItemType Directory -Path $directory) }
}
if (-not (Test-Path -LiteralPath $package -PathType Leaf)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $uri = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg"
    Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $package
}
if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ne $sdkSha256) { throw 'WebView2 package checksum mismatch. Remove the local package and download it again.' }
if (@($dependencies + @($license, $notice) | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($package)
    try {
        $prefix = [IO.Path]::GetFullPath($sdkRoot).TrimEnd('\') + '\'
        $needed = @('lib/net462/Microsoft.Web.WebView2.Core.dll', 'lib/net462/Microsoft.Web.WebView2.WinForms.dll',
            'runtimes/win-x64/native/WebView2Loader.dll', 'LICENSE.txt', 'NOTICE.txt')
        foreach ($name in $needed) {
            $entry = $archive.GetEntry($name)
            if (-not $entry) { throw "Missing SDK package entry: $name" }
            $destination = [IO.Path]::GetFullPath((Join-Path $sdkRoot $entry.FullName))
            if (-not $destination.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'WebView2 package contains an invalid path.' }
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
        }
    } finally { $archive.Dispose() }
}
foreach ($file in @($license, $notice) + $dependencies) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing SDK input: $file" }
}

$signatureEvidence = @()
foreach ($file in $dependencies) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation(?:,|$)') {
        throw "WebView2 dependency does not have a valid Microsoft signature: $file"
    }
    $signatureEvidence += [ordered]@{ name = [IO.Path]::GetFileName($file); status = [string]$signature.Status; signer = $signature.SignerCertificate.Subject }
}

foreach ($directory in @($staging, $distribution)) {
    if (Test-Path -LiteralPath $directory) {
        if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Build directory must not be a link: $directory" }
    } else { [void](New-Item -ItemType Directory -Path $directory) }
}
$allowed = @('QAgent.exe', 'QAgent.exe.config', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll', 'agent-deck.ico', 'agent-deck-192.png', 'WebView2-LICENSE.txt', 'WebView2-NOTICE.txt')
$unexpected = @(Get-ChildItem -LiteralPath $distribution -Force | Where-Object { $_.PSIsContainer -or $_.Name -notin $allowed })
if ($unexpected.Count) { throw ('Unexpected files in dist; no files were removed: ' + ($unexpected.Name -join ', ')) }

$executable = Join-Path $staging 'QAgent.exe'
$arguments = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/debug-', '/codepage:65001', '/utf8output',
    "/out:$executable", "/win32icon:$icon", "/win32manifest:$manifest")
foreach ($reference in @($frameworkReferences + $winrtReferences + $dependencies[0..1])) { $arguments += "/reference:$reference" }
$arguments += $sources
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw "C# compilation failed with exit code $LASTEXITCODE" }

$image = [IO.File]::ReadAllBytes($executable)
$pe = [BitConverter]::ToInt32($image, 0x3c)
if ([BitConverter]::ToUInt16($image, $pe + 4) -ne 0x8664 -or [BitConverter]::ToUInt16($image, $pe + 24 + 68) -ne 2) {
    throw 'Build output is not an x64 Windows GUI executable.'
}
$packageSources = [ordered]@{ 'QAgent.exe' = $executable; 'QAgent.exe.config' = $config;
    'agent-deck.ico' = $icon; 'agent-deck-192.png' = $png; 'WebView2-LICENSE.txt' = $license; 'WebView2-NOTICE.txt' = $notice }
foreach ($dependency in $dependencies) { $packageSources[[IO.Path]::GetFileName($dependency)] = $dependency }
$files = @()
foreach ($name in $packageSources.Keys) {
    $destination = Join-Path $distribution $name
    Copy-Item -LiteralPath $packageSources[$name] -Destination $destination -Force
    $sourceHash = (Get-FileHash -LiteralPath $packageSources[$name] -Algorithm SHA256).Hash
    $copiedHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    if ($sourceHash -ne $copiedHash) { throw "Package copy failed SHA256 verification: $name" }
    $files += [ordered]@{ name = $name; bytes = (Get-Item -LiteralPath $destination).Length; sha256 = $copiedHash }
}
$report = [ordered]@{ builtAt = [DateTime]::UtcNow.ToString('o'); executable = 'QAgent.exe'; architecture = 'x64';
    distribution = 'dist'; sdkVersion = $sdkVersion; sdkPackageSha256 = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash;
    dependencySignatures = $signatureEvidence; files = $files; totalBytes = ($files | ForEach-Object { $_['bytes'] } | Measure-Object -Sum).Sum }
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $buildRoot 'build-manifest.json') -Encoding UTF8
[pscustomobject]@{ Distribution = 'dist'; Files = $files.Count; Bytes = $report.totalBytes; MiB = [Math]::Round($report.totalBytes / 1MB, 3) }
