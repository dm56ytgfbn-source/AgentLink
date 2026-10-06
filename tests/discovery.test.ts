import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { broadcastTargets, browse, describePeers, startAnnouncer, DISCOVERY_PORT } from '../packages/discovery/index.js';

// The announcement used to go to 255.255.255.255 only. On a computer carrying a virtual
// adapter that packet leaves through the virtual interface and never reaches the network the
// other computer is on, which looks exactly like "the service is running but nobody can find
// it". These tests pin both halves: the target list must cover every real interface, and an
// announcement must still be collectable.

// A private port: node --test runs files in parallel and two browsers on the same port with
// reuseAddr steal each other's datagrams, which would make the pairing test look broken.
const TEST_PORT = 47991;

test('广播目标包含全网广播和每张真实网卡的子网广播', () => {
  const targets = broadcastTargets();
  assert.ok(targets.includes('255.255.255.255'), '缺少 255.255.255.255');
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const address = entry.address.split('.').map(Number);
      const mask = entry.netmask.split('.').map(Number);
      const expected = address.map((part, index) => (part & mask[index]) | (~mask[index] & 0xff)).join('.');
      assert.ok(targets.includes(expected), '缺少 ' + entry.address + ' 的子网广播 ' + expected);
    }
  }
  assert.equal(new Set(targets).size, targets.length, '目标里出现了重复');
  assert.ok(!targets.some(target => target.startsWith('127.')), '不该往回环地址发广播');
});

test('广播能被打包并重新收到（声明的地址是数据包真正来的地方）', async () => {
  const announcer = startAnnouncer(() => ({ v: 1, kind: 'agentlink', device_id: 'device-discovery-test',
    name: 'discovery-test', os: 'test', hostname: 'discovery-test', port: 7443, host: 'example.invalid',
    fingerprint: 'AA:BB', pairing_open: true, version: '0.1.0' }), { target: '127.0.0.1', port: TEST_PORT, intervalMs: 100 });
  try {
    const peers = await browse({ port: TEST_PORT, timeoutMs: 2500, bindAddress: '127.0.0.1' });
    const found = peers.find(peer => peer.device_id === 'device-discovery-test');
    assert.ok(found, '没有收到自己发出的广播');
    assert.equal(found.port, 7443);
    // The declared host is deliberately unusable here: the collector must report where the
    // packet actually came from, because that is the address that routes back.
    assert.equal(found.host, '127.0.0.1');
    assert.equal(describePeers([found])[0].device_id, found.device_id, '界面需要识别并排除本机广播');
    assert.equal(DISCOVERY_PORT, 47823);
  } finally {
    announcer.stop();
  }
});

const announcement = (device_id = 'peer') => ({ v: 1, kind: 'agentlink' as const, device_id,
  name: 'test', os: 'test', hostname: 'test', port: 7443, host: 'example.invalid',
  fingerprint: 'AA:BB', pairing_open: true, version: 'test' });

test('发现按设备身份排除本机并保留其他电脑', async () => {
  const own = startAnnouncer(() => announcement('self'), { target: '127.0.0.1', port: 47992, intervalMs: 30 });
  const peer = startAnnouncer(() => announcement('other'), { target: '127.0.0.1', port: 47992, intervalMs: 30 });
  try {
    const peers = await browse({ port: 47992, bindAddress: '127.0.0.1', timeoutMs: 200, ownDeviceId: 'self' });
    assert.deepEqual(peers.map(peer => peer.device_id), ['other']);
  } finally { own.stop(); peer.stop(); }
});

test('无效等待时间与绑定错误不会伪装成未发现设备', async () => {
  await assert.rejects(browse({ timeoutMs: NaN }), /等待时间/);
  await assert.rejects(browse({ timeoutMs: -1 }), /等待时间/);
  await assert.rejects(browse({ port: 47993, bindAddress: '192.0.2.254', timeoutMs: 300 }), /局域网发现不可用.*UDP 47993/);
});

test('广播每轮重读网卡，换网后不需要重启', async context => {
  let calls = 0;
  const original = os.networkInterfaces;
  context.mock.method(os, 'networkInterfaces', () => { calls++; return original(); });
  const announcer = startAnnouncer(() => announcement(), { port: 47994, intervalMs: 25 });
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(calls >= 2, '只在启动时读取网卡');
  } finally { announcer.stop(); }
});

test('网卡地址匹配的本机广播不会出现在列表', async context => {
  context.mock.method(os, 'networkInterfaces', () => ({ test: [{ address: '127.0.0.1', family: 'IPv4', internal: false,
    netmask: '255.0.0.0', mac: '00:00:00:00:00:00', cidr: '127.0.0.1/8' }] }));
  const announcer = startAnnouncer(() => announcement(), { target: '127.0.0.1', port: 47995, intervalMs: 25 });
  try {
    assert.deepEqual(await browse({ port: 47995, bindAddress: '127.0.0.1', timeoutMs: 150 }), []);
  } finally { announcer.stop(); }
});
