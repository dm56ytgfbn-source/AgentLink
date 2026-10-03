import { readFile, access, appendFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { call } from '../runtime/client.js';
import { connectionFailure } from '../runtime/health.js';
import { validateConfig, type Config } from './server.js';

const configPath = path.resolve(process.argv[2] ?? 'node.local.json');
const main = fileURLToPath(new URL('./main.js', import.meta.url));
const c: Config = JSON.parse(await readFile(configPath, 'utf8'));
validateConfig(c);
const logs = path.join(path.dirname(configPath), 'supervisor');
await mkdir(logs, { recursive: true, mode: 0o700 });
const log = async (event: string) => appendFile(path.join(logs, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event }) + '\n', { mode: 0o600 });
const lock = createServer(socket => socket.end());
const lockPort = 40000 + parseInt(createHash('sha256').update(c.device_id).digest('hex').slice(0, 6), 16) % 20000;
try {
  await new Promise<void>((resolve, reject) => { lock.once('error', reject); lock.listen(lockPort, '127.0.0.1', resolve); });
} catch (e) {
  console.error((e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'Supervisor already running or lock port occupied; no second instance started.' : 'SUPERVISOR_LOCK_FAILED');
  process.exit(1);
}
let halted = false, stopping = false, ownedPid: number | undefined;
const exists = async (file: string) => { try { await access(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } };
const device = { name: c.name, device_id: c.device_id, token: c.token, ca: c.cert, url: `https://${c.host === '0.0.0.0' ? '127.0.0.1' : c.host}:${c.port}` };
const stop = () => { stopping = true; lock.close(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
await log('supervisor_started');
let launches: number[] = [];
while (!stopping) {
  try {
    if (await exists(c.kill_switch) || await exists(configPath + '.supervisor-stop')) {
      if (!halted) await log('halted_by_marker');
      halted = true; // Latched: removing a marker cannot silently revive access.
    }
    if (!halted) {
      try { await call(device); }
      catch (e) {
        const failure = connectionFailure(e);
        if (failure.error_code === 'CONNECTION_REFUSED' && !ownedPid) {
          launches = launches.filter(t => Date.now() - t < 300000);
          if (launches.length < 5) {
            launches.push(Date.now());
            await log('starting_node');
            const child = spawn(process.execPath, [main, 'serve', configPath], { cwd: path.dirname(configPath), windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
            ownedPid = child.pid;
            child.once('error', () => { ownedPid = undefined; });
            child.once('exit', () => { ownedPid = undefined; });
          }
        } else if (!failure.retryable) {
          halted = true; await log('halted_' + failure.error_code);
        }
      }
    }
  } catch { halted = true; await log('halted_configuration_or_storage_error'); }
  await wait(3000);
}
await log('supervisor_stopped_node_left_running');
