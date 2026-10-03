import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultNodeCapabilities } from '../adapters/host.js';
import { setupNode } from '../apps/node/setup.js';
import { createNode, type Config } from '../apps/node/server.js';
import { call, type Device } from '../apps/runtime/client.js';
import { ComputerContext, localDeviceInfo } from '../apps/runtime/context.js';

test('capabilities are advertised only for the node operating system', () => {
  assert.deepEqual(defaultNodeCapabilities('darwin'), ['filesystem', 'shell', 'tasks', 'apps']);
  assert.ok(defaultNodeCapabilities('win32').includes('window'));
  assert.ok(!defaultNodeCapabilities('darwin').includes('window'));
});

test('a Mac peer gets a stable identity and an OS-correct default directory', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-mac-peer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const nodeDir = path.join(dir, '.agentlink-node');
  const root = path.join(dir, 'shared');
  await mkdir(root);
  const identity = await setupNode({ directory: nodeDir, roots: [root] });
  const again = await setupNode({ directory: nodeDir, roots: [root] });
  assert.equal(identity.device_id, again.device_id);
  const local = await localDeviceInfo(dir);
  assert.equal(local.device_id, identity.device_id);
  const config = JSON.parse(await readFile(identity.config, 'utf8')) as Config;
  assert.deepEqual(config.capabilities, defaultNodeCapabilities());
  const registry = path.join(dir, 'runtime.json');
  const remote = { device_id: 'mac-b', name: 'Second Mac' };
  await writeFile(registry, JSON.stringify({ devices: [remote] }));
  const context = new ComputerContext(registry, 'peer-test', async () => ({ ...local, device_id: remote.device_id,
    name: remote.name, os: 'darwin', default_cwd: '/Users/other/AgentLinkShare' }), async () => local);
  assert.equal((await context.list())[0].device_id, identity.device_id);
  assert.equal((await context.use(remote.name)).cwd, '/Users/other/AgentLinkShare');
  await assert.rejects(context.use(remote.name, 'C:\\Other'), /absolute/);
  assert.equal((await context.use('local')).computer_id, identity.device_id);
});

test('pairing setup preserves an unreadable existing identity for repair', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-bad-identity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'node.local.json');
  await writeFile(config, '{broken json');
  await assert.rejects(setupNode({ directory: dir, roots: [path.join(dir, 'share')] }), /refusing to replace/);
  assert.equal(await readFile(config, 'utf8'), '{broken json');
});

test('Mac node serves authenticated native shell and files', { skip: process.platform !== 'darwin' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-mac-node-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'shared');
  await mkdir(root);
  const setup = await setupNode({ directory: path.join(dir, 'node'), roots: [root] });
  const config = JSON.parse(await readFile(setup.config, 'utf8')) as Config;
  const { server, initializeTasks } = await createNode(config);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await initializeTasks();
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const device: Device = { name: config.name, device_id: config.device_id, token: config.token,
    ca: config.cert, tls_server_name: config.tls_server_name,
    url: 'https://127.0.0.1:' + (server.address() as { port: number }).port };
  const info = await call(device) as { os: string; default_cwd: string; capabilities: string[] };
  assert.equal(info.os, 'darwin');
  assert.equal(info.default_cwd, root);
  assert.ok(info.capabilities.includes('shell'));
  assert.ok(!info.capabilities.includes('window'));
  const shell = await call(device, 'shell.run', { command: "printf 'mac-node-ok'", cwd: root }) as { stdout: string; exit_code: number };
  assert.equal(shell.exit_code, 0);
  assert.equal(shell.stdout, 'mac-node-ok');
  const file = path.join(root, 'probe.txt');
  await call(device, 'files.write', { path: file, data: 'peer-file', encoding: 'utf8' });
  const content = await call(device, 'files.read', { path: file }) as { data: string };
  assert.equal(Buffer.from(content.data, 'base64').toString(), 'peer-file');
});
