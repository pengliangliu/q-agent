param(
    [string]$Action,
    [string]$InitialDirectory,
    [string]$Path,
    [string]$SavePath,
    [string]$Message,
    [string]$SessionId,
    [string]$TerminalProfile = 'default'
)

# Run with powershell.exe -NoProfile -STA -WindowStyle Hidden -File <script>.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$owner = $null
$dialog = $null
$failureMessage = 'Windows 文件操作失败。'
function Write-Json($Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 4))
}

try {
    if ($Action -notin @('pick', 'clipboard', 'prompt', 'reveal', 'open-file', 'folder', 'terminal')) {
        $failureMessage = '不支持此 Windows 桌面操作。'
        throw $failureMessage
    }
    if ($Action -eq 'terminal') {
        $failureMessage = '会话或配置标识无效。'
        if ($SessionId -notmatch '^[A-Za-z0-9-]{1,120}$' -or $TerminalProfile -notmatch '^[A-Za-z0-9_.-]{1,80}$') {
            throw $failureMessage
        }
        $failureMessage = '本地 WSL 配置缺失或无效，请重新运行 Install.ps1。'
        $configurationFile = Join-Path $PSScriptRoot 'wsl.json'
        if (-not (Test-Path -LiteralPath $configurationFile -PathType Leaf)) { throw $failureMessage }
        $configuration = Get-Content -LiteralPath $configurationFile -Raw | ConvertFrom-Json
        if (-not $configuration.distro -or $configuration.distro -match '[\x00-\x1f"]' -or $configuration.distro.StartsWith('-') -or
            $configuration.user -notmatch '^[A-Za-z0-9_.-]{1,64}$' -or $configuration.deck -notmatch '^/' -or
            $configuration.deck -match '[\x00-\x1f"]') { throw $failureMessage }
        $failureMessage = '未找到 Windows Terminal。'
        $terminal = (Get-Command wt.exe -ErrorAction SilentlyContinue).Source
        if (-not $terminal) {
            $terminalRoot = Join-Path $env:LOCALAPPDATA 'Programs\QAgent\terminal'
            $terminal = Get-ChildItem -LiteralPath $terminalRoot -Directory -Filter 'terminal-*' |
                Sort-Object LastWriteTime -Descending |
                ForEach-Object { Join-Path $_.FullName 'wt.exe' } |
                Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
                Select-Object -First 1
        }
        if (-not $terminal) { throw $failureMessage }
        $failureMessage = '无法打开当前会话的独立终端。'
        $arguments = @('-w', 'new', 'new-tab', '--title', "Q-agent - $SessionId",
            (Join-Path $env:WINDIR 'System32\wsl.exe'), '-d', [string]$configuration.distro, '-u', [string]$configuration.user, '--exec',
            [string]$configuration.deck, '-p', $TerminalProfile, 'session', 'attach', $SessionId)
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = $terminal
        # All variable arguments are validated identifiers or Windows paths;
        # launch directly, with native quoting, without cmd.exe or a shell string.
        $start.Arguments = ($arguments | ForEach-Object { '"' + ($_ -replace '(\\+)$', '$1$1') + '"' }) -join ' '
        $start.UseShellExecute = $false
        $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
        $process = [Diagnostics.Process]::Start($start)
        if (-not $process) { throw $failureMessage }
        $process.Dispose()
        Write-Json @{ success = $true; sessionId = $SessionId }
        exit 0
    }
    if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
        $failureMessage = '请使用 powershell.exe -STA 运行此脚本。'
        throw $failureMessage
    }
    $failureMessage = '无法加载 Windows 原生对话框组件。'
    Add-Type -AssemblyName System.Windows.Forms
    if ($Action -in @('pick', 'prompt', 'folder')) {
        $owner = New-Object System.Windows.Forms.Form
        $owner.ShowInTaskbar = $false
        $owner.TopMost = $true
        $owner.Opacity = 0
        $owner.Show()
        $owner.Activate()
    }
    switch ($Action) {
        'folder' {
            $failureMessage = '无法打开目录选择窗口。'
            $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
            $dialog.Description = '选择项目目录 - Q-agent'
            $dialog.ShowNewFolderButton = $false
            if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
                Write-Json @{ path = $dialog.SelectedPath }
            } else { Write-Json @{ cancelled = $true } }
        }
        'pick' {
            $failureMessage = '无法打开文件选择对话框。'
            $dialog = New-Object System.Windows.Forms.OpenFileDialog
            $dialog.Multiselect = $true
            $dialog.CheckFileExists = $true
            $dialog.Title = '选择图片或文件 - Q-agent'
            $dialog.Filter = '所有文件|*.*|图片|*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp;*.tif;*.tiff;*.ico;*.heic'
            if ($Message) { $dialog.Title = $Message }
            if ($InitialDirectory -and (Test-Path -LiteralPath $InitialDirectory -PathType Container)) {
                $dialog.InitialDirectory = (Get-Item -LiteralPath $InitialDirectory -Force).FullName
            }
            if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
                Write-Json @{ paths = @($dialog.FileNames) }
            } else { Write-Json @{ cancelled = $true } }
        }
        'clipboard' {
            $failureMessage = '无法读取剪贴板；请稍后重试。'
            if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
                if ([string]::IsNullOrWhiteSpace($SavePath)) {
                    $failureMessage = '保存剪贴板图片需要提供 SavePath。'
                    throw $failureMessage
                }
                $failureMessage = '无法保存剪贴板图片；请检查目标目录及权限，并确保文件尚不存在。'
                $destination = [IO.Path]::GetFullPath($SavePath)
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
                $picture = [System.Windows.Forms.Clipboard]::GetImage()
                $stream = $null
                try {
                    $stream = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
                    $picture.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                } finally {
                    if ($stream) { $stream.Dispose() }
                    if ($picture) { $picture.Dispose() }
                }
                Write-Json @{ paths = @($destination) }
            } elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
                Write-Json @{ paths = @([System.Windows.Forms.Clipboard]::GetFileDropList()) }
            } else {
                $failureMessage = '剪贴板中没有图片或复制的文件；请先截图或复制文件。'
                throw $failureMessage
            }
        }
        'prompt' {
            $failureMessage = '无法打开路径输入对话框。'
            Add-Type -AssemblyName Microsoft.VisualBasic
            if (-not $Message) { $Message = '请粘贴 Windows 或 Linux 文件路径：' }
            $entered = [Microsoft.VisualBasic.Interaction]::InputBox($Message, '定位文件或目录 - Q-agent', '')
            if ([string]::IsNullOrWhiteSpace($entered)) { Write-Json @{ cancelled = $true } }
            else { Write-Json @{ path = $entered } }
        }
        'open-file' {
            $failureMessage = '文件不存在，或无法访问。'
            if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
                throw $failureMessage
            }
            $item = Get-Item -LiteralPath $Path -Force
            $allowed = @('.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.tsv',
                '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.ico',
                '.mp4', '.mov', '.webm', '.mp3', '.wav', '.ogg', '.m4a')
            $failureMessage = '此类型请使用“显示位置”查看。'
            if ($item.PSProvider.Name -ne 'FileSystem' -or $item.Extension.ToLowerInvariant() -notin $allowed) {
                throw $failureMessage
            }
            $failureMessage = '无法打开此文件，请检查默认应用。'
            $start = New-Object System.Diagnostics.ProcessStartInfo
            $start.FileName = $item.FullName
            $start.UseShellExecute = $true
            $start.Verb = 'open'
            $process = [Diagnostics.Process]::Start($start)
            if ($process) { $process.Dispose() }
            Write-Json @{ paths = @($item.FullName) }
        }
        'reveal' {
            $failureMessage = '文件或目录不存在，或无法访问。'
            if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
                throw $failureMessage
            }
            $item = Get-Item -LiteralPath $Path -Force
            if ($item.PSProvider.Name -ne 'FileSystem') { throw $failureMessage }
            $failureMessage = '无法在资源管理器中打开此位置。'
            $start = New-Object System.Diagnostics.ProcessStartInfo
            $start.FileName = Join-Path $env:WINDIR 'explorer.exe'
            $start.UseShellExecute = $false
            # Escape trailing backslashes according to native Windows argument rules.
            $quotedPath = '"' + ($item.FullName -replace '(\\+)$', '$1$1') + '"'
            if ($item.PSIsContainer) { $start.Arguments = $quotedPath }
            else { $start.Arguments = '/select,' + $quotedPath }
            $process = [Diagnostics.Process]::Start($start)
            if ($process) { $process.Dispose() }
            Write-Json @{ paths = @($item.FullName) }
        }
    }
} catch {
    Write-Json @{ error = $failureMessage }
    exit 1
} finally {
    if ($dialog) { $dialog.Dispose() }
    if ($owner) { $owner.Dispose() }
}
