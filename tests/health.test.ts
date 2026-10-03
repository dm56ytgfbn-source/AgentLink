import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDevice, connectionFailure } from '../apps/runtime/health.js';
import type { Device } from '../apps/runtime/client.js';
import { requestDeadline } from '../apps/runtime/client.js';
import type { NodeInfo } from '../packages/protocol/index.js';

const device: Device = { name: 'RTX-PC', device_id: 'paired-id', url: 'https://example.invalid', token: 'SECRET_TOKEN', ca: '/private/secret.pem' };
const info: NodeInfo = { name: 'remote-name', device_id: 'paired-id', hostname: 'windows', os: 'win32', architecture: 'x64', capabilities: ['shell', 'filesystem'] };
const error = (code: string) => Object.assign(new Error('SECRET_TOKEN /private/secret.pem'), { code });

test('transport deadlines bound file/status requests without cutting short valid shell execution', () => {
  assert.equal(requestDeadline(), 5000);
  assert.equal(requestDeadline('files.read_chunk'), 20000);
  assert.equal(requestDeadline('tasks.submit'), 20000);
  assert.equal(requestDeadline('shell.run', { timeout: 300000 }), 310000);
  assert.equal(requestDeadline('shell.run'), 40000);
});

test('health retries transient reads and reports successful recovery without leaking config', async () => {
  let count = 0;
  const delays: number[] = [];
  const result = await inspectDevice(device, { attempts: 3, probe: async () => {
    if (++count < 3) throw error('ECONNREFUSED');
    return info;
  }, wait: async ms => { delays.push(ms); } });
  assert.equal(result.online, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.name, device.name);
  assert.deepEqual(delays, [250, 500]);
  assert.equal(JSON.stringify(result).includes('SECRET_TOKEN'), false);
  assert.equal(JSON.stringify(result).includes('secret.pem'), false);
});

test('health bounds retry attempts and reports a useful failure', async () => {
  let count = 0;
  const result = await inspectDevice(device, { attempts: 100, probe: async () => {
    count++; throw error('ETIMEDOUT');
  }, wait: async () => {} });
  assert.equal(count, 3);
  assert.ok('error_code' in result);
  assert.equal(result.error_code, 'NETWORK_UNREACHABLE');
  assert.equal(result.online, false);
  assert.equal(result.error, 'NODE_OFFLINE_OR_UNTRUSTED');
});

test('authentication, TLS and configuration failures never retry', async () => {
  for (const code of ['UNAUTHORIZED', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ENOENT', 'FORBIDDEN']) {
    let count = 0;
    const result = await inspectDevice(device, { attempts: 3, probe: async () => {
      count++; throw error(code);
    }, wait: async () => { assert.fail('must not retry'); } });
    assert.equal(count, 1);
    assert.ok('retryable' in result);
    assert.equal(result.retryable, false);
    assert.equal(JSON.stringify(result).includes('SECRET_TOKEN'), false);
  }
});

test('untrusted and malformed responses never become ready or retry', async () => {
  for (const response of [{ ...info, device_id: 'other' }, { ...info, capabilities: 'shell' }, null]) {
    const result = await inspectDevice(device, { attempts: 3, probe: async () => response as NodeInfo,
      wait: async () => { assert.fail('must not retry'); } });
    assert.equal(result.online, false);
    assert.equal(result.attempts, 1);
  }
});

test('diagnostics distinguish network, identity and service failures without raw errors', () => {
  assert.equal(connectionFailure(error('ECONNREFUSED')).error_code, 'CONNECTION_REFUSED');
  assert.equal(connectionFailure(error('ECONNRESET')).error_code, 'CONNECTION_INTERRUPTED');
  assert.equal(connectionFailure(error('ENOTFOUND')).error_code, 'NAME_UNRESOLVED');
  assert.equal(connectionFailure(error('EHOSTDOWN')).error_code, 'NETWORK_UNREACHABLE');
  assert.equal(connectionFailure(error('ENETDOWN')).retryable, true);
  assert.equal(connectionFailure(Error('Device identity mismatch')).error_code, 'IDENTITY_MISMATCH');
  assert.equal(connectionFailure(Error('TIMEOUT')).retryable, true);
  assert.equal(connectionFailure(Error('SECRET_TOKEN')).error_code, 'CHECK_FAILED');
});

test('default listing performs one probe and never waits to retry', async () => {
  const result = await inspectDevice(device, { probe: async () => { throw error('ECONNRESET'); },
    wait: async () => { assert.fail('must not retry'); } });
  assert.equal(result.attempts, 1);
});
