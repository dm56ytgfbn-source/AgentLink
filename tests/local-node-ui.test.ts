import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { setupNode } from '../apps/node/setup.js';
import { LocalNodeControl } from '../apps/runtime/local-node.js';
import { startUi } from '../apps/runtime/ui.js';

function post(port: number, route: string, value: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: '127.0.0.1', port, path: route, method: 'POST',
      rejectUnauthorized: false, headers: { 'content-type': 'application/json' } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(value));
  });
}

test('Mac one-app receiver starts explicitly, approves locally, and closes its listener',
  { skip: process.platform !== 'darwin' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-local-ui-'));
  const nodeDir = path.join(dir, 'node');
  const shareRoot = path.join(dir, 'share');
  const port = 20000 + Math.floor(Math.random() * 10000);
  const setup = await setupNode({ directory: nodeDir, shareRoot, port });
  const config = JSON.parse(await readFile(setup.config, 'utf8')) as Record<string, unknown>;
  config.host = '0.0.0.0';
  await writeFile(setup.config, JSON.stringify(config, null, 2) + '\n');
  const control = new LocalNodeControl(nodeDir, shareRoot);
  t.after(async () => { await control.stop(); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await control.status()).running, false);
  assert.equal((await control.start()).running, true);
  assert.equal((await control.start()).port, port);
  const duplicate = new LocalNodeControl(nodeDir, shareRoot);
  await assert.rejects(duplicate.start(), /EADDRINUSE/);
  assert.equal((await duplicate.status()).running, false);
  const request = await post(port, '/pair/request', { device_id: 'test-client', name: 'Second Mac' });
  assert.equal(request.status, 200);
  const pendingId = String(request.body.pending_id);
  assert.equal((await control.pending())[0].pending_id, pendingId);
  assert.equal((await post(port, '/pair/complete', { pending_id: pendingId })).status, 202);
  await control.approve(pendingId);
  assert.equal((await control.pending()).length, 0);
  assert.equal((await post(port, '/pair/complete', { pending_id: pendingId })).status, 200);
  await control.stop();
  assert.equal((await control.status()).running, false);
  await assert.rejects(post(port, '/pair/request', { device_id: 'another', name: 'Third Mac' }));
});

test('settings API starts the Mac receiver only for its authenticated local window',
  { skip: process.platform !== 'darwin' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-node-ui-api-'));
  const nodeDir = path.join(dir, 'node');
  const shareRoot = path.join(dir, 'share');
  const nodePort = 30000 + Math.floor(Math.random() * 10000);
  await setupNode({ directory: nodeDir, shareRoot, port: nodePort });
  const token = 'b'.repeat(64);
  const ui = await startUi({ open: false, sessionToken: token, nodeDirectory: nodeDir, nodeShareRoot: shareRoot });
  t.after(async () => { ui.close(); await rm(dir, { recursive: true, force: true }); });
  const base = ui.url.split('/#')[0];
  const denied = await fetch(base + '/api/local-node/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
  const headers = { 'x-agentlink-session': token, 'content-type': 'application/json' };
  const before = await fetch(base + '/api/local-node', { headers });
  assert.equal((await before.json() as {running:boolean}).running, false);
  const started = await fetch(base + '/api/local-node/start', { method: 'POST', headers, body: '{}' });
  assert.equal(started.status, 200);
  assert.equal((await started.json() as {running:boolean;port:number}).port, nodePort);
  const stopped = await fetch(base + '/api/local-node/stop', { method: 'POST', headers, body: '{}' });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json() as {running:boolean}).running, false);
});
