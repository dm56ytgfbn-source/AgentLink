import http from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {call,type Device} from './client.js';
import {inspectDevice} from './health.js';
import {ComputerContext} from './context.js';
import {resolvePaths,bridgeForRead,registryForRead,describePaths,type Paths} from '../../packages/config/index.js';

// One machine-readable status source for every UI (menu bar app, CLI, future Windows tray).
// It never mutates state and never prints credentials.

export interface BridgeSettings { name:string; remoteRoot?:string; roots?:Record<string,string>; port:number }
export interface SupervisorState { at?:string; computer?:string; online?:boolean; bridge?:boolean; mount?:string;
  mount_io?:boolean; ready?:boolean; error_code?:string; mount_attempt_exit?:number|string }

// Several entry points historically mounted at different paths, so a single guessed path
// reports "unmounted" for a working mount. Candidates are checked in order instead.
export function mountPathCandidates(paths:Paths, name:string, environment:NodeJS.ProcessEnv = process.env):string[] {
  const candidates = [environment.AGENTLINK_MOUNT?.trim(), path.join(paths.home,'mount',name), path.join(os.homedir(),'AgentLink',name)]
    .filter((value):value is string => !!value);
  return [...new Set(candidates)];
}

export function findMount(table:string, candidates:string[], port:number):{path:string; state:'agentlink'|'other'|'unmounted'} {
  let other:string|undefined;
  for (const candidate of candidates) {
    const state = parseMountTable(table, candidate, port);
    if (state === 'agentlink') return { path:candidate, state };
    if (state === 'other' && other === undefined) other = candidate;
  }
  if (other) return { path:other, state:'other' };
  return { path:candidates[0] ?? '', state:'unmounted' };
}

export async function launchAgentLabels(directory:string):Promise<string[]> {
  try {
    const entries = await readdir(directory);
    return entries.filter(name => name.toLowerCase().includes('agentlink') && name.endsWith('.plist')).map(name => name.slice(0, -6)).sort();
  } catch { return []; }
}

export function parseMountTable(table:string, mountPath:string, port:number):'agentlink'|'other'|'unmounted' {
  const marker = ' on ' + mountPath + ' (';
  const line = table.split('\n').find(candidate => candidate.includes(marker));
  if (!line) return 'unmounted';
  const index = line.indexOf(marker);
  const source = line.slice(0, index);
  const flags = line.slice(index + marker.length);
  try {
    const url = new URL(source);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === String(port) && url.pathname === '/'
      && flags.split(/[, )]+/).includes('webdav') ? 'agentlink' : 'other';
  } catch { return 'other'; }
}

export function probeBridge(port:number, timeout = 1500):Promise<boolean> {
  return new Promise(resolve => {
    const request = http.get({ host:'127.0.0.1', port, path:'/', timeout }, response => {
      response.resume();
      resolve(response.statusCode === 401 && String(response.headers['www-authenticate']).includes('AgentLink'));
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

export async function readSupervisorState(stateDir:string):Promise<SupervisorState|null> {
  try { return JSON.parse(await readFile(path.join(stateDir,'status.json'),'utf8')) as SupervisorState; }
  catch { return null; }
}

async function readBridgeSettings(paths:Paths):Promise<BridgeSettings|null> {
  try { return JSON.parse(await readFile(bridgeForRead(paths),'utf8')) as BridgeSettings; }
  catch { return null; }
}

async function mountTable():Promise<string> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('/sbin/mount', [], { timeout:5000 });
    return stdout;
  } catch { return ''; }
}

// The supervisor writes its record every 10 seconds. A record that stopped advancing while
// claiming ready=true is the most misleading state a UI can show, so it is detected here.
export const SUPERVISOR_STALE_SECONDS = 60;
export interface StatusOptions { paths?:Paths; probe?:typeof probeBridge; mountSource?:()=>Promise<string>; now?:()=>Date }

export async function collectStatus(options:StatusOptions = {}) {
  const paths = options.paths ?? resolvePaths();
  const probe = options.probe ?? probeBridge;
  const now = options.now ?? (() => new Date());
  const registryFile = registryForRead(paths);
  const context = new ComputerContext(registryFile, process.env.AGENTLINK_SESSION ?? 'status');
  const bridge = await readBridgeSettings(paths);
  const supervisor = await readSupervisorState(paths.stateDir);
  const supervisorAge = supervisor?.at ? Math.max(0, Math.round((now().getTime() - Date.parse(supervisor.at)) / 1000)) : null;
  const supervisorStale = supervisorAge === null ? null : (Number.isNaN(supervisorAge) || supervisorAge > SUPERVISOR_STALE_SECONDS);

  let devices:unknown[] = [];
  let registryError:string|null = null;
  try {
    const list = await context.devices();
    devices = await Promise.all(list.map(async (device:Device) => {
      const health = await inspectDevice(device, { attempts:1 });
      return { url:device.url, ...health };
    }));
  } catch (error) { registryError = (error as Error).message; }

  let current:unknown = null;
  try { current = await context.current(); } catch (error) { current = { error:(error as Error).message }; }

  const bridgeRunning = bridge ? await probe(bridge.port) : false;
  const table = bridge ? await (options.mountSource ?? mountTable)() : '';
  const candidates = bridge ? mountPathCandidates(paths, bridge.name) : [];
  const found = bridge ? findMount(table, candidates, bridge.port) : null;
  const mountPath = found?.path ?? null;
  // The table is authoritative; the supervisor record is only a fallback when the table
  // could not be read at all.
  const mountState = found && (table || found.state !== 'unmounted') ? found.state
    : (supervisor?.mount === 'agentlink' ? 'agentlink' : found?.state ?? 'unknown');

  const statusFile = process.env.AGENTLINK_INPUT_STATUS ?? null;
  let inputShareEvent:unknown = null;
  if (statusFile && existsSync(statusFile)) {
    try { inputShareEvent = JSON.parse((await readFile(statusFile,'utf8')).trim().split('\n').pop() ?? 'null'); } catch { inputShareEvent = null; }
  }

  return {
    version: 1,
    generated_at: now().toISOString(),
    host: { hostname: os.hostname(), platform: process.platform, architecture: os.arch() },
    paths: describePaths(paths),
    registry: { file: registryFile, error: registryError, count: devices.length },
    current,
    devices,
    bridge: bridge ? {
      configured: true, name: bridge.name, port: bridge.port,
      exported_roots: bridge.roots ?? (bridge.remoteRoot ? { '': bridge.remoteRoot } : {}),
      running: bridgeRunning,
      mount_path: mountPath,
      mount: mountState,
      mount_io: supervisor?.mount_io ?? null,
      supervisor_ready: supervisor?.ready ?? null,
      supervisor_checked_at: supervisor?.at ?? null,
      supervisor_error: supervisor?.error_code ?? null,
    } : { configured:false, running:false, mount:'unconfigured' as const },
    supervisor: supervisor ? { ...supervisor, age_seconds:supervisorAge, stale:supervisorStale === true } : null,
    supervisor_stale: supervisorStale,
    input_share: { helper_status_file: statusFile, last_event: inputShareEvent,
      note: 'Input sharing is started explicitly from the app or the CLI; it is never enabled silently.' },
    services: {
      launch_agents_dir: path.join(os.homedir(), 'Library', 'LaunchAgents'),
      launch_agents: await launchAgentLabels(path.join(os.homedir(), 'Library', 'LaunchAgents')),
      launch_agent_installed: (await launchAgentLabels(path.join(os.homedir(), 'Library', 'LaunchAgents'))).length > 0,
    },
  };
}

export type Status = Awaited<ReturnType<typeof collectStatus>>;

export function summarize(status:Status) {
  const lines:string[] = [];
  lines.push('AgentLink ' + status.generated_at + '  (' + status.host.hostname + ', ' + status.host.platform + ')');
  lines.push('配置目录: ' + status.paths.home);
  if (status.registry.error) lines.push('配对信息: 不可用 — ' + status.registry.error);
  else if (!status.registry.count) lines.push('配对信息: 还没有配对任何电脑');
  for (const device of status.devices as Array<Record<string,unknown>>) {
    lines.push((device.online ? '[在线] ' : '[离线] ') + device.name
      + (device.online ? '  ' + String(device.latency_ms ?? '?') + 'ms  ' + String(device.os ?? '') : '  ' + String(device.error_code ?? '') + ' — ' + String(device.next_action ?? '')));
  }
  if (status.bridge.configured) {
    lines.push('文件桥: ' + (status.bridge.running ? '运行中' : '未运行') + '  端口 ' + status.bridge.port);
    lines.push('原生挂载: ' + status.bridge.mount + (status.bridge.mount_path ? '  ' + status.bridge.mount_path : ''));
  } else lines.push('文件桥: 未配置');
  if (status.supervisor_stale) {
    lines.push('后台监督器: 已停止（最后更新 ' + String(status.supervisor?.age_seconds ?? '?') + ' 秒前）');
    lines.push('建议: 重新登录，或重新加载 LaunchAgent（launchctl bootstrap gui/$(id -u) 加上 plist 路径）');
  }
  if (status.bridge.configured && !status.bridge.running) lines.push('提示: 文件桥未运行，Windows 文件目录当前不可用。');
  lines.push('登录自启: ' + (status.services.launch_agent_installed ? '已安装（' + status.services.launch_agents.join(', ') + '）' : '未安装'));
  return lines.join('\n');
}
