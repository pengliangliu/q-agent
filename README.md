# Q-agent

![Project icon](desktop-files/web-ui/overrides/static/icons/agent-deck-64.png)

轻量 Windows 客户端，让运行在 WSL 中的 Claude Code 和 Codex 会话以聊天界面呈现。基于 [Agent Deck](https://github.com/asheshgoplani/agent-deck) 的社区桌面扩展，非上游官方客户端。

客户端使用系统 WebView2，模型进程、项目和会话仍由 WSL 中的 Agent Deck 管理。

## 功能

- 简体中文 / English 界面设置，深色、浅色及跟随系统主题。
- 项目、子项目和父子会话树；图形化创建与会话管理。
- 聊天记录、展示用时间戳、随新回答滚动；支持单独打开原生终端。
- 拖入文件、粘贴截图；文件引用卡片提供打开、显示位置和复制完整路径。
- Claude / Codex 各自的模型及推理强度选择，原生 `/` 命令入口。
- 聊天内提问、权限选择、单选、多选及审阅步骤；无法可靠识别的原生交互保留终端入口。
- 忙碌时排队、明确的立即投递入口、原请求回执与异常恢复。
- 下一步提问建议：Tab 填入、Enter 发送、Esc 忽略。清空未发送草稿后恢复显示。
- 本机可用证据支持的额度显示、完成提醒、诊断与已部署界面更新检查。
- 隐藏时暂停聊天轮询，空闲时降低刷新频率；可选的安全空闲投递优化。

## 运行要求

本扩展针对 **Agent Deck v1.16.35**。本次适配过 Claude Code **2.1.316** 和 Codex CLI **0.163.0**；原生菜单或协议升级后可能需要重新适配。

- Windows 10/11 x64，.NET Framework 4.8，以及 [WebView2 Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)。
- WSL2 Linux，启用 systemd 的用户服务和 Windows 互操作；使用普通 Linux 用户安装。
- WSL 中已有 Agent Deck v1.16.35、Node.js 22+、Python 3 和 tmux。
- Claude Code / Codex CLI 按各自官方方式安装、登录，并能在 Agent Deck 中使用。
- Windows Terminal 用于“独立终端”。编译器来自 Windows 的 .NET Framework 安装。

请先按 [Agent Deck 官方说明](https://github.com/asheshgoplani/agent-deck/tree/v1.16.35) 安装上游程序。这个仓库不携带助手账号、API key、登录状态、会话数据或已安装的助手程序。

## 安装

克隆或下载本仓库，在 Windows PowerShell 中进入仓库目录后执行：

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

## 源码目录

| 目录 | 内容 |
| --- | --- |
| `desktop-client/` | WinForms / WebView2 客户端及源码构建脚本 |
| `desktop-files/` | 本地 HTTP 桥接、聊天适配、文件桥接和网页覆盖模块 |
| `native-idle-send/` | 可选的受保护空闲投递补丁及合成测试 |
| `tools/` | 针对发布源码的检查工具 |

这是独立整理的发布快照。开发时的真实会话、附件、截图、运行日志、安装报告、账户配置和密钥没有进入仓库。公开版沿用企鹅图标，图标素材说明见第三方声明。

## 隐私与问题反馈

软件在本机运行时会读取你自己已有的 Agent Deck 会话和助手原生状态，必要的额度查询使用本机现有授权。请不要把这些运行目录或认证文件提交进仓库。诊断按钮只复制经过筛选的版本、连接及数量信息；分享其他日志前请检查内容。

本仓库首次发布检查包括源码语法、Windows 客户端构建、可移植补丁应用，以及针对已选源码和 Git 历史的隐私/密钥扫描。首次安装脚本未在新的 Windows/WSL 虚拟机完整执行；已有开发环境的功能验证不等于所有配置均已覆盖。

## 许可

代码使用 MIT，保留上游版权声明。第三方组件及企鹅图标不据此获得额外授权，说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。WebView2 依赖由 Microsoft 的条款授权；构建产物保留其 LICENSE / NOTICE。
