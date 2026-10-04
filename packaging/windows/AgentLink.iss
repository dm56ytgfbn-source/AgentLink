; Built only from an AgentLink-Windows payload created by package-windows.mjs.
; The user's pairing identity lives outside {app} and is never bundled here.
#ifndef MyAppVersion
  #error MyAppVersion is required
#endif
#ifndef PayloadDir
  #error PayloadDir is required
#endif

[Setup]
AppId=AgentLink
AppName=AgentLink
AppVersion={#MyAppVersion}
AppPublisher=AgentLink contributors
DefaultDirName={autopf}\AgentLink
DefaultGroupName=AgentLink
UninstallDisplayIcon={app}\AgentLink.exe
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
OutputBaseFilename=AgentLink-Setup-{#MyAppVersion}-windows-x64

[Files]
Source: "{#PayloadDir}\AgentLink.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\AgentLink"; Filename: "{app}\AgentLink.exe"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\runtime\scripts\windows-configure-firewall.ps1"" -NodePath ""{app}\runtime\node\node.exe"""; Flags: runhidden waituntilterminated
Filename: "{app}\AgentLink.exe"; Description: "打开 AgentLink"; Flags: nowait postinstall skipifsilent runasoriginaluser
