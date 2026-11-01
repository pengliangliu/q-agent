#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef PayloadDir
  #error Build this installer using installer/Build-Release.ps1.
#endif

[Setup]
AppId=Q-agent.Desktop
AppName=Q-agent
AppVersion={#AppVersion}
AppPublisher=Q-agent contributors
AppComments=Desktop chat client for local WSL coding assistants
DefaultDirName={localappdata}\Programs\QAgent
DefaultGroupName=Q-agent
PrivilegesRequired=lowest
DisableDirPage=yes
DisableProgramGroupPage=yes
AllowNoIcons=yes
UsePreviousTasks=no
MinVersion=10.0.19041
ArchitecturesAllowed=x64compatible and not arm64
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern dynamic
LanguageDetectionMethod=uilanguage
CloseApplications=no
RestartApplications=no
SetupIconFile={#PayloadDir}\desktop-client\dist\agent-deck.ico
UninstallDisplayIcon={app}\client\QAgent.exe
LicenseFile={#PayloadDir}\LICENSE
Compression=lzma2
SolidCompression=yes
OutputBaseFilename=Q-agent-Setup-{#AppVersion}-windows-x64
VersionInfoDescription=Q-agent Setup
VersionInfoCompany=Q-agent contributors
VersionInfoProductName=Q-agent
VersionInfoProductVersion={#AppVersion}
VersionInfoVersion={#AppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[CustomMessages]
english.DesktopShortcut=Create a desktop shortcut
english.ConfigureEnvironment=Configure the WSL environment for Q-agent
english.SetupShortcut=Q-agent Environment Setup
chinesesimplified.DesktopShortcut=创建桌面快捷方式
chinesesimplified.ConfigureEnvironment=配置 Q-agent 的 WSL 运行环境
chinesesimplified.SetupShortcut=Q-agent 环境设置

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopShortcut}"; Flags: unchecked

[Files]
; PayloadDir is a fresh, finite allowlist assembled and hashed by Build-Release.ps1.
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Own the installed runtime copies so uninstall removes them without deleting user data.
Source: "{#PayloadDir}\desktop-client\dist\*"; DestDir: "{app}\client"; Flags: ignoreversion
Source: "{#PayloadDir}\desktop-files\Open-AgentDeck-Chinese.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\desktop-files\windows-files.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Q-agent"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File ""{app}\installer\Start-QAgent.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\client\QAgent.exe"; AppUserModelID: "QAgent.Desktop"
Name: "{group}\{cm:SetupShortcut}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File ""{app}\installer\Setup-QAgent.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\client\QAgent.exe"
Name: "{autodesktop}\Q-agent"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File ""{app}\installer\Start-QAgent.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\client\QAgent.exe"; AppUserModelID: "QAgent.Desktop"; Tasks: desktopicon

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File ""{app}\installer\Setup-QAgent.ps1"""; WorkingDir: "{app}"; Description: "{cm:ConfigureEnvironment}"; Flags: postinstall nowait skipifsilent runasoriginaluser

; No uninstall commands or recursive deletes: WSL, wsl.json, backups and user data stay intact.
