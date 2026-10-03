import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createNode, type Config } from '../apps/node/server.js';
import { createBridge } from '../apps/runtime/webdav.js';
import type { Device } from '../apps/runtime/client.js';

test('retained DAV fixture streams large files, protects locks and replaces without delete RPC', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentlink-retained-dav-'));
  const root = path.join(directory, 'files'); await mkdir(root);
  const cert = path.join(directory, 'cert.pem'), key = path.join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const config: Config = { name: 'Fixture', device_id: 'dav-test', host: '127.0.0.1', port: 0, token: 'fixture'.repeat(10), cert, key, allowed_roots: [root], mode: 'developer', capabilities: ['filesystem'], audit: path.join(directory, 'audit.jsonl'), kill_switch: path.join(directory, 'STOP') };
  const { server } = await createNode(config);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())); });
  const device: Device = { name: config.name, device_id: config.device_id, token: config.token, ca: cert, url: `https://127.0.0.1:${(server.address() as { port: number }).port}` };
  const password = 'bridge-fixture'.repeat(5);
  let currentDevice = device;
  const bridge = await createBridge(device, root, password, 0, 'native', async () => currentDevice);
  const port = await new Promise<number>(r => bridge.start(s => r((s!.address() as { port: number }).port)));
  t.after(() => new Promise<void>(r => bridge.stop(r)));
  const base = 'http://127.0.0.1:' + port;
  const request = (method: string, target: string, args: string[] = [], secret = password) => new Promise<Buffer>((resolve, reject) => {
    const child = spawn('curl', ['--noproxy', '*', '-sS', '--max-time', '10', '--digest', '--config', '-', '-X', method, base + target, ...args]);
    const chunks: Buffer[] = []; let err = '';
    child.stdout.on('data', b => chunks.push(b)); child.stderr.on('data', b => err += b); child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(Error(err)));
    child.stdin.end(`user = "agentlink:${secret}"\n`);
  });
  assert.match((await request('GET', '/', ['-w', '%{http_code}'], 'wrong')).toString(), /401$/);
  // A missing file must remain missing. Fabricated zero-byte metadata makes macOS O_EXCL fail.
  assert.match((await request('PROPFIND', '/not-created-yet.txt', ['-H', 'Depth: 0', '-w', '%{http_code}'])).toString(), /404$/);
  const data = Buffer.alloc(2200000, 23), input = path.join(directory, 'original-backup.bin'); await writeFile(input, data);
  assert.match((await request('PUT', '/large.bin', ['--data-binary', '@' + input, '-w', '%{http_code}'])).toString(), /20[014]$/);
  assert.deepEqual(await request('GET', '/large.bin'), data);
  await request('PUT', '/editor-temp.bin', ['--data-binary', 'replacement']);
  const lock = (await request('LOCK', '/large.bin', ['-i', '-H', 'Content-Type: application/xml', '--data-binary', '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>'])).toString();
  const token = lock.match(/Lock-Token:\s*(<[^>]+>)/i)?.[1]; assert.ok(token);
  assert.match((await request('PUT', '/large.bin', ['--data-binary', 'blocked', '-w', '%{http_code}'])).toString(), /423$/);
  assert.match((await request('MOVE', '/editor-temp.bin', ['-H', 'Destination: ' + base + '/large.bin', '-w', '%{http_code}'])).toString(), /423$/);
  assert.deepEqual(await readFile(path.join(root, 'large.bin')), data);
  await request('UNLOCK', '/large.bin', ['-H', 'Lock-Token: ' + token]);
  const moved = await request('MOVE', '/editor-temp.bin', ['-H', 'Destination: ' + base + '/large.bin', '-w', '%{http_code}']);
  assert.match(moved.toString(), /20[014]$/);
  assert.equal(await readFile(path.join(root, 'large.bin'), 'utf8'), 'replacement');
  assert.deepEqual(await readFile(input), data);
  // The running bridge must follow verified registry updates instead of caching an old route.
  currentDevice = { ...device, url: 'https://127.0.0.1:1' };
  assert.match((await request('GET', '/large.bin', ['-w', '%{http_code}'])).toString(), /[45]\d\d$/);
  currentDevice = device;
  assert.equal((await request('GET', '/large.bin')).toString(), 'replacement');
  const audit = await readFile(config.audit, 'utf8');
  assert.match(audit, /files.replace/);
  assert.equal(audit.includes('files.delete'), false);
});
