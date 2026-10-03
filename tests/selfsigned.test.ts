import assert from 'node:assert/strict';
import test from 'node:test';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, connect as tlsConnect } from 'node:tls';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generateSelfSignedCertificate } from '../apps/node/selfsigned.js';
import { setupNode } from '../apps/node/setup.js';

// The certificate is hand-encoded DER, so these tests exist to prove the bytes are a real
// X.509 certificate rather than something that merely looks like one: node parses it, a TLS
// handshake accepts it, and the exact fingerprint survives the round trip.

const COMMON_NAME = 'agentlink-selfsigned-test.local';

test('自签证书可被 X509Certificate 解析出 CN 与 SAN', () => {
  const generated = generateSelfSignedCertificate({ commonName: COMMON_NAME,
    dnsNames: [COMMON_NAME, 'localhost'], ipAddresses: ['127.0.0.1'], days: 30 });
  const parsed = new X509Certificate(generated.cert);
  assert.match(parsed.subject, new RegExp('CN=' + COMMON_NAME.replace(/\./g, '\\.')));
  assert.equal(parsed.fingerprint256, generated.fingerprint256);
  assert.match(parsed.subjectAltName ?? '', new RegExp('DNS:' + COMMON_NAME.replace(/\./g, '\\.')));
  assert.match(parsed.subjectAltName ?? '', /DNS:localhost/);
  assert.match(parsed.subjectAltName ?? '', /IP Address:127\.0\.0\.1/);
  assert.ok(parsed.validTo.length > 0);
});

test('自签证书能完成 TLS 握手，且指纹与生成时一致', async () => {
  const generated = generateSelfSignedCertificate({ commonName: COMMON_NAME,
    dnsNames: [COMMON_NAME, 'localhost'], ipAddresses: ['127.0.0.1'], days: 30 });
  const server = createServer({ cert: generated.cert, key: generated.key }, socket => socket.end('ok'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const seen = await new Promise<{ authorized: boolean; fingerprint: string; data: string }>((resolve, reject) => {
      const socket = tlsConnect({ host: '127.0.0.1', port, ca: generated.cert, servername: COMMON_NAME }, () => {
        const peer = socket.getPeerCertificate();
        let data = '';
        socket.on('data', chunk => { data += chunk.toString(); });
        socket.on('end', () => resolve({ authorized: socket.authorized, fingerprint: peer.fingerprint256, data }));
        socket.on('error', reject);
      });
      socket.on('error', reject);
    });
    assert.equal(seen.authorized, true);
    assert.equal(seen.fingerprint, generated.fingerprint256);
    assert.equal(seen.data, 'ok');
  } finally {
    server.close();
  }
});

test('没有 openssl 也能准备一台新电脑（Windows 上没有这个二进制）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-selfsigned-'));
  try {
    const setup = await setupNode({ directory: path.join(dir, 'node'), roots: [path.join(dir, 'share')],
      openssl: path.join(dir, 'missing-openssl') });
    const parsed = new X509Certificate(await (await import('node:fs/promises')).readFile(setup.cert, 'utf8'));
    assert.equal(parsed.fingerprint256, setup.fingerprint);
    assert.equal(setup.tls_server_name, 'agentlink-' + setup.device_id + '.local');
    assert.match(parsed.subjectAltName ?? '', new RegExp('DNS:' + setup.tls_server_name.replace(/\./g, '\\.')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('已有证书不会被重新生成（机器身份稳定）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-selfsigned-keep-'));
  try {
    const nodeDir = path.join(dir, 'node');
    const first = await setupNode({ directory: nodeDir, roots: [path.join(dir, 'share')], openssl: path.join(dir, 'none') });
    const second = await setupNode({ directory: nodeDir, roots: [path.join(dir, 'share')], openssl: path.join(dir, 'none') });
    assert.equal(second.device_id, first.device_id);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(second.created, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
