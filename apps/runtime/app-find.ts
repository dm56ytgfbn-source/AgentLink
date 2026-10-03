import { call, type Device } from './client.js';

export interface AppFindResult {
  computer: string;
  query: string;
  source: 'windows-native' | 'macos-native';
  matches: Array<{
    name: string;
    source: 'start_menu' | 'installed_programs' | 'command' | 'epic_launcher' | 'applications_folder';
    app_id?: string;
    version?: string;
    publisher?: string;
    command_path?: string;
  }>;
  note: string;
}

function validQuery(query: string): string {
  if (!query.trim() || query.length > 100 || query.includes('\0') || /[\r\n*?\[\]]/.test(query))
    throw new Error('Search query must be 1–100 characters on one line, without wildcards');
  return query.trim();
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

// Query the Windows records that users themselves see in Start and Installed Apps.
// This is intentionally a live, bounded lookup rather than a second software database.
export function windowsAppFindCommand(query: string): string {
  query = validQuery(query);
  return `
$q=${psLiteral(query.trim())}
$cmp=[StringComparison]::OrdinalIgnoreCase
$hits=New-Object 'System.Collections.Generic.List[object]'
foreach($a in (Get-StartApps -ErrorAction SilentlyContinue)) {
  if($a.Name -and $a.Name.IndexOf($q,$cmp) -ge 0) {
    $hits.Add([pscustomobject]@{name=$a.Name;source='start_menu';app_id=$a.AppID;version=$null;publisher=$null;command_path=$null})
  }
}

$uninstall=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')
foreach($a in (Get-ItemProperty $uninstall -ErrorAction SilentlyContinue)) {
  if($a.DisplayName -and $a.DisplayName.IndexOf($q,$cmp) -ge 0) {
    $hits.Add([pscustomobject]@{name=$a.DisplayName;source='installed_programs';app_id=$null;version=$a.DisplayVersion;publisher=$a.Publisher;command_path=$null})
  }
}
foreach($a in (Get-Command -Name $q -CommandType Application -ErrorAction SilentlyContinue)) {
  $hits.Add([pscustomobject]@{name=$a.Name;source='command';app_id=$null;version=$null;publisher=$null;command_path=$a.Source})
}
$epic=Join-Path $env:ProgramData 'Epic\\UnrealEngineLauncher\\LauncherInstalled.dat'
if(Test-Path -LiteralPath $epic) {
  try {
    $installed=Get-Content -LiteralPath $epic -Raw | ConvertFrom-Json
    foreach($a in @($installed.InstallationList)) {
      if($a.AppName -match '^UE_([0-9.]+)$') {
        $version=$Matches[1]
        $name='Unreal Engine '+$version
        if($name.IndexOf($q,$cmp) -ge 0 -or $a.AppName.IndexOf($q,$cmp) -ge 0 -or $q.IndexOf('虚幻',$cmp) -ge 0) {
          $editor=Join-Path $a.InstallLocation 'Engine\\Binaries\\Win64\\UnrealEditor.exe'
          $launch=if(Test-Path -LiteralPath $editor){$editor}else{$null}
          $hits.Add([pscustomobject]@{name=$name;source='epic_launcher';app_id=$null;version=$version;publisher='Epic Games';command_path=$launch})
        }
      }
    }
  } catch { }
}
@($hits | Sort-Object source,name -Unique | Select-Object -First 20) | ConvertTo-Json -Depth 4 -Compress
`;
}

// App bundles are the native launchable unit on macOS. Search only standard application
// locations; a portable app outside them can still be supplied by the user explicitly.
export function macAppFindCommand(): string {
  return `for root in /Applications /System/Applications "$HOME/Applications"; do
  if [ -d "$root" ]; then /usr/bin/find "$root" -maxdepth 3 -type d -name '*.app' -prune -print 2>/dev/null; fi
done`;
}

export function parseMacAppFind(stdout: string, computer: string, query: string): AppFindResult {
  const needle = validQuery(query).toLocaleLowerCase();
  const matches = [...new Set(stdout.split(/\r?\n/).filter(Boolean))]
    .filter(appPath => appPath.endsWith('.app'))
    .map(appPath => ({ name: appPath.split('/').at(-1)!.slice(0, -4), appPath }))
    .filter(item => item.name.toLocaleLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 20)
    .map(item => ({ name: item.name, source: 'applications_folder' as const, command_path: item.appPath }));
  return { computer, query, source: 'macos-native', matches,
    note: matches.length ? 'Live lookup in standard macOS application folders. The app bundle can be opened by path.' :
      'No app bundle matched in standard application folders; portable apps elsewhere may still exist.' };
}

export function parseWindowsAppFind(stdout: string, computer: string, query: string): AppFindResult {
  const raw = JSON.parse(stdout.trim() || '[]') as unknown;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const matches = values.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))
    .filter(v => typeof v.name === 'string' && ['start_menu', 'installed_programs', 'command', 'epic_launcher'].includes(String(v.source)))
    .map(v => ({
      name: String(v.name),
      source: v.source as AppFindResult['matches'][number]['source'],
      ...(typeof v.app_id === 'string' && v.app_id ? { app_id: v.app_id } : {}),
      ...(typeof v.version === 'string' && v.version ? { version: v.version } : {}),
      ...(typeof v.publisher === 'string' && v.publisher ? { publisher: v.publisher } : {}),
      ...(typeof v.command_path === 'string' && v.command_path ? { command_path: v.command_path } : {}),
    }));
  return {
    computer, query, source: 'windows-native', matches,
    note: matches.length ? 'Live Windows lookup. A Start menu app_id can identify a launchable app; an Installed Apps entry alone does not prove a launch command.' :
      'No system-registered match. Portable apps and apps without registration may still exist; do not assume the software is absent.',
  };
}

export async function findWindowsApp(device: Device, query: string, cwd: string): Promise<AppFindResult> {
  const info = await call(device) as { os?: string; capabilities?: string[] };
  if (info.os !== 'win32') throw new Error('Native app lookup currently supports Windows computers');
  if (!info.capabilities?.includes('shell')) throw new Error('Native app lookup requires the remote shell capability');
  const result = await call(device, 'shell.run', { command: windowsAppFindCommand(query), cwd, timeout: 15000 }) as {
    exit_code: number; stdout: string; stderr: string;
  };
  if (result.exit_code !== 0) throw new Error('Windows app lookup failed: ' + (result.stderr || 'unknown error'));
  return parseWindowsAppFind(result.stdout, device.name, query);
}

export async function findNativeApp(device: Device, query: string, cwd: string): Promise<AppFindResult> {
  const info = await call(device) as { os?: string; capabilities?: string[] };
  if (info.os === 'win32') return findWindowsApp(device, query, cwd);
  if (info.os !== 'darwin') throw new Error('Native app lookup currently supports Windows and macOS');
  if (!info.capabilities?.includes('shell')) throw new Error('Native app lookup requires the remote shell capability');
  const result = await call(device, 'shell.run', { command: macAppFindCommand(), cwd, timeout: 15000 }) as {
    exit_code: number; stdout: string; stderr: string;
  };
  if (result.exit_code !== 0) throw new Error('macOS app lookup failed: ' + (result.stderr || 'unknown error'));
  return parseMacAppFind(result.stdout, device.name, query);
}
