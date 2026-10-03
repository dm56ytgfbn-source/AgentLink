import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createNode, type Config } from '../apps/node/server.js';
import { call, type Device } from '../apps/runtime/client.js';
import { setTimeout as wait } from 'node:timers/promises';

test('retained HTTPS fixture verifies identity, atomic new write, task protocol and kill latch', async t => {
  if(process.platform!=='win32'&&process.platform!=='darwin') { t.skip('command tasks require a supported Windows or macOS adapter'); return; }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-retained-https-'));
  const root = path.join(dir, 'share'); await mkdir(root);
  const cert = path.join(dir, 'cert.pem'), key = path.join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const config: Config = { device_id: 'test', name: 'Test', host: '127.0.0.1', port: 0, token: 'fixture'.repeat(10), cert, key,
    allowed_roots: [root], mode: 'developer', capabilities: ['filesystem', 'tasks'], tasks_dir: path.join(dir, 'tasks'), audit: path.join(dir, 'audit.jsonl'), kill_switch: path.join(dir, 'STOP') };
  const { server, initializeTasks } = await createNode(config);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); await initializeTasks();
  t.after(() => { server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())); });
  const device: Device = { device_id: 'test', name: 'Test', url: `https://127.0.0.1:${(server.address() as { port: number }).port}`, token: config.token, ca: cert };
  await assert.rejects(call({ ...device, token: 'wrong' }), /UNAUTHORIZED/);
  await assert.rejects(call({ ...device, device_id: 'wrong' }), /identity mismatch/);
  const info = await call(device) as { features: string[] };
  assert.ok(info.features.includes('persistent-tasks-v1'));
  const target = path.join(root, '中文.txt');
  await call(device, 'files.write', { path: target, data: '你好', encoding: 'utf8' });
  assert.equal(await readFile(target, 'utf8'), '你好');
  const taskInput = { key: 'hello', command: "Write-Output 'test'", cwd: root, timeout: 20000 };
  const submitted = await call(device, 'tasks.submit', taskInput) as { id: string };
  assert.equal((await call(device, 'tasks.submit', taskInput) as { duplicate: boolean }).duplicate, true);
  await assert.rejects(call(device, 'tasks.submit', { ...taskInput, command: 'different' }), /different task/);
  let status = '';
  const deadline = Date.now() + 25000;
  do {
    status = (await call(device, 'tasks.get', { task_id: submitted.id }) as { status: string }).status;
    if (['failed', 'succeeded'].includes(status)) break;
    await wait(100);
  } while (Date.now() < deadline);
  assert.equal(status, process.platform === 'win32' ? 'succeeded' : 'failed');
  await assert.rejects(call(device, 'tasks.get', { task_id: '../outside' }), /INVALID_REQUEST/);
  config.mode = 'read-only';
  await assert.rejects(call(device, 'tasks.submit', { ...taskInput, key: 'blocked' }), /FORBIDDEN/);
  await writeFile(config.kill_switch, 'stop', { flag: 'wx' });
  await assert.rejects(call(device), /disabled/);
  const auditText = await readFile(config.audit, 'utf8');
  assert.equal(auditText.includes(config.token), false);
  assert.equal(auditText.split('\n').filter(Boolean).some(line => line.includes('"/info"')), false, 'read-only health probes must not flood the audit log');
  assert.ok(auditText.includes('files.write'), 'real operations must still be recorded');
});
