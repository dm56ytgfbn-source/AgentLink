import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { broadcastTargets, browse, startAnnouncer, DISCOVERY_PORT } from '../packages/discovery/index.js';

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
    assert.equal(DISCOVERY_PORT, 47823);
  } finally {
    announcer.stop();
  }
});
