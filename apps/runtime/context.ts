import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { call, type Device } from './client.js';
import { inspectDevice } from './health.js';
import type { NodeInfo } from '../../packages/protocol/index.js';
import { preferredDeviceName } from '../../packages/platform/identity.js';

export interface Context { version: 1; computer_id: string; name: string; local: boolean; cwd: string | null; updated_at: string }
export type Probe = (device: Device) => Promise<NodeInfo>;

// One identity can act as a client and as a server. Only public metadata is read here.
export async function localDeviceInfo(home = os.homedir()): Promise<NodeInfo & { local: true }> {
  let deviceId = 'local', name = await preferredDeviceName();
  try {
    const config = JSON.parse(await readFile(path.join(home, '.agentlink-node', 'node.local.json'), 'utf8')) as Record<string, unknown>;
    if (typeof config.device_id === 'string' && config.device_id) deviceId = config.device_id;
    if (typeof config.name === 'string' && config.name) name = config.name;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Local device identity is unreadable');
  }
  return { device_id: deviceId, name, hostname: os.hostname(), os: process.platform,
    architecture: os.arch(), capabilities: ['context'], local: true };
}

function absoluteOn(osName: string, value: string): boolean {
  if (osName !== 'win32') return path.posix.isAbsolute(value);
  // A bare backslash/slash is rooted on Windows' current drive, so it is not a stable
  // cross-device working directory. Require a drive or a complete UNC share.
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(value);
}

export class ComputerContext {
  constructor(public configPath: string, public session = 'default', private probe: Probe = async d => await call(d) as NodeInfo,
    private localInfo: () => Promise<NodeInfo & { local: true }> = localDeviceInfo) {
    if (!session || session.length > 200) throw new Error('Invalid session name');
  }

  private statePath() {
    return path.join(path.dirname(path.resolve(this.configPath)), '.agentlink-context',
      createHash('sha256').update(path.resolve(this.configPath) + '\0' + this.session).digest('hex') + '.json');
  }

  async devices(): Promise<Device[]> {
    const config = JSON.parse(await readFile(this.configPath, 'utf8')) as { devices?: Device[] };
    if (!Array.isArray(config.devices)) throw new Error('Invalid device registry');
    const ids = new Set<string>(), names = new Set<string>();
    for (const device of config.devices) {
      if (typeof device.device_id !== 'string' || !device.device_id || device.device_id === 'local' ||
        typeof device.name !== 'string' || !device.name || ids.has(device.device_id) || names.has(device.name))
        throw new Error('Invalid or ambiguous device registry');
      ids.add(device.device_id); names.add(device.name);
    }
    return config.devices;
  }

  async list() {
    const [local, remote] = await Promise.all([this.localInfo(), this.devices()]);
    return [{ ...local, online: true, latency_ms: 0 }, ...await Promise.all(remote.map(device => inspectDevice(device, { probe: this.probe })))];
  }

  async current(): Promise<Context> {
    const local = await this.localInfo();
    let state: Context;
    try { state = JSON.parse(await readFile(this.statePath(), 'utf8')) as Context; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, computer_id: local.device_id, name: local.name, local: true, cwd: null, updated_at: '' };
      throw new Error('Context state unreadable; explicitly select a computer again');
    }
    if (state.version !== 1 || typeof state.computer_id !== 'string' || typeof state.name !== 'string' ||
      typeof state.local !== 'boolean' || (state.cwd !== null && typeof state.cwd !== 'string'))
      throw new Error('Invalid context state');
    if (state.local) {
      if (state.computer_id !== 'local' && state.computer_id !== local.device_id) throw new Error('Invalid local identity');
      state.computer_id = local.device_id;
      state.name = local.name;
    } else {
      const device = (await this.devices()).find(item => item.device_id === state.computer_id);
      if (!device) throw new Error('Selected computer no longer paired; select a computer again');
      state.name = device.name;
    }
    return state;
  }

  async use(name: string, cwd?: string): Promise<Context> {
    const [local, devices] = await Promise.all([this.localInfo(), this.devices()]);
    const matches = devices.filter(device => device.name === name || device.device_id === name);
    const localMatch = name === 'local' || name === local.device_id || name === local.name ||
      (process.platform === 'darwin' && name === 'MacBook' && matches.length === 0); // legacy alias
    if (matches.length > 1 || (matches.length && localMatch)) throw new Error('Ambiguous computer; use its device ID');
    if (!matches.length && !localMatch) throw new Error('Unknown computer');
    const device = matches[0];
    const info = device ? await this.probe(device) : local;
    if (device && info.device_id !== device.device_id) throw new Error('Device identity mismatch');
    const selectedCwd = cwd ?? (device ? info.default_cwd ?? null : null);
    if (selectedCwd && !absoluteOn(info.os, selectedCwd)) throw new Error('Working directory must be absolute on the selected computer');
    const state: Context = { version: 1, computer_id: info.device_id, name: info.name,
      local: !device, cwd: selectedCwd, updated_at: new Date().toISOString() };
    const target = this.statePath();
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = target + '.' + randomUUID() + '.tmp';
    try { await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, target); }
    finally { await rm(temp, { force: true }); }
    return state;
  }

  async info(name?: string) {
    const local = await this.localInfo();
    const current = name ? null : await this.current();
    if (!name && current?.local) return local;
    const devices = await this.devices();
    const matches = devices.filter(device => name ? device.name === name || device.device_id === name : device.device_id === current?.computer_id);
    const localMatch = name === 'local' || name === local.device_id || name === local.name ||
      (process.platform === 'darwin' && name === 'MacBook' && matches.length === 0);
    if (matches.length > 1 || (matches.length && localMatch)) throw new Error('Ambiguous computer; use its device ID');
    if (name && localMatch) return local;
    if (matches.length !== 1) throw new Error('Unknown or ambiguous computer');
    const info = await this.probe(matches[0]);
    if (info.device_id !== matches[0].device_id) throw new Error('Device identity mismatch');
    return info;
  }
}
