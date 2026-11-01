# Q-agent Windows 客户端

这是现有 WSL 本地界面的轻量 Windows 宿主，使用 WinForms、.NET Framework 4.8 和系统的 Evergreen WebView2 Runtime。客户端访问 `http://127.0.0.1:8421/`，模型会话继续由 WSL 中的 Agent Deck 管理。

## 构建

需要 Windows x64、.NET Framework 4.8、PowerShell 5.1 或更新版本，以及包含在仓库中的界面图标。源码使用 Windows 自带的 Framework64 C# 编译器，不要求 Visual Studio。

在本目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-client.ps1
```

首次构建从官方 NuGet 下载固定版本 `Microsoft.Web.WebView2` **1.0.4314.35**。构建脚本核对包的 SHA256，并检查所使用的三个 WebView2 DLL 的 Microsoft Corporation Authenticode 签名。下载到 `packages/`，编译临时文件放在 `.build/`，可分发文件放在 `dist/`。这些目录及生成的清单不应提交到源码仓库。

参考：[WebView2 WinForms 文档](https://learn.microsoft.com/en-us/microsoft-edge/webview2/get-started/winforms)、[固定 SDK 包](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4314.35)。

## 安装

先按仓库根目录说明配置 WSL 后端，然后关闭已打开的 Windows 客户端并执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-client.ps1
```

安装器支持首次安装，在当前用户的 `%LOCALAPPDATA%\Programs\QAgent` 下放置客户端和启动器，在桌面及开始菜单创建 **Q-agent** 快捷方式。更新时备份将被替换的文件。它不关闭或重启 WSL 模型会话，也不改系统通知开关。

## 运行与通知

重复打开会激活已有窗口。关闭主窗口时会释放其 WebView2 控件和本地弹窗。外部 HTTP(S) 链接由系统浏览器打开，客户端原生接口只接受本机的 `127.0.0.1:8421` 和 `localhost:8421`。

Windows 通知是否显示仍取决于系统设置；系统禁用通知时，界面继续提供应用内提示。安装器为快捷方式注册 `QAgent.Desktop` 应用标识。客户端不会自动修改通知权限。

最小化或隐藏时使用 WebView2 的 `MemoryUsageTargetLevel.Low`，恢复窗口时回到 `Normal`；没有挂起页面或关闭完成提示连接。实际占用随会话内容和 WebView2 Runtime 版本变化，包大小不代表运行内存。

## 本地数据与再分发

WebView2 数据保存在 `%LOCALAPPDATA%\QAgent\WebView2`。本机诊断状态保存在同级 `client-state.json`，运行时状态可能包含本机路径及会话标识。它们不属于源码或分发包，请勿上传到公共仓库。

`dist/` 中的 WebView2 DLL 来自微软 SDK，构建脚本同时放入 `WebView2-LICENSE.txt` 和 `WebView2-NOTICE.txt`。重新分发构建产物时保留这些文件。Evergreen Runtime 由用户按微软条款另行安装；本仓库不附带用户浏览器数据、凭据或模型授权。
