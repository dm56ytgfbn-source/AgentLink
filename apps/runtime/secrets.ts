import {copyFile, readFile, rename, writeFile, realpath} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {defaultSecretStore, type SecretStore} from '../../packages/secrets/index.js';
import {generateDeviceKeyPair, publicKeyFingerprint} from '../../packages/trust/index.js';
import type {Device} from './client.js';

// Moving pairing secrets out of the configuration file. The file keeps only a reference, so
// copying the configuration (or attaching it to a bug report) no longer leaks credentials.

export interface Registry { devices: Device[] }

export async function loadRegistry(file: string): Promise<Registry> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Registry;
  if (!parsed || !Array.isArray(parsed.devices)) throw new Error('Invalid device registry');
  return parsed;
}

export interface SecretMigrationPlan {
  file: string;
  store: string;
  changes: Array<{ name: string; account: string }>;
  already_moved: string[];
  nothing_to_do: boolean;
}

export async function planSecretMigration(registryFile: string, store?: SecretStore | null): Promise<SecretMigrationPlan> {
  const file = await realpath(registryFile);
  const registry = await loadRegistry(file);
  const changes: Array<{ name: string; account: string }> = [];
  const already_moved: string[] = [];
  for (const device of registry.devices) {
    if (device.token && device.token.length >= 8) changes.push({ name: device.name, account: device.device_id });
    else if (device.token_ref) already_moved.push(device.name);
  }
  return { file, store: store ? store.kind : 'unavailable', changes, already_moved,
    nothing_to_do: changes.length === 0 };
}

export async function applySecretMigration(plan: SecretMigrationPlan, store: SecretStore) {
  const before = await readFile(plan.file, 'utf8');
  const registry = JSON.parse(before) as Registry;
  const migrated: string[] = [];
  for (const device of registry.devices) {
    if (!device.token || device.token.length < 8) continue;
    const account = device.device_id;
    await store.set(account, device.token);
    const stored = await store.get(account);
    if (stored !== device.token) throw new Error('The keychain did not return the value it stored; configuration left unchanged');
    delete device.token;
    device.token_ref = account;
    migrated.push(device.name);
  }
  if (!migrated.length) return { file: plan.file, backup: null, migrated };
  const backup = plan.file + '.before-keychain-' + new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(plan.file, backup);
  const staging = plan.file + '.next-' + randomBytes(6).toString('hex');
  await writeFile(staging, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(staging, plan.file);
  return { file: plan.file, backup, migrated };
}

export async function secretStatus(registryFile: string, store?: SecretStore | null) {
  const file = await realpath(registryFile);
  const registry = await loadRegistry(file);
  const devices = await Promise.all(registry.devices.map(async device => {
    const storage = device.token ? 'file' : device.token_ref ? (store ? 'keychain' : 'keychain-unavailable') : 'none';
    const present = device.token ? true : device.token_ref && store ? (await store.get(device.token_ref)) !== null : false;
    return { name: device.name, account: device.device_id, storage, present };
  }));
  return { file, store: store ? store.kind : 'unavailable', devices };
}

export { defaultSecretStore };

export interface TrustInitPlan {
  file: string;
  client_id: string;
  public_key: string;
  fingerprint: string;
  key_ref: string | null;
  devices: string[];
  node_configuration: unknown;
}

// Sets up the signing identity this Mac presents to its paired computers. The private key
// goes into the system keychain when one is available; only a reference is written to disk.
export async function planTrustInit(registryFile: string, store?: SecretStore | null, options: { clientId?: string; device?: string } = {}): Promise<{ plan: TrustInitPlan; privateKey: string }> {
  const file = await realpath(registryFile);
  const registry = await loadRegistry(file);
  const selected = options.device ? registry.devices.filter(device => device.name === options.device || device.device_id === options.device) : registry.devices;
  if (!selected.length) throw new Error('No paired computer matches; pair one first or pass --device');
  const clientId = options.clientId ?? 'mac-' + randomBytes(8).toString('hex');
  const keys = generateDeviceKeyPair();
  const keyRef = store ? clientId + ':signing' : null;
  return { privateKey: keys.private_key, plan: {
    file, client_id: clientId, public_key: keys.public_key, fingerprint: publicKeyFingerprint(keys.public_key),
    key_ref: keyRef, devices: selected.map(device => device.name),
    node_configuration: { trusted_clients: [{ device_id: clientId, public_key: keys.public_key }] },
  } };
}

export async function applyTrustInit(plan: TrustInitPlan, privateKey: string, store?: SecretStore | null) {
  if (!store || !plan.key_ref) throw new Error('No system keychain is available, so the signing key would have to be stored in plain text; refusing');
  const before = await readFile(plan.file, 'utf8');
  const registry = JSON.parse(before) as Registry;
  await store.set(plan.key_ref, privateKey);
  const stored = await store.get(plan.key_ref);
  if (stored !== privateKey) throw new Error('The keychain did not return the key it stored; configuration left unchanged');
  let changed = 0;
  for (const device of registry.devices) {
    if (!plan.devices.includes(device.name)) continue;
    device.signing = { device_id: plan.client_id, public_key: plan.public_key, key_ref: plan.key_ref };
    changed++;
  }
  const backup = plan.file + '.before-signing-' + new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(plan.file, backup);
  const staging = plan.file + '.next-' + randomBytes(6).toString('hex');
  await writeFile(staging, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(staging, plan.file);
  return { file: plan.file, backup, updated: changed, fingerprint: plan.fingerprint, node_configuration: plan.node_configuration };
}

export async function trustStatus(registryFile: string, store?: SecretStore | null) {
  const file = await realpath(registryFile);
  const registry = await loadRegistry(file);
  const devices = await Promise.all(registry.devices.map(async device => {
    const signing = device.signing;
    const present = signing ? (signing.key_pem ? true : signing.key_ref && store ? (await store.get(signing.key_ref)) !== null : false) : false;
    return { name: device.name, signing: !!signing, device_id: signing?.device_id ?? null,
      fingerprint: signing ? publicKeyFingerprint(signing.public_key) : null, key_present: present };
  }));
  return { file, store: store ? store.kind : 'unavailable', devices };
}
