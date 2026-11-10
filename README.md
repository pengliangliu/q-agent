# Q-agent

![Project icon](desktop-files/web-ui/overrides/static/icons/agent-deck-64.png)

轻量 Windows 客户端，让运行在 WSL 中的 Claude Code 和 Codex 会话以聊天界面呈现。基于 [Agent Deck](https://github.com/asheshgoplani/agent-deck) 的社区桌面扩展，非上游官方客户端。

客户端使用系统 WebView2，模型进程、项目和会话仍由 WSL 中的 Agent Deck 管理。

直接打开客户端会自动唤醒已配置的 WSL、启动本地后端，并在服务就绪后进入界面。窗口打开期间保留一个低占用连接，防止 WSL 因空闲退出而断开后台；启动失败可在窗口内重试。保活连接随客户端退出释放；需要后台任务继续运行时可将窗口最小化。

## 功能

- 简体中文 / English 界面设置，深色、浅色及跟随系统主题。
- 在“设置 → 账号管理”中为 Claude 或 Codex 添加多个命名账号，在各自的 WSL 原生终端完成授权。勾选“使用当前默认登录”可为已有默认账号起名。可分别设置新会话默认账号，聊天顶部显示当前会话账号。Codex 切换账号时引用同一份本地历史文件和索引；正在回答时可确认中断，切换后接着对话。Claude 使用 Agent Deck 原生切换流程。
- 新建、恢复和切换账号时默认信任项目目录；Claude 通过 Agent Deck 命令行创建的 Codex 子会话也会在启动前自动信任目录。
- 如果需要手动打开授权网址，点所选账号的“手动网页登录”。Claude 网页返回一次性授权码时，在账号管理页粘贴并提交给 Claude。Codex 在账号管理页显示设备码，在授权网页输入。关闭面板会取消尚未完成的页内登录。
- 项目、子项目和父子会话树；图形化创建与会话管理。
- 聊天记录、展示用时间戳、随新回答滚动；支持单独打开原生终端。
- 拖入文件、粘贴截图；文件引用卡片提供打开、显示位置和复制完整路径。
- Claude / Codex 各自的模型及推理强度选择，按原生当前值核对结果；确认失败后自动结束等待、恢复选择并保留所选项，显示失败原因。
- 原生 `/` 命令入口：常用无参数命令点击或 Enter 执行，Tab 仅填入；参数命令提示补充，清空上下文等操作先确认。
- 聊天内提问、权限选择、单选、多选及审阅步骤；原生普通单选点击即提交，多选、其他答案和权限确认保留提交步骤。原生回执区分接受、取消及待核对；无法可靠识别的交互保留终端入口。
- 忙碌时排队、明确的立即投递入口、原请求回执与异常恢复。
- Claude 请求的网络重试和中断提示，保留部分回复；恢复入口只填写“继续”，由使用者确认发送。
- 下一步提问建议：Tab 填入、Enter 发送、Esc 忽略。清空未发送草稿后恢复显示。
- 本机可用证据支持的额度显示、完成提醒、诊断与已部署界面更新检查。
- 隐藏时暂停聊天轮询，空闲时降低刷新频率；可选的安全空闲投递优化。

## 下载安装包

从 [GitHub Releases](https://github.com/pengliangliu/q-agent/releases/latest) 下载 **Q-agent-Setup-0.1.2-windows-x64.exe**。安装包使用企鹅图标，按当前 Windows 用户安装，附带编译好的客户端，无需安装开发工具。首次运行会打开中文环境配置向导：

1. **检测已有环境**：选择 WSL2 发行版和普通 Linux 用户。环境就绪时，可直接连接客户端。
2. **没有 WSL**：点击“启用 / 安装 WSL”，按 Windows 提示授权；如需重启，保存工作并自行重启，再从开始菜单打开“Q-agent 环境设置”。点击“安装 Ubuntu 24.04”添加官方发行版。
3. **初始化 Linux 用户**：打开 Linux 完成首次初始化。如果直接进入 root，点击“创建 Linux 用户”，在终端设置用户名和密码，再把用户名填回向导。密码不经过配置向导。
4. **安装 WSL 依赖**：自动安装系统包、Agent Deck 和 Node.js；可选安装 Claude Code、Codex CLI。下载采用固定版本和完整性校验，已有兼容安装会复用。版本冲突会停止该步骤并保留已有程序。
5. **检测 systemd**：未启用时点击“启用 systemd”。保存该发行版内的工作后，明确选择“重启所选 WSL”，再检测用户服务。向导不会自动关闭其他发行版。
6. **连接客户端**：如缺少 WebView2，先使用对应按钮安装 Microsoft 官方运行库。点击“连接 / 更新客户端”，再通过登录按钮使用自己的助手账号登录，启动 Q-agent。

依赖下载需要网络。WSL 自动安装需要 Windows 管理员授权，并可能要求重启；虚拟化支持需在电脑固件中开启。Linux 自动配置支持 Ubuntu / Debian 的 apt 环境，其他发行版可手动准备下面列出的依赖后检测。WSL1 不会被自动转换，已有发行版、默认发行版和模型会话不会被删除。

安装器和 Q-agent 主程序目前**没有代码签名**，Windows 可能显示未知发布者。可使用同一 Release 的 `SHA256SUMS` 核对下载文件：

```powershell
Get-FileHash .\Q-agent-Setup-0.1.0-windows-x64.exe -Algorithm SHA256
```

卸载会移除 Windows 程序文件和快捷方式，保留 WSL、Linux 工具、用户项目与会话、本机连接设置和备份。重新安装可复用这些环境。开始菜单的环境设置入口也可用于依赖检测和修复；本机设置日志位于 `%LOCALAPPDATA%\QAgent\setup`，反馈问题前请检查个人路径等内容。

## 运行要求

本扩展针对 **Agent Deck v1.16.35**。本次适配过 Claude Code **2.1.316** 和 Codex CLI **0.163.0**；原生菜单或协议升级后可能需要重新适配。

- Windows 10/11 x64，.NET Framework 4.8，以及 [WebView2 Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)。
- WSL2 Linux，启用 systemd 的用户服务和 Windows 互操作；使用普通 Linux 用户安装。
- WSL 中运行 Agent Deck v1.16.35、Node.js 22+、Python 3 和 tmux，安装向导可补齐。
- Claude Code / Codex CLI 使用者自行登录，并能在 Agent Deck 中使用。
- Windows Terminal 用于“独立终端”。源码构建使用 Windows 的 .NET Framework 编译器；安装包无需编译。

依赖版本及官方校验来源见 [bootstrap-sources.md](installer/bootstrap-sources.md)。这个仓库与安装包不携带助手账号、API key、登录状态或会话数据。

## 从源码安装

手动准备上述 WSL 依赖（[Agent Deck 官方说明](https://github.com/asheshgoplani/agent-deck/tree/v1.16.35)），克隆或下载本仓库，在 Windows PowerShell 中进入仓库目录后执行：

```powershell
# 使用默认 WSL 发行版和默认 Linux 用户
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1

# 也可以指定自己使用的发行版和 Linux 用户
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -Distro "YOUR_DISTRO" -LinuxUser "YOUR_LINUX_USER"
```

安装器会探测本机 WSL 环境，将运行配置写到本机用户目录，构建 WebView2 客户端，安装本地桥接并创建 **Q-agent** 快捷方式。WebView2 SDK 从官方 NuGet 下载，固定版本并校验 SHA256 和 DLL 签名。

更新客户端前先退出桌面窗口；WSL 中的模型会话可继续运行。安装过程保留原有设置备份，不会重启模型会话。Linux 侧安装器会添加本地文件操作辅助命令及对应快捷键说明，现有规则其余部分保持不变。

默认只监听 `127.0.0.1:8420`（原服务）和 `127.0.0.1:8421`（桌面桥接）。浏览器也可打开 `http://127.0.0.1:8421/`。

## 可选能力

**当前 Claude 强度捕获**：如果已有命令类型的 Claude 状态栏，可在 WSL 中执行以下脚本，将原状态栏包裹为可核验的本机会话状态采集；它会保留原输出及其他设置。未找到已有状态栏时不修改设置。

```sh
python3 "$HOME/.local/share/agent-deck/desktop-files/install-claude-statusline.py"
```

没有有效原生证据时，模型强度或额度会显示未知/待更新，不据历史请求推测当前值。

**稳定空闲快速投递**：见 [native-idle-send](native-idle-send/README.md)。它构建独立的同版本发送辅助程序，保留官方 CLI 原件、菜单/草稿/启动保护及原队列回执，不必为了使用聊天客户端而安装。

**已有 Windows 代理桥的自动同步**：`desktop-files/windows-proxy-stdio.py` 可作为现有 WSL → Windows 标准输入输出代理桥的 Windows 端实现，使用 Windows Python 标准库。保留助手进程已使用的固定本机代理入口，每个新连接读取当前 Windows 代理；已有连接每 2 秒检查系统代理设置、Clash Verge 持久化的手动节点选择和脚本更新。变化时仅关闭该桥自己的连接，由原客户端重新连接，不重启助手、不记录或重放请求。

此组件不创建 WSL 代理服务、不改写系统代理，也不会替换助手的 API 地址或认证配置。支持 HTTP 代理的单地址及分协议配置；关闭系统代理时，HTTPS CONNECT 使用直连。PAC/WPAD、仅 SOCKS 和直连普通 HTTP 请求明确返回错误。未写入 Clash Verge 选择文件的自动选路不在节点变化检测范围内。原生客户端已停止自动重试时，需使用者确认继续任务。

## 源码目录

| 目录 | 内容 |
| --- | --- |
| `desktop-client/` | WinForms / WebView2 客户端及源码构建脚本 |
| `desktop-files/` | 本地 HTTP 桥接、聊天适配、文件桥接和网页覆盖模块 |
| `native-idle-send/` | 可选的受保护空闲投递补丁及合成测试 |
| `installer/` | Windows 安装器、中文配置向导与 WSL 初始化脚本 |
| `tools/` | 针对发布源码的检查工具 |

这是独立整理的发布快照。开发时的真实会话、附件、截图、运行日志、安装报告、账户配置和密钥没有进入仓库。公开版沿用企鹅图标，图标素材说明见第三方声明。

## 隐私与问题反馈

软件在本机运行时会读取你自己已有的 Agent Deck 会话和助手原生状态，必要的额度查询使用本机现有授权。请不要把这些运行目录或认证文件提交进仓库。诊断按钮只复制经过筛选的版本、连接及数量信息；分享其他日志前请检查内容。

发布检查包括源码语法、Windows 客户端构建、WSL 只读预检、初始化脚本的隔离检查，以及源码、Git 历史和安装包实际文件的隐私/密钥扫描。首次安装流程尚未在全新的 Windows/WSL 虚拟机中完整执行；Windows 组件启用、重启和新发行版初始化仍需在目标电脑验证。

构建安装包需要 [Inno Setup 7](https://jrsoftware.org/isdl.php)，运行 `installer/Build-Release.ps1`。脚本按有限文件清单生成 `release/` 下的安装器、SHA256SUMS 和逐文件校验清单，不收集已安装环境的数据。

## 许可

代码使用 MIT，保留上游版权声明。第三方组件及企鹅图标不据此获得额外授权，说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。WebView2 依赖由 Microsoft 的条款授权；构建产物保留其 LICENSE / NOTICE。
