import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {createNode, type Config} from '../apps/node/server.js';
import {setupNode} from '../apps/node/setup.js';
import {PairingService, pairingWindowOpen} from '../apps/node/pairing.js';
import {pairWith, beginPairWith, finishPairWith} from '../apps/runtime/pair-auto.js';
import {call} from '../apps/runtime/client.js';
import {resolvePaths} from '../packages/config/index.js';
import {browse, startAnnouncer} from '../packages/discovery/index.js';

let nextPort = 18100;
function takePort() { nextPort += 1 + Math.floor(Math.random() * 7); return nextPort; }

async function station(port: number, extra: Partial<Config> = {}, localFiles = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-station-'));
  const setup = await setupNode({ directory: path.join(dir, 'node'), roots: [path.join(dir, 'share')], port });
  const config = JSON.parse(await readFile(setup.config, 'utf8')) as Config;
  let approved = false;
  const receivedClients: {device_id:string;name:string}[] = [];
  const { server } = await createNode({ ...config, host: '127.0.0.1', ...extra }, localFiles ? {} : { onPairingRequest: (_id, client) => { receivedClients.push(client); setTimeout(() => { approved = true; }, 150); }, isPairingApproved: () => approved });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  return { dir, setup, config, server, receivedClients, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

function announcement(target: Awaited<ReturnType<typeof station>>, port: number, overrides: Record<string, unknown> = {}) {
  return { v: 1, kind: 'agentlink' as const, device_id: target.config.device_id, name: target.config.name,
    os: 'darwin', hostname: 'test-host', port, host: '127.0.0.1', fingerprint: target.setup.fingerprint,
    pairing_open: true, version: '0.2.0', ...overrides };
}

test('a computer prepares its own identity without hand editing', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-setup-'));
  // Keep test fixtures for diagnosis; no filesystem deletion.
  const result = await setupNode({ directory: path.join(dir, 'node'), roots: [path.join(dir, 'share')], port: 18999 });
  assert.equal(result.created, true);
  assert.ok(result.token.length >= 32, 'a token is generated');
  assert.ok(result.tls_server_name.startsWith('agentlink-'));
  assert.match(result.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  const config = JSON.parse(await readFile(result.config, 'utf8'));
  assert.equal(config.port, 18999);
  assert.deepEqual(config.allowed_roots, [path.join(dir, 'share')]);
  assert.equal(config.capabilities.includes('shell'),process.platform==='darwin'||process.platform==='win32');
  // Running it again must not rotate the identity.
  const again = await setupNode({ directory: path.join(dir, 'node'), roots: [path.join(dir, 'share')] });
  assert.equal(again.created, false);
  assert.equal(again.device_id, result.device_id);
  assert.equal(again.token, result.token);
  assert.equal(again.fingerprint, result.fingerprint);
});

test('two computers connect only after the receiving computer approves locally', async t => {
  const port = takePort();
  const stationA = await station(port);
  t.after(async () => { await stationA.close(); });
  const paths = resolvePaths({ home: path.join(stationA.dir, 'client-home'), sourceRoot: path.join(stationA.dir, 'release') });

  const localIdentity = { directory: path.join(stationA.dir, 'client-node'), shareRoot: path.join(stationA.dir, 'client-share') };
  const result = await pairWith(announcement(stationA, port), { paths, name: 'Test-Mac', localIdentity });
  assert.equal(result.device_id, stationA.config.device_id);
  assert.equal('code' in result,false,'pairing does not ask the user to copy a code');

  const registry = JSON.parse(await readFile(paths.registry, 'utf8'));
  const device = registry.devices[0];
  assert.equal(device.name, stationA.config.name);
  assert.ok(device.ca.startsWith(paths.certDir), 'the certificate is written under this computer home');
  const info = await call(device) as { device_id: string };
  assert.equal(info.device_id, stationA.config.device_id, 'the freshly paired computer answers authenticated calls');
  const localNode = await setupNode(localIdentity);
  assert.equal(stationA.receivedClients[0].device_id, localNode.device_id, 'outgoing pairing and future inbound node use one stable identity');
});

test('pairing refuses when it is not open, or when the certificate does not match', async t => {
  const port = takePort();
  const stationA = await station(port, { paired_clients: [{ device_id: 'existing', name: 'Old', paired_at: new Date().toISOString() }] });
  t.after(async () => { await stationA.close(); });
  const paths = resolvePaths({ home: path.join(stationA.dir, 'client-home'), sourceRoot: path.join(stationA.dir, 'release') });
  const localIdentity = { directory: path.join(stationA.dir, 'client-node'), shareRoot: path.join(stationA.dir, 'client-share') };

  await assert.rejects(pairWith(announcement(stationA, port), { paths, localIdentity }), /拒绝了配对请求|不允许配对/, 'a computer that already has a client stays closed');
  await assert.rejects(pairWith(announcement(stationA, port, { fingerprint: '00:11:22:33' }), { paths, localIdentity }), /指纹|ECONNRESET|socket hang up/,
    'a certificate that does not match what was announced must not be accepted');
});

test('computers announce themselves on the local network', async t => {
  const marker = path.join(os.tmpdir(), 'agentlink-pairing-marker-' + Date.now());
  assert.equal(pairingWindowOpen(marker, false, Date.now() + 1000, Date.now()), true, 'a fresh computer opens a window');
  assert.equal(pairingWindowOpen(marker, true, Date.now() + 1000, Date.now()), false, 'a computer with clients is closed by default');
  assert.equal(pairingWindowOpen(marker, true, Date.now() - 1, Date.now()), false, 'the window expires');

  const announcer = startAnnouncer(() => ({ v: 1, kind: 'agentlink', device_id: 'device-x', name: 'Test-Station', os: 'darwin',
    hostname: 'test-host', port: 18999, host: '127.0.0.1', fingerprint: 'AA:BB', pairing_open: true, version: '0.2.0' }),
    { target: '127.0.0.1', port: 47823 });
  t.after(() => announcer.stop());
  const peers = await browse({ port: 47823, timeoutMs: 2500, bindAddress: '0.0.0.0' });
  assert.ok(peers.some(peer => peer.device_id === 'device-x'), 'the station must be discoverable');
});

test('the receiving computer writes a request locally and grants access only after its approval marker', async t => {
  const port=takePort();
  const target=await station(port,{},true);
  t.after(async()=>{await target.close()});
  const paths=resolvePaths({home:path.join(target.dir,'approved-client'),sourceRoot:path.join(target.dir,'release')});
  const attempt=await beginPairWith(announcement(target,port),'My Mac',
    { directory: path.join(target.dir, 'client-node'), shareRoot: path.join(target.dir, 'client-share') });
  const request=JSON.parse(await readFile(path.join(path.dirname(target.config.audit),'pairing-requests',attempt.pendingId+'.json'),'utf8'));
  assert.equal(request.name,'My Mac');
  const status=await new Promise<number>((resolve,reject)=>{
    const r=https.request({hostname:'127.0.0.1',port,path:'/pair/complete',method:'POST',rejectUnauthorized:false,headers:{'content-type':'application/json'}},response=>{response.resume();resolve(response.statusCode!)});
    r.on('error',reject);r.end(JSON.stringify({pending_id:attempt.pendingId}));
  });
  assert.equal(status,202,'the remote cannot approve itself');
  const approvalDir=path.join(path.dirname(target.config.audit),'pairing-approvals');await mkdir(approvalDir);
  await writeFile(path.join(approvalDir,attempt.pendingId+'.approved'),'approved',{flag:'wx',mode:0o600});
  const result=await finishPairWith(attempt,paths);
  assert.equal(result.device_id,target.config.device_id);
  const registry=JSON.parse(await readFile(paths.registry,'utf8'));
  assert.equal((await call(registry.devices[0]) as {device_id:string}).device_id,target.config.device_id);
});

test('receiving node rejects its own identity even from an old or manual client', () => {
  let requests = 0;
  const clients: {device_id: string; name: string; paired_at: string}[] = [];
  const service = new PairingService({
    station: () => ({ device_id: 'self-id', name: 'This PC', os: 'win32', hostname: 'test',
      port: 7443, tls_server_name: 'test.local', fingerprint: '', pairing_open: true, protocol: 1 }),
    markerFile: path.join(os.tmpdir(), 'agentlink-self-pair-no-marker'), clients,
    onPaired: async () => {}, onRequest: () => { requests++; }, isApproved: () => true,
  });
  assert.deepEqual(service.request({device_id: 'self-id', name: 'Different display name'}), {ok: false, reason: 'self-pairing'});
  assert.equal(service.pendingCount, 0);
  assert.equal(requests, 0);
  assert.deepEqual(clients, []);
  assert.equal(service.request({device_id: 'other-id', name: 'This PC'}).ok, true,
    'different devices with the same display name must still be allowed');
});

test('outgoing self-pair is rejected before requesting approval or writing a registry', async t => {
  const port = takePort();
  const target = await station(port);
  t.after(async () => { await target.close(); });
  const paths = resolvePaths({home: path.join(target.dir, 'self-client')});
  const localIdentity = {directory: path.dirname(target.setup.config)};
  await assert.rejects(pairWith(announcement(target, port), {paths, localIdentity}), /不能与自己配对/);
  assert.deepEqual(target.receivedClients, [], 'no confirmation request should reach the UI');
  await assert.rejects(readFile(paths.registry), {code: 'ENOENT'}, 'no pairing should be stored');
  assert.equal((await setupNode(localIdentity)).device_id, target.config.device_id,
    'rejecting self-pair must preserve existing identity');
});
