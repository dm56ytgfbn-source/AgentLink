import { readFile, writeFile, mkdir, readdir, access, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import http from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { inspectDevice } from '../dist/apps/runtime/health.js';

const [configFile, bridgeFile, stateDirectory, mountPath] = process.argv.slice(2);
if (![configFile, bridgeFile, stateDirectory, mountPath].every(p => p && path.isAbsolute(p))) throw Error('Four absolute paths required: registry bridge state mount');
const project = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(configFile, 'utf8'));
const settings = JSON.parse(await readFile(bridgeFile, 'utf8'));
let device = config.devices.find(d => d.name === settings.name);
if (!device) throw Error('Device not paired');
const probeRelative = settings.probe_relative_path;
if (probeRelative !== undefined && (typeof probeRelative !== 'string' || path.isAbsolute(probeRelative) || probeRelative.split(/[\\/]/).some(p => p === '..' || !p))) throw Error('Invalid mount probe path');
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
const mutex = createServer(socket => socket.end());
await new Promise((resolve, reject) => { mutex.once('error', reject); mutex.listen(39748, '127.0.0.1', resolve); });
const exec = promisify(execFile);
let stopped = false, child, nextMount = 0, nextBridge = 0, mounting = false, mountExit;
let nextReconnect = 0;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; mutex.close(); });
async function available() {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port: settings.port, path: '/', timeout: 1500 }, response => {
      response.resume(); resolve(response.statusCode === 401 && String(response.headers['www-authenticate']).includes('AgentLink'));
    });
    request.on('error', () => resolve(false)); request.on('timeout', () => request.destroy());
  });
}
async function mountState() {
  const { stdout } = await exec('/sbin/mount', [], { timeout: 5000 });
  const line = stdout.split('\n').find(line => line.includes(' on ' + mountPath + ' ('));
  if (!line) return 'unmounted';
  const source = line.slice(0, line.indexOf(' on '));
  try { const url = new URL(source); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === String(settings.port) && url.pathname === '/' && /\bwebdav\b/.test(line) ? 'agentlink' : 'other'; }
  catch { return 'other'; }
}
async function mount() {
  await mkdir(mountPath, { recursive: true });
  if ((await readdir(mountPath)).length) throw Error('Mount directory is not empty; existing files preserved');
  const helper = spawn(path.join(project, 'native/agentlink-mount'), [], { stdio: ['pipe', 'ignore', 'pipe'] });
  // No timeout kill: killing NetFS mid-mount can leave ambiguous state. Suppress further retries until it returns.
  helper.stdin.on('error', () => {}); helper.stderr.resume();
  helper.stdin.end(JSON.stringify({ port: settings.port, password: settings.password, mount: mountPath }));
  return await new Promise((resolve, reject) => { helper.once('error', reject); helper.once('exit', resolve); });
}
while (!stopped) {
  const state = { at: new Date().toISOString(), computer: settings.name, online: false, bridge: false, mount: 'unknown' };
  try {
    try { await access(path.join(stateDirectory, 'STOP')); stopped = true; mutex.close(); break; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const registry = JSON.parse(await readFile(configFile, 'utf8'));
    const updated = registry.devices.find(d => d.device_id === device.device_id && d.name === settings.name);
    if (!updated) throw Error('Paired device no longer configured');
    device = updated;
    const health = await inspectDevice(device);
    state.online = health.online;
    if (!health.online) state.error_code = health.error_code;
    // A DHCP change must not require the user to repair the pairing by hand. The new address
    // is only accepted after the device proves its identity, and at most every five minutes.
    if (!health.online && Date.now() >= nextReconnect) {
      nextReconnect = Date.now() + 300000;
      try {
        const { reconnectAuto } = await import('../dist/apps/runtime/reconnect.js');
        const report = await reconnectAuto(configFile, device.name);
        state.reconnect = report.changed ? { changed: true, url: report.url, previous_url: report.previous_url } : { changed: false, attempts: report.attempts };
        if (report.changed) state.error_code = 'RECONNECTED';
      } catch (error) { state.reconnect = { changed: false, error: error.code ?? error.message }; }
    }
    state.bridge = await available();
    if (health.online && !state.bridge && !child && Date.now() >= nextBridge) {
      nextBridge = Date.now() + 30000;
      child = spawn(process.execPath, [path.join(project, 'dist/apps/runtime/bridge-main.js')], {
        cwd: project, env: { ...process.env, AGENTLINK_CONFIG: configFile, AGENTLINK_BRIDGE_CONFIG: bridgeFile }, stdio: 'ignore',
      });
      child.once('error', () => { child = undefined; }); child.once('exit', () => { child = undefined; });
    }
    state.mount = await mountState();
    if (health.online && state.bridge && state.mount === 'agentlink' && probeRelative) {
      try {
        await exec(process.execPath, ['-e', "const f=require('fs');const fd=f.openSync(process.argv[1],'r');f.readSync(fd,Buffer.alloc(16),0,16,0);f.closeSync(fd)", path.join(mountPath, probeRelative)], { timeout: 4000 });
        state.mount_io = true;
      } catch {
        state.mount_io = false;
        // Ordinary unmount flushes/obeys busy checks. Never force-unmount or delete a mount directory.
        try { await exec('/sbin/umount', [mountPath], { timeout: 5000 }); state.mount = 'unmounted'; nextMount = 0; }
        catch { state.error_code = 'MOUNT_IO_FAILED_OR_BUSY'; }
      }
    }
    if (health.online && state.bridge && state.mount === 'unmounted' && !mounting && Date.now() >= nextMount) {
      nextMount = Date.now() + 60000;
      // Mount may require a logged-in graphical session.
      mounting = true;
      void mount().then(code => { mountExit = code; }).catch(() => { mountExit = 'MOUNT_FAILED'; }).finally(() => { mounting = false; });
    }
    state.mount_attempt_running = mounting;
    if (mountExit !== undefined) state.mount_attempt_exit = mountExit;
    state.ready = state.online && state.bridge && state.mount === 'agentlink' && state.mount_io === true;
    if (!probeRelative && state.mount === 'agentlink') state.error_code = 'MOUNT_IO_NOT_CONFIGURED';
  } catch (e) { state.error_code = e.code ?? 'RECOVERY_FAILED'; state.ready = false; }
  await writeFile(path.join(stateDirectory, 'status.next.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(path.join(stateDirectory, 'status.next.json'), path.join(stateDirectory, 'status.json'));
  await wait(10000);
}
// Leave an established mount/bridge intact; stopping supervision never deletes data.
process.exitCode = 0;
