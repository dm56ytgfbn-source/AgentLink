import { readFile, writeFile, copyFile, rename, realpath, constants } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { call, type Device } from './client.js';

export async function reconnectDevice(configPath: string, name: string, address: string, probe = async (device: Device) => await call(device) as { device_id: string }) {
  const file = await realpath(configPath);
  const before = await readFile(file, 'utf8');
  const registry = JSON.parse(before) as { devices: Device[] };
  const matches = registry.devices.filter(d => d.name === name || d.device_id === name);
  if (matches.length !== 1) throw Error('Unknown or ambiguous computer');
  const device = matches[0];
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Use an HTTPS endpoint without credentials, path or query');
  const candidate = { ...device, url: url.origin };
  const info = await probe(candidate);
  if (info.device_id !== device.device_id) throw Error('Device identity mismatch; registry preserved');
  if (device.url === candidate.url) return { name: device.name, url: candidate.url, changed: false };
  if (await readFile(file, 'utf8') !== before) throw Error('Registry changed during verification; retry after review');
  const suffix = randomUUID();
  const backup = file + '.before-reconnect-' + suffix;
  await copyFile(file, backup, constants.COPYFILE_EXCL);
  device.url = candidate.url;
  const staging = file + '.next-' + suffix;
  await writeFile(staging, JSON.stringify(registry, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (await readFile(file, 'utf8') !== before) throw Error('Registry changed; staged version and backup retained');
  await rename(staging, file);
  return { name: device.name, url: candidate.url, changed: true, backup };
}

export interface AutoReconnectOptions { candidates?: string[]; port?: number; history?: number }

// Candidate order: explicitly supplied, the address in use, the recently verified addresses,
// then the same host on the expected port. Nothing is trusted until the device identifies
// itself, and a candidate that answers with the wrong identity is never saved.
export function addressCandidates(device: Device, options: AutoReconnectOptions = {}): string[] {
  const list: string[] = [];
  const push = (value?: string) => { if (value && !list.includes(value)) list.push(value); };
  for (const entry of options.candidates ?? []) push(entry);
  push(device.url);
  for (const entry of device.url_history ?? []) push(entry);
  try {
    const current = new URL(device.url);
    const port = options.port ?? Number(current.port || 7443);
    push('https://' + current.hostname + ':' + port);
  } catch { /* the stored address is unusable; other candidates still apply */ }
  return list;
}

function rememberAddress(device: Device, url: string, history: number): void {
  const previous = [url, ...(device.url_history ?? []), device.url].filter((entry, index, all) => !!entry && all.indexOf(entry) === index);
  device.url_history = previous.slice(0, Math.max(1, history));
  device.url = url;
}

export interface AutoReconnectReport {
  name: string;
  changed: boolean;
  url: string;
  previous_url: string;
  backup?: string | null;
  attempts: Array<{ url: string; ok: boolean; reason?: string }>;
  reason?: string;
}

export async function reconnectAuto(
  configPath: string,
  name: string,
  options: AutoReconnectOptions & { probe?: (device: Device) => Promise<{ device_id: string }> } = {},
): Promise<AutoReconnectReport> {
  const probe = options.probe ?? (async (device: Device) => await call(device) as { device_id: string });
  const file = await realpath(configPath);
  const before = await readFile(file, 'utf8');
  const registry = JSON.parse(before) as { devices: Device[] };
  const matches = registry.devices.filter(candidate => candidate.name === name || candidate.device_id === name);
  if (matches.length !== 1) throw Error('Unknown or ambiguous computer');
  const device = matches[0];
  const previous_url = device.url;
  const attempts: AutoReconnectReport['attempts'] = [];
  for (const url of addressCandidates(device, options)) {
    if (url === previous_url) continue; // the caller already knows this one is not answering
    try {
      const info = await probe({ ...device, url });
      if (info.device_id !== device.device_id) { attempts.push({ url, ok: false, reason: 'identity-mismatch' }); continue; }
      attempts.push({ url, ok: true });
      if (await readFile(file, 'utf8') !== before) throw Error('Registry changed during verification; retry after review');
      rememberAddress(device, url, options.history ?? 5);
      const backup = file + '.before-reconnect-' + new Date().toISOString().replace(/[:.]/g, '-');
      await copyFile(file, backup);
      const staging = file + '.next-' + randomUUID();
      await writeFile(staging, JSON.stringify(registry, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(staging, file);
      return { name: device.name, changed: true, url, previous_url, backup, attempts };
    } catch (error) {
      attempts.push({ url, ok: false, reason: (error as NodeJS.ErrnoException).code ?? (error as Error).message });
    }
  }
  return { name: device.name, changed: false, url: previous_url, previous_url, backup: null, attempts,
    reason: 'no candidate answered with the paired identity' };
}
