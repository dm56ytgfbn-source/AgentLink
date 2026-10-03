import {copyFile, mkdir, readFile, rename, writeFile, realpath, stat} from 'node:fs/promises';
import {X509Certificate} from 'node:crypto';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {resolvePaths, registryForRead, type Paths} from '../../packages/config/index.js';
import type {Device} from './client.js';

// Moving a pairing to another computer. The configuration on disk stores ABSOLUTE paths to
// the pinned certificate, so copying the folder to a machine with a different user name
// silently breaks TLS. A bundle carries the certificate itself and the importing machine
// writes its own paths.

export interface PairingBundle {
  version: 1;
  created_at: string;
  warning: string;
  devices: Array<{ name: string; url: string; device_id: string; tls_server_name?: string; token: string; cert_pem: string }>;
}

// Older installations hand out a single device record instead of a bundle. It carries the
// same facts, so it is accepted and wrapped rather than rejected.
export function normalizeLegacyPairing(value: unknown): unknown {
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return value;
  if (Array.isArray(record.devices) || typeof record.cert_pem !== 'string') return value;
  return {
    version: 1,
    created_at: new Date().toISOString(),
    warning: '由旧版 AgentLink 生成的配对信息，已转换为新格式。',
    devices: [{ name: record.name, url: record.url, device_id: record.device_id,
      tls_server_name: record.tls_server_name, token: record.token, cert_pem: record.cert_pem }],
  };
}

export function validateBundle(raw: unknown): PairingBundle {
  const bundle = normalizeLegacyPairing(raw) as Partial<PairingBundle> | null;
  if (!bundle || typeof bundle !== 'object') throw new Error('配对文件不是一个对象');
  if (bundle.version !== 1) throw new Error('配对文件版本不受支持（期望 version: 1）');
  if (!Array.isArray(bundle.devices) || !bundle.devices.length) throw new Error('配对文件里没有任何电脑');
  for (const device of bundle.devices) {
    if (!device || typeof device !== 'object') throw new Error('配对文件里的电脑条目无效');
    if (typeof device.name !== 'string' || !device.name) throw new Error('缺少电脑名称');
    if (typeof device.device_id !== 'string' || !device.device_id) throw new Error('缺少设备标识');
    if (typeof device.token !== 'string' || device.token.length < 32) throw new Error('令牌缺失或过短');
    let url: URL;
    try { url = new URL(String(device.url)); } catch { throw new Error('电脑地址不是合法 URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('电脑地址必须是纯 HTTPS 地址（不能带凭据、路径或查询参数）');
    if (typeof device.cert_pem !== 'string' || !device.cert_pem.includes('BEGIN CERTIFICATE'))
      throw new Error('缺少配对证书');
    try { new X509Certificate(device.cert_pem); } catch { throw new Error('配对证书无法解析'); }
  }
  return bundle as PairingBundle;
}

export async function exportPairing(registryFile: string, options: { device?: string; now?: () => Date } = {}): Promise<PairingBundle> {
  const file = await realpath(registryFile);
  const registry = JSON.parse(await readFile(file, 'utf8')) as { devices: Device[] };
  if (!Array.isArray(registry.devices) || !registry.devices.length) throw new Error('本机还没有配对任何电脑');
  const selected = options.device ? registry.devices.filter(device => device.name === options.device || device.device_id === options.device) : registry.devices;
  if (!selected.length) throw new Error('没有找到指定的电脑: ' + options.device);
  const devices = [];
  for (const device of selected) {
    const token = device.token;
    if (!token) throw new Error('这台电脑的凭据存放在系统钥匙串里，无法直接导出：' + device.name + '（先运行 agentlink secrets status 查看）');
    devices.push({ name: device.name, url: device.url, device_id: device.device_id,
      tls_server_name: device.tls_server_name, token, cert_pem: await readFile(device.ca, 'utf8') });
  }
  return { version: 1, created_at: (options.now ?? (() => new Date()))().toISOString(),
    warning: '这个文件包含可直接访问对端电脑的凭据，请像密码一样保管，用完删除。',
    devices };
}

export interface ImportResult { file: string; certificates: string[]; devices: string[]; backup: string | null; replaced: string[] }

export async function importPairing(bundleValue: unknown, options: { paths?: Paths; replace?: boolean } = {}): Promise<ImportResult> {
  const bundle = validateBundle(bundleValue);
  const paths = options.paths ?? resolvePaths();
  const target = paths.registry;
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.certDir, { recursive: true, mode: 0o700 });

  let registry: { devices: Device[] } = { devices: [] };
  let backup: string | null = null;
  let existing = '';
  try {
    existing = await readFile(target, 'utf8');
    registry = JSON.parse(existing) as { devices: Device[] };
    if (!Array.isArray(registry.devices)) throw new Error('本机配对配置格式错误');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const replaced: string[] = [];
  const certificates: string[] = [];
  const names: string[] = [];
  for (const device of bundle.devices) {
    // A repeated hostname is common in a four-computer setup. It must never cause a
    // different device ID to be silently removed, even when auto-pair uses replace=true.
    const duplicate = registry.devices.find(entry => entry.device_id === device.device_id);
    if (duplicate) {
      if (!options.replace) throw new Error('已经配对过这台电脑: ' + device.name + '（加 --replace 可覆盖，原配置会先备份）');
      registry.devices = registry.devices.filter(entry => entry !== duplicate);
      replaced.push(device.name);
    }
    let displayName = device.name;
    if (registry.devices.some(entry => entry.name === displayName)) {
      const base = device.name + ' (' + device.device_id.slice(0, 8) + ')';
      displayName = base;
      for (let number = 2; registry.devices.some(entry => entry.name === displayName); number++)
        displayName = base + ' ' + number;
    }
    const ca = path.join(paths.certDir, encodeURIComponent(device.device_id) + '.pem');
    await writeFile(ca, device.cert_pem.endsWith('\n') ? device.cert_pem : device.cert_pem + '\n', { mode: 0o600 });
    certificates.push(ca);
    names.push(displayName);
    registry.devices.push({ name: displayName, url: device.url, token: device.token, ca,
      device_id: device.device_id, ...(device.tls_server_name ? { tls_server_name: device.tls_server_name } : {}) });
  }

  if (existing) {
    backup = target + '.before-import-' + new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(target, backup);
  }
  const staging = target + '.next-' + randomBytes(6).toString('hex');
  await writeFile(staging, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(staging, target);
  return { file: target, certificates, devices: names, backup, replaced };
}

export async function describeBundle(bundleValue: unknown) {
  const bundle = validateBundle(bundleValue);
  return bundle.devices.map(device => ({
    name: device.name,
    url: device.url,
    device_id: device.device_id,
    certificate: new X509Certificate(device.cert_pem).fingerprint256,
  }));
}
