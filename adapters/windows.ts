import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { StringDecoder } from 'node:string_decoder';
import { LinkError } from "../packages/protocol/index.js";
export const running = new Set<ChildProcess>();
export function stop(child: ChildProcess) {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore" },
    );
    killer.on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
export function killAll() {
  for (const child of running) stop(child);
}
export async function run(
  command: string,
  cwd: string,
  environment: Record<string, string> = {},
  timeout = 30000,
  signal?: AbortSignal,
  executable?: string,
  onOutput?: (stream: string, text: string) => void,
) {
  if (!executable && process.platform !== "win32")
    throw new LinkError(
      "FORBIDDEN",
      "Windows capability requires a Windows node",
    );
  const start = Date.now();
  return new Promise<{
    exit_code: number;
    stdout: string;
    stderr: string;
    duration: number;
  }>((resolve, reject) => {
    const prefix =
      "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); ";
    const child = spawn(
      executable ?? "powershell.exe",
      executable
        ? ["-c", command]
        : [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(prefix + command, "utf16le").toString("base64"),
          ],
      {
        cwd,
        env: { ...process.env, ...environment },
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    running.add(child);
    let out = Buffer.alloc(0),
      err = Buffer.alloc(0),
      failure: LinkError | undefined;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const abort = () => {
      failure = new LinkError("PROCESS_FAILED", "Cancelled");
      stop(child);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => {
      failure = new LinkError("TIMEOUT");
      stop(child);
    }, timeout);
    const clean = () => {
      clearTimeout(timer);
      running.delete(child);
      signal?.removeEventListener("abort", abort);
    };
    child.stdout.on("data", (b: Buffer) => {
      if (out.length + b.length > 4 * 1024 * 1024) {
        failure = new LinkError("PROCESS_FAILED", "Output limit exceeded");
        stop(child);
      } else { out = Buffer.concat([out, b]); const text = decoders.stdout.write(b); if (text) onOutput?.('stdout', text); }
    });
    child.stderr.on("data", (b: Buffer) => {
      if (err.length + b.length > 4 * 1024 * 1024) {
        failure = new LinkError("PROCESS_FAILED", "Output limit exceeded");
        stop(child);
      } else { err = Buffer.concat([err, b]); const text = decoders.stderr.write(b); if (text) onOutput?.('stderr', text); }
    });
    child.on("error", () => {
      clean();
      reject(new LinkError("PROCESS_FAILED"));
    });
    child.on("close", (code) => {
      for (const stream of ['stdout', 'stderr'] as const) { const text = decoders[stream].end(); if (text) onOutput?.(stream, text); }
      clean();
      if (failure) reject(failure);
      else
        resolve({
          exit_code: code ?? -1,
          stdout: out.toString("utf8"),
          stderr: err.toString("utf8"),
          duration: Date.now() - start,
        });
    });
  });
}
export const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";

// A local window helper can make focus/click/type much faster, but it is an EXTERNAL program
// that is not part of AgentLink. It is therefore never discovered implicitly: it runs only
// when both AGENTLINK_WINCTL_URL and AGENTLINK_WINCTL_TOKEN_FILE are configured, must be
// loopback HTTP, and otherwise every window operation uses the documented PowerShell path.
export interface WindowBrokerSettings { url: string; tokenFile: string }

export function windowBrokerSettings(environment: NodeJS.ProcessEnv = process.env): WindowBrokerSettings | null {
  const rawUrl = environment.AGENTLINK_WINCTL_URL?.trim();
  const tokenFile = environment.AGENTLINK_WINCTL_TOKEN_FILE?.trim();
  if (!rawUrl || !tokenFile) return null;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
  return { url: url.origin, tokenFile };
}

export function windowBrokerEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return windowBrokerSettings(environment) !== null;
}

async function fastWindowBroker(op: string, args: Record<string, unknown>): Promise<unknown | undefined> {
  if (process.platform !== "win32") return undefined;
  const settings = windowBrokerSettings();
  if (!settings) return undefined;
  const tokenFile = settings.tokenFile;
  let token: string;
  try { token = (await readFile(tokenFile, "utf8")).trim(); } catch { return undefined; }
  if (!token) return undefined;
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ op, args }));
    const endpoint = new URL(settings.url);
    const req = httpRequest({ hostname:endpoint.hostname, port:endpoint.port || 80, path:"/", method:"POST", timeout:5000,
      headers:{ authorization:`Bearer ${token}`, "content-type":"application/json", "content-length":body.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(res.statusCode === 200 && value.ok ? value.result : undefined);
        } catch { resolve(undefined); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(undefined); });
    req.on("error", () => resolve(undefined));
    req.end(body);
  });
}
export async function launch(
  app: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) {
  const r = await run(
    `$p=Start-Process -FilePath ${psQuote(app)} ${args.length ? "-ArgumentList " + psQuote(args.map((a) => '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"').join(" ")) : ""} -PassThru; $p.Id`,
    cwd,
    {},
    30000,
    signal,
  );
  if (r.exit_code !== 0) throw new LinkError("PROCESS_FAILED");
  return { pid: Number(r.stdout.trim()) };
}
export async function screenshot(
  file: string,
  cwd: string,
  monitor: unknown,
  signal?: AbortSignal,
) {
  if (
    monitor !== undefined &&
    (!Number.isInteger(monitor) || Number(monitor) < 0)
  )
    throw new LinkError("INVALID_REQUEST");
  const bounds =
    monitor === undefined
      ? "[System.Windows.Forms.SystemInformation]::VirtualScreen"
      : `([System.Windows.Forms.Screen]::AllScreens | Select-Object -Index ${monitor}).Bounds`;
  const r = await run(
    `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=${bounds}; if($null -eq $b -or $b.Width -le 0){throw 'Invalid display'}; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); try {$g.CopyFromScreen($b.X,$b.Y,0,0,$b.Size); $bmp.Save(${psQuote(file)},[System.Drawing.Imaging.ImageFormat]::Png)} finally {$g.Dispose();$bmp.Dispose()}`,
    cwd,
    {},
    30000,
    signal,
  );
  if (r.exit_code !== 0) throw new LinkError("PROCESS_FAILED");
}

const windowNativeType = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AgentLinkWindowNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
}
"@`;

function windowId(value: unknown): string {
  const id = String(value ?? "");
  if (!/^\d{1,20}$/.test(id)) throw new LinkError("INVALID_REQUEST");
  return id;
}

export async function listWindows(cwd: string, signal?: AbortSignal) {
  const command = String.raw`${windowNativeType}
$foreground=[AgentLinkWindowNative]::GetForegroundWindow()
$items=New-Object System.Collections.Generic.List[object]
$callback=[AgentLinkWindowNative+EnumWindowsProc]{ param([IntPtr]$h,[IntPtr]$unused)
  if(-not [AgentLinkWindowNative]::IsWindowVisible($h)){return $true}
  $r=New-Object AgentLinkWindowNative+RECT
  if(-not [AgentLinkWindowNative]::GetWindowRect($h,[ref]$r)){return $true}
  $w=$r.Right-$r.Left; $height=$r.Bottom-$r.Top
  if($w -lt 120 -or $height -lt 80){return $true}
  $title=New-Object System.Text.StringBuilder 1024
  [void][AgentLinkWindowNative]::GetWindowText($h,$title,$title.Capacity)
  if([string]::IsNullOrWhiteSpace($title.ToString())){return $true}
  [uint32]$processId=0; [void][AgentLinkWindowNative]::GetWindowThreadProcessId($h,[ref]$processId)
  $process=''; try {$process=(Get-Process -Id $processId -ErrorAction Stop).ProcessName} catch {}
  if($process -in @('TextInputHost','ShellExperienceHost','SearchHost','StartMenuExperienceHost')){return $true}
  if($process -eq 'explorer' -and $title.ToString() -eq 'Program Manager'){return $true}
  $items.Add([PSCustomObject]@{id=$h.ToInt64().ToString();title=$title.ToString();process=$process;pid=$processId;left=$r.Left;top=$r.Top;width=$w;height=$height;foreground=($h -eq $foreground);minimized=[AgentLinkWindowNative]::IsIconic($h)})|Out-Null
  return $true
}
[void][AgentLinkWindowNative]::EnumWindows($callback,[IntPtr]::Zero)
$items|ConvertTo-Json -Compress`;
  const result = await run(command, cwd, {}, 10000, signal);
  if (result.exit_code !== 0) throw new LinkError("PROCESS_FAILED", result.stderr.trim() || "Cannot list windows");
  const parsed: unknown = JSON.parse(result.stdout || "[]");
  return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
}

export async function captureWindow(file: string, cwd: string, rawId: unknown, signal?: AbortSignal) {
  const id = windowId(rawId);
  const fast = await fastWindowBroker("shot", { out:file, hwnd:Number(id), focus:false });
  if (fast) return;
  const command = String.raw`${windowNativeType}
$h=[IntPtr]::new([Int64]${id}); $r=New-Object AgentLinkWindowNative+RECT
if(-not [AgentLinkWindowNative]::GetWindowRect($h,[ref]$r)){throw 'Window not found'}
$w=$r.Right-$r.Left; $height=$r.Bottom-$r.Top
if($w -le 0 -or $height -le 0){throw 'Invalid window size'}
$bmp=New-Object System.Drawing.Bitmap($w,$height,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
if([AgentLinkWindowNative]::IsIconic($h)){[void][AgentLinkWindowNative]::ShowWindow($h,9)}
[void][AgentLinkWindowNative]::SetForegroundWindow($h); Start-Sleep -Milliseconds 80
$g=[System.Drawing.Graphics]::FromImage($bmp);try{$g.CopyFromScreen($r.Left,$r.Top,0,0,$bmp.Size)}finally{$g.Dispose()}
try{$bmp.Save(${psQuote(file)},[System.Drawing.Imaging.ImageFormat]::Png)}finally{$bmp.Dispose()}`;
  const result = await run(command, cwd, {}, 15000, signal);
  if (result.exit_code !== 0) throw new LinkError("PROCESS_FAILED", result.stderr.trim() || "Cannot capture window");
}

export async function focusWindow(cwd: string, rawId: unknown, signal?: AbortSignal) {
  const id = windowId(rawId);
  const fast = await fastWindowBroker("focus", { hwnd:Number(id) });
  if (fast) return { focused:id };
  const result = await run(String.raw`${windowNativeType}
$h=[IntPtr]::new([Int64]${id}); if([AgentLinkWindowNative]::IsIconic($h)){[void][AgentLinkWindowNative]::ShowWindow($h,9)}; [void][AgentLinkWindowNative]::SetForegroundWindow($h)`, cwd, {}, 5000, signal);
  if (result.exit_code !== 0) throw new LinkError("PROCESS_FAILED");
  return { focused: id };
}

const fastPointerDown = new Map<string, { x:number; y:number; button:string }>();

export async function windowInput(cwd: string, payload: Record<string, unknown>, signal?: AbortSignal) {
  const id = windowId(payload.id);
  const kind = String(payload.kind ?? "");
  if (!['move','down','up','scroll','text','key'].includes(kind)) throw new LinkError("INVALID_REQUEST");
  const x = Number(payload.x ?? 0), y = Number(payload.y ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new LinkError("INVALID_REQUEST");
  const button = String(payload.button ?? 'left');
  if (!['left','right','middle'].includes(button)) throw new LinkError("INVALID_REQUEST");
  const delta = Math.max(-1200, Math.min(1200, Math.trunc(Number(payload.delta ?? 0))));
  const textValue = String(payload.text ?? '');
  if (textValue.length > 4096 || textValue.includes('\0')) throw new LinkError("INVALID_REQUEST");
  const key = String(payload.key ?? '').toUpperCase();
  const allowedKeys: Record<string, number> = {ENTER:13,TAB:9,ESCAPE:27,BACKSPACE:8,DELETE:46,LEFT:37,UP:38,RIGHT:39,DOWN:40,HOME:36,END:35,PAGEUP:33,PAGEDOWN:34,SPACE:32};
  if (kind === 'key' && allowedKeys[key] === undefined && !/^[A-Z0-9]$/.test(key)) throw new LinkError("INVALID_REQUEST");
  const vk = allowedKeys[key] ?? (key ? key.charCodeAt(0) : 0);
  const mouseFlags = button === 'right' ? {down:8,up:16} : button === 'middle' ? {down:32,up:64} : {down:2,up:4};
  const brokerWindows = await fastWindowBroker("windows", {}) as { windows?: Array<{hwnd:number;rect:number[]}> } | undefined;
  const brokerWindow = brokerWindows?.windows?.find((item) => String(item.hwnd) === id);
  if (brokerWindow?.rect?.length === 4) {
    const absoluteX = Math.round(brokerWindow.rect[0] + x), absoluteY = Math.round(brokerWindow.rect[1] + y);
    if (kind === 'down') {
      fastPointerDown.set(id, { x:absoluteX, y:absoluteY, button });
      await fastWindowBroker("focus", { hwnd:Number(id) });
      return { accepted:true };
    }
    if (kind === 'up') {
      const start = fastPointerDown.get(id); fastPointerDown.delete(id);
      const result = start && (start.x !== absoluteX || start.y !== absoluteY)
        ? await fastWindowBroker("drag", { x1:start.x, y1:start.y, x2:absoluteX, y2:absoluteY, button:start.button, duration:0.25 })
        : await fastWindowBroker("click", { x:absoluteX, y:absoluteY, button });
      if (result) return { accepted:true };
    } else if (kind === 'move') {
      const result = await fastWindowBroker("move", { x:absoluteX, y:absoluteY });
      if (result) return { accepted:true };
    } else if (kind === 'scroll') {
      const result = await fastWindowBroker("scroll", { x:absoluteX, y:absoluteY, clicks:Math.trunc(delta / 120) || Math.sign(delta) });
      if (result) return { accepted:true };
    } else if (kind === 'text') {
      const result = await fastWindowBroker("type", { text:textValue, settle:0.05 });
      if (result) return { accepted:true };
    } else if (kind === 'key') {
      const result = await fastWindowBroker("key", { combo:key.toLowerCase() });
      if (result) return { accepted:true };
    }
  }
  let eventScript = '';
  if (kind === 'move') eventScript = '';
  else if (kind === 'down' || kind === 'up') eventScript = `$i=New-Object AgentLinkWindowNative+INPUT;$i.type=0;$i.U.mi.dwFlags=${mouseFlags[kind]};[void][AgentLinkWindowNative]::SendInput(1,@($i),[Runtime.InteropServices.Marshal]::SizeOf([type][AgentLinkWindowNative+INPUT]))`;
  else if (kind === 'scroll') eventScript = `$i=New-Object AgentLinkWindowNative+INPUT;$i.type=0;$i.U.mi.dwFlags=0x0800;$i.U.mi.mouseData=[uint32]([int32]${delta});[void][AgentLinkWindowNative]::SendInput(1,@($i),[Runtime.InteropServices.Marshal]::SizeOf([type][AgentLinkWindowNative+INPUT]))`;
  else if (kind === 'text') eventScript = `$old=[System.Windows.Forms.Clipboard]::GetDataObject();try{[System.Windows.Forms.Clipboard]::SetText(${psQuote(textValue)});Start-Sleep -Milliseconds 60;[System.Windows.Forms.SendKeys]::SendWait('^v');Start-Sleep -Milliseconds 80}finally{if($null -ne $old){[System.Windows.Forms.Clipboard]::SetDataObject($old,$true)}}`;
  else {
    const sendKey: Record<string, string> = {ENTER:'{ENTER}',TAB:'{TAB}',ESCAPE:'{ESC}',BACKSPACE:'{BACKSPACE}',DELETE:'{DELETE}',LEFT:'{LEFT}',UP:'{UP}',RIGHT:'{RIGHT}',DOWN:'{DOWN}',HOME:'{HOME}',END:'{END}',PAGEUP:'{PGUP}',PAGEDOWN:'{PGDN}',SPACE:' '};
    eventScript = `[System.Windows.Forms.SendKeys]::SendWait(${psQuote(sendKey[key] ?? key)})`;
  }
  const command = String.raw`${windowNativeType}
$h=[IntPtr]::new([Int64]${id});$r=New-Object AgentLinkWindowNative+RECT
if(-not [AgentLinkWindowNative]::GetWindowRect($h,[ref]$r)){throw 'Window not found'}
if([AgentLinkWindowNative]::IsIconic($h)){[void][AgentLinkWindowNative]::ShowWindow($h,9)}
[void][AgentLinkWindowNative]::SetForegroundWindow($h)
if('${kind}' -in @('move','down','up','scroll')){[void][AgentLinkWindowNative]::SetCursorPos($r.Left+[int]${Math.round(x)},$r.Top+[int]${Math.round(y)})}
${eventScript}`;
  const result = await run(command, cwd, {}, 5000, signal);
  if (result.exit_code !== 0) throw new LinkError("PROCESS_FAILED", result.stderr.trim() || "Input failed");
  return { accepted: true };
}
