# Native Windows setup UI. Long-running commands run in a separate worker process.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
. (Join-Path $PSScriptRoot 'Setup-Environment.ps1') -FunctionsOnly
$root = Split-Path $PSScriptRoot -Parent
$created = $false
$mutex = New-Object Threading.Mutex($true, 'Local\QAgent.Setup', [ref]$created)
if (-not $created) {
    [Windows.Forms.MessageBox]::Show('配置向导已经打开，请在现有窗口继续。', 'Q-agent') | Out-Null
    $mutex.Dispose()
    return
}
$script:worker = $null
$script:resultPath = ''
$script:actionButtons = @()
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$form = New-Object Windows.Forms.Form
$form.Text = 'Q-agent · 首次配置与修复'
$form.ClientSize = New-Object Drawing.Size(880,690)
$form.MinimumSize = New-Object Drawing.Size(896,729)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI',9)
$icon = Join-Path $root 'desktop-client\dist\agent-deck.ico'
if (Test-Path $icon) { $form.Icon = New-Object Drawing.Icon($icon) }

$layout = New-Object Windows.Forms.TableLayoutPanel
$layout.Dock = 'Fill'
$layout.Padding = New-Object Windows.Forms.Padding(24)
$layout.ColumnCount = 1
$layout.RowCount = 11
foreach ($height in @(40,48,42,38,42,38,42,38,42)) {
    $layout.RowStyles.Add((New-Object Windows.Forms.RowStyle('Absolute',$height))) | Out-Null
}
$layout.RowStyles.Add((New-Object Windows.Forms.RowStyle('Percent',100))) | Out-Null
$layout.RowStyles.Add((New-Object Windows.Forms.RowStyle('Absolute',28))) | Out-Null
$form.Controls.Add($layout)
function Add-SetupLabel([string]$Text, [int]$Row, [bool]$Bold = $false) {
    $label = New-Object Windows.Forms.Label
    $label.Text = $Text
    $label.Dock = 'Fill'
    $label.TextAlign = 'MiddleLeft'
    if ($Bold) { $label.Font = New-Object Drawing.Font($form.Font,[Drawing.FontStyle]::Bold) }
    $layout.Controls.Add($label,0,$Row)
    return $label
}
function Add-SetupRow([int]$Row) {
    $panel = New-Object Windows.Forms.FlowLayoutPanel
    $panel.Dock = 'Fill'
    $panel.WrapContents = $false
    $layout.Controls.Add($panel,0,$Row)
    return $panel
}
function Add-SetupButton($Panel,[string]$Text,[scriptblock]$Click) {
    $button = New-Object Windows.Forms.Button
    $button.Text = $Text
    $button.AutoSize = $true
    $button.Height = 32
    $button.MinimumSize = New-Object Drawing.Size(120,32)
    $button.Margin = New-Object Windows.Forms.Padding(0,0,10,0)
    $button.Add_Click({ try { & $Click } catch { Show-SetupError $_.Exception.Message } }.GetNewClosure())
    $Panel.Controls.Add($button)
    $script:actionButtons += $button
    return $button
}
function Show-SetupError([string]$Message) {
    $log.Text = $Message
    [Windows.Forms.MessageBox]::Show($form,$Message,'Q-agent','OK','Warning') | Out-Null
}
function Refresh-SetupWindows {
    $current = [string]$distroBox.SelectedItem
    $state = Get-QAgentWindowsStatus
    $distroBox.Items.Clear()
    foreach ($entry in $state.distros) { $distroBox.Items.Add([string]$entry.name) | Out-Null }
    if ($current -and $distroBox.Items.Contains($current)) { $distroBox.SelectedItem = $current }
    elseif ($distroBox.Items.Count) { $distroBox.SelectedIndex = 0 }
    $runtime = if ($state.webview) { 'WebView2 已就绪' } else { 'WebView2 待安装' }
    $status.Text = '已发现 ' + $state.distros.Count + ' 个 WSL 发行版 · ' + $runtime
    $installUbuntu.Enabled = -not @($state.distros | Where-Object { $_.name -eq 'Ubuntu-24.04' }).Count
    $webviewButton.Enabled = -not $state.webview
    if (-not $state.framework) { $log.Text = '需要 .NET Framework 4.8。请完成 Windows 更新后继续。' }
}
function Start-SetupStage([string]$Name,[switch]$Elevate) {
    if ($script:worker) { return }
    $selected = [string]$distroBox.SelectedItem
    if ($Name -notin @('detect','wsl','distro','webview2') -and -not $selected) { throw '请先安装并选择 WSL 发行版。' }
    $logDir = Join-Path $env:LOCALAPPDATA 'QAgent\setup'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $id = [guid]::NewGuid().ToString('N')
    $script:resultPath = Join-Path $logDir ($id + '.json')
    $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'Setup-Environment.ps1'),
        '-Stage',$Name,'-ResultFile',$script:resultPath)
    if ($selected) { $args += @('-Distro',$selected) }
    if ($userBox.Text.Trim()) { $args += @('-LinuxUser',$userBox.Text.Trim()) }
    if ($claudeBox.Checked) { $args += '-Claude' }
    if ($codexBox.Checked) { $args += '-Codex' }
    $start = @{ FilePath = $powershell; ArgumentList = (($args | ForEach-Object { ConvertTo-QAgentArgument $_ }) -join ' '); PassThru = $true; WindowStyle = 'Hidden' }
    if ($Elevate) { $start.Verb = 'RunAs' }
    else {
        $start.RedirectStandardOutput = Join-Path $logDir ($id + '.out.log')
        $start.RedirectStandardError = Join-Path $logDir ($id + '.err.log')
    }
    $script:worker = Start-Process @start
    foreach ($button in $script:actionButtons) { $button.Enabled = $false }
    $distroBox.Enabled = $false
    $userBox.Enabled = $false
    $claudeBox.Enabled = $false
    $codexBox.Enabled = $false
    $progress.Style = 'Marquee'
    $names = @{ detect='环境检测'; wsl='WSL 安装'; distro='Ubuntu 安装'; dependencies='依赖安装'; systemd='systemd 配置'; restart='WSL 重启'; bridge='客户端连接'; webview2='WebView2 安装' }
    $status.Text = '正在执行' + $names[$Name] + ' · 下载和首次安装可能需要数分钟'
    $log.Text = '当前操作在后台执行，请保持此窗口打开。不会自动重启 Windows。完成后这里会显示结果。'
    $timer.Start()
}
function Open-SetupTerminal([string]$Assistant = '') {
    $selected = [string]$distroBox.SelectedItem
    if (-not $selected) { throw '请先选择 WSL 发行版。' }
    $args = @('-d',$selected)
    if ($Assistant -eq 'create-user') {
        $scriptPath = (Invoke-QAgentNative 'wsl.exe' @('-d',$selected,'-u','root','--exec','wslpath','-u',(Join-Path $PSScriptRoot 'initialize-user.sh'))).stdout
        $args += @('-u','root','--exec','bash',$scriptPath)
    } elseif ($userBox.Text.Trim()) {
        if ($userBox.Text.Trim() -notmatch '^[A-Za-z0-9_.-]{1,64}$' -or $userBox.Text.Trim().StartsWith('-')) { throw 'Linux 用户名格式无效。' }
        $args += @('-u',$userBox.Text.Trim())
    }
    if ($Assistant -and $Assistant -ne 'create-user') {
        # Fixed commands only: no user-entered values are interpolated into shell code.
        $command = if ($Assistant -eq 'claude') { 'export PATH="$HOME/.local/bin:$PATH"; exec claude' }
            else { 'export PATH="$HOME/.local/bin:$PATH"; exec codex login' }
        $args += @('--exec','bash','-lc',$command)
    }
    Start-Process -FilePath 'wsl.exe' -ArgumentList (($args | ForEach-Object { ConvertTo-QAgentArgument $_ }) -join ' ') -WindowStyle Normal
}

Add-SetupLabel 'Q-agent  /  配置你的本地助手环境' 0 $true | Out-Null
Add-SetupLabel "已有环境可直接检测并复用。新电脑依次完成下面的步骤；需要联网下载依赖。`nWSL 的项目、会话及助手登录保存在当前电脑，由你自己管理。" 1 | Out-Null
$selection = Add-SetupRow 2
$distroBox = New-Object Windows.Forms.ComboBox
$distroBox.Width = 235
$distroBox.DropDownStyle = 'DropDownList'
$selection.Controls.Add($distroBox)
$userBox = New-Object Windows.Forms.TextBox
$userBox.Width = 160
$selection.Controls.Add($userBox)
$tip = New-Object Windows.Forms.ToolTip
$tip.SetToolTip($distroBox,'选择已有的 WSL2 发行版')
$tip.SetToolTip($userBox,'Linux 用户名；留空使用发行版默认用户。不要填写密码。')
$hint = New-Object Windows.Forms.Label
$hint.Text = '用户名留空 = 默认用户'
$hint.AutoSize = $true
$hint.Padding = New-Object Windows.Forms.Padding(0,6,8,0)
$selection.Controls.Add($hint)
Add-SetupButton $selection '检测 / 刷新' { Start-SetupStage 'detect' } | Out-Null
Add-SetupLabel '1–2  准备 WSL 与 Linux 用户' 3 $true | Out-Null
$windowsRow = Add-SetupRow 4
Add-SetupButton $windowsRow '启用 / 安装 WSL' {
    if ([Windows.Forms.MessageBox]::Show($form,'将请求管理员权限安装 Windows WSL 组件；完成后可能需要你自行重启电脑。继续？','安装 WSL','YesNo','Question') -eq 'Yes') { Start-SetupStage 'wsl' -Elevate }
} | Out-Null
$installUbuntu = Add-SetupButton $windowsRow '安装 Ubuntu 24.04' { Start-SetupStage 'distro' }
Add-SetupButton $windowsRow '打开 Linux' { Open-SetupTerminal } | Out-Null
Add-SetupButton $windowsRow '创建 Linux 用户' { Open-SetupTerminal 'create-user' } | Out-Null
Add-SetupLabel '3  安装依赖与助手；已有兼容程序会复用' 5 $true | Out-Null
$dependencyRow = Add-SetupRow 6
$claudeBox = New-Object Windows.Forms.CheckBox
$claudeBox.Text = 'Claude Code'
$claudeBox.Checked = $true
$claudeBox.Width = 130
$dependencyRow.Controls.Add($claudeBox)
$codexBox = New-Object Windows.Forms.CheckBox
$codexBox.Text = 'Codex CLI'
$codexBox.Checked = $true
$codexBox.Width = 110
$dependencyRow.Controls.Add($codexBox)
Add-SetupButton $dependencyRow '安装 WSL 依赖' { Start-SetupStage 'dependencies' } | Out-Null
Add-SetupButton $dependencyRow '启用 systemd' { Start-SetupStage 'systemd' } | Out-Null
Add-SetupButton $dependencyRow '重启所选 WSL' {
    if ([Windows.Forms.MessageBox]::Show($form,'这会停止所选发行版内的所有任务和终端。请先保存工作并结束运行中的任务。现在重启？','重启所选 WSL','YesNo','Warning') -eq 'Yes') { Start-SetupStage 'restart' }
} | Out-Null
Add-SetupLabel '4  连接客户端，再使用自己的账号登录助手' 7 $true | Out-Null
$finishRow = Add-SetupRow 8
$webviewButton = Add-SetupButton $finishRow '安装 WebView2' { Start-SetupStage 'webview2' }
Add-SetupButton $finishRow '连接 / 更新客户端' { Start-SetupStage 'bridge' } | Out-Null
Add-SetupButton $finishRow 'Claude 登录' { Open-SetupTerminal 'claude' } | Out-Null
Add-SetupButton $finishRow 'Codex 登录' { Open-SetupTerminal 'codex' } | Out-Null
Add-SetupButton $finishRow '启动 Q-agent' {
    if (-not (Test-Path -LiteralPath (Join-Path $root 'wsl.json'))) { throw '请先完成“连接 / 更新客户端”。' }
    Start-Process -FilePath $powershell -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (ConvertTo-QAgentArgument (Join-Path $PSScriptRoot 'Start-QAgent.ps1'))) -WindowStyle Hidden
} | Out-Null
$log = New-Object Windows.Forms.TextBox
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = 'Vertical'
$log.Dock = 'Fill'
$log.Text = "首次安装：启用 WSL → 安装 Ubuntu → 打开 Linux 完成初始化 → 安装依赖 → 检测 systemd → 连接客户端。`r`n若打开 Linux 后直接进入 root，请点击「创建 Linux 用户」，创建后将用户名填入上方输入栏。密码只在 Linux 终端输入。`r`n如果检测结果已就绪，可直接连接客户端。Windows 重启后，从开始菜单重新打开「Q-agent 配置」。"
$layout.Controls.Add($log,0,9)
$bottom = Add-SetupRow 10
$status = New-Object Windows.Forms.Label
$status.Width = 620
$status.Height = 25
$bottom.Controls.Add($status)
$progress = New-Object Windows.Forms.ProgressBar
$progress.Width = 170
$progress.Height = 18
$bottom.Controls.Add($progress)
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
    if (-not $script:worker -or -not $script:worker.HasExited) { return }
    $timer.Stop()
    $progress.Style = 'Blocks'
    try {
        if (-not (Test-Path -LiteralPath $script:resultPath)) { throw '操作未返回结果。请查看本机 %LOCALAPPDATA%\QAgent\setup 日志；确认旧操作已结束后再试。' }
        $result = Get-Content -LiteralPath $script:resultPath -Raw | ConvertFrom-Json
        $log.Text = [string]$result.message
        if ($result.stage -eq 'detect' -and $result.PSObject.Properties['linux']) {
            $lines = @('Linux 环境检测：')
            foreach ($property in $result.linux.commands.PSObject.Properties) {
                $ready = if ($property.Value.ok) { '就绪' } else { '缺失或需处理' }
                $lines += $property.Name + '：' + $ready
            }
            $lines += 'systemd：' + $result.linux.systemd + '；用户服务：' + $result.linux.user_bus
            $lines += $(if ($result.linux.ok) { '环境已就绪，可连接客户端。' } else { '请安装缺少的依赖。若 systemd 为 False，启用后保存工作并重启所选 WSL；用户服务未就绪时先打开 Linux 登录再检测。' })
            $log.Text = $lines -join "`r`n"
        }
        if (-not $result.ok) { $log.Text = "操作未完成，可处理原因后重试：`r`n" + $log.Text }
    } catch { $log.Text = $_.Exception.Message }
    finally {
        $script:worker.Dispose()
        $script:worker = $null
        foreach ($button in $script:actionButtons) { $button.Enabled = $true }
        $distroBox.Enabled = $true
        $userBox.Enabled = $true
        $claudeBox.Enabled = $true
        $codexBox.Enabled = $true
        Refresh-SetupWindows
    }
})
$form.Add_FormClosing({
    if ($script:worker -and -not $script:worker.HasExited) {
        $_.Cancel = $true
        [Windows.Forms.MessageBox]::Show($form,'安装步骤仍在执行。请等本步骤结束，避免留下未完成的依赖安装。','Q-agent') | Out-Null
    }
})
try {
    Refresh-SetupWindows
    [Windows.Forms.Application]::Run($form)
} finally {
    $timer.Dispose()
    $form.Dispose()
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
