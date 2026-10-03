import { cp, mkdir, readFile, writeFile, stat, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

if (process.platform !== 'darwin') throw Error('macOS required');
const project = fileURLToPath(new URL('../', import.meta.url));
const [registryArgument, bridgeArgument] = process.argv.slice(2);
if (!registryArgument || !bridgeArgument) throw Error('Usage: node scripts/install-macos.mjs REGISTRY_JSON BRIDGE_JSON');
const registryFile = path.resolve(registryArgument), bridgeFile = path.resolve(bridgeArgument);
const registry = JSON.parse(await readFile(registryFile, 'utf8'));
const bridge = JSON.parse(await readFile(bridgeFile, 'utf8'));
if (!Array.isArray(registry.devices) || !registry.devices.some(d => d.name === bridge.name)) throw Error('Bridge device must exist in registry');
if (typeof bridge.name !== 'string' || !bridge.name.trim() || /[\\/\x00-\x1f]/.test(bridge.name) || ['.', '..'].includes(bridge.name)) throw Error('Device name must be a single safe directory name');
if (!Number.isInteger(bridge.port) || bridge.port < 1024 || bridge.port > 65535) throw Error('Bridge port must be an integer from 1024 to 65535');
if (!bridge.roots || typeof bridge.roots !== 'object' || Array.isArray(bridge.roots) || !Object.keys(bridge.roots).length) throw Error('At least one exported root required');
for (const [name, root] of Object.entries(bridge.roots)) {
  if (!name || /[\\/\x00-\x1f]/.test(name) || ['.', '..'].includes(name) || typeof root !== 'string' || !path.win32.isAbsolute(root)) throw Error('Invalid exported root');
}
for (const device of registry.devices) {
  if (typeof device.device_id !== 'string' || !device.device_id || typeof device.token !== 'string' || device.token.length < 32 || typeof device.ca !== 'string') throw Error('Incomplete paired device');
  if (new URL(device.url).protocol !== 'https:') throw Error('Paired endpoints must use HTTPS');
  await access(path.resolve(path.dirname(registryFile), device.ca));
}
if (typeof bridge.password !== 'string' || bridge.password.length < 32) throw Error('Strong independent bridge password required');
if (typeof bridge.probe_relative_path !== 'string' || !bridge.probe_relative_path) throw Error('Configure probe_relative_path to an existing harmless file in the exported folder');
if (path.isAbsolute(bridge.probe_relative_path) || bridge.probe_relative_path.split(/[\\/]/).some(part => !part || part === '..' || part === '.') || !Object.hasOwn(bridge.roots, bridge.probe_relative_path.split(/[\\/]/)[0])) throw Error('Probe must be a relative file inside an exported root');
await access(path.join(project, 'dist/apps/runtime/client.js')); await access(path.join(project, 'node_modules'));
const base = path.join(os.homedir(), 'Library/Application Support/AgentLink');
const config = path.join(base, 'config');
const label = 'local.agentlink.runtime';
const plistFile = path.join(os.homedir(), 'Library/LaunchAgents', label + '.plist');
for (const target of [config, plistFile]) {
  try { await stat(target); throw Error('Existing installation preserved. Review it before upgrading: ' + target); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
const version = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version;
const release = path.join(base, 'releases', version + '-' + Date.now());
await mkdir(release, { recursive: true, mode: 0o700 });
for (const item of ['dist', 'scripts', 'node_modules', 'package.json', 'agents']) await cp(path.join(project, item), path.join(release, item), { recursive: true, errorOnExist: true, force: false });
await mkdir(path.join(release, 'native'));
execFileSync('swiftc', [path.join(project, 'native/Mount.swift'), '-o', path.join(release, 'native/agentlink-mount'), '-framework', 'NetFS'], { stdio: 'inherit' });
await mkdir(config, { recursive: true, mode: 0o700 });
for (const [index, device] of registry.devices.entries()) {
  const ca = path.join(config, 'paired-' + index + '.pem');
  await cp(path.resolve(path.dirname(registryFile), device.ca), ca, { errorOnExist: true, force: false }); device.ca = ca;
}
await writeFile(path.join(config, 'runtime.local.json'), JSON.stringify(registry, null, 2), { flag: 'wx', mode: 0o600 });
await writeFile(path.join(config, 'bridge.local.json'), JSON.stringify(bridge, null, 2), { flag: 'wx', mode: 0o600 });
const state = path.join(base, 'state'), mount = path.join(os.homedir(), 'AgentLink', bridge.name);
await mkdir(state, { recursive: true, mode: 0o700 });
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const args = [process.execPath, path.join(release, 'scripts/mac-supervisor.mjs'), path.join(config, 'runtime.local.json'), path.join(config, 'bridge.local.json'), state, mount];
const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(arg => '<string>' + escape(arg) + '</string>').join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>WorkingDirectory</key><string>${escape(release)}</string><key>StandardOutPath</key><string>${escape(path.join(state, 'launch.stdout.log'))}</string><key>StandardErrorPath</key><string>${escape(path.join(state, 'launch.stderr.log'))}</string></dict></plist>`;
await mkdir(path.dirname(plistFile), { recursive: true });
await writeFile(plistFile, xml, { flag: 'wx', mode: 0o600 });
execFileSync('launchctl', ['bootstrap', 'gui/' + process.getuid(), plistFile], { stdio: 'inherit' });
console.log(JSON.stringify({ release, state, mount, launch_agent: plistFile }, null, 2));
