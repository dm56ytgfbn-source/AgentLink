import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {macKeychainStore, type SecretStore} from '../packages/secrets/index.js';
import {applySecretMigration, applyTrustInit, planSecretMigration, planTrustInit, secretStatus, trustStatus} from '../apps/runtime/secrets.js';
import {resolveSigningKey, resolveToken, type Device} from '../apps/runtime/client.js';

function fakeStore(initial: Record<string,string> = {}):SecretStore & { values:Record<string,string> } {
  const values:Record<string,string> = { ...initial };
  return {
    kind: 'fake',
    values,
    async get(account){ return values[account] ?? null; },
    async set(account,value){ values[account] = value; },
    async remove(account){ delete values[account]; },
  };
}

test('a pairing secret resolves from the keychain reference, and fails loudly when it cannot',async()=>{
  const inline:Device = { name:'A', url:'https://x', token:'inline-secret', ca:'/dev/null', device_id:'id-a' };
  assert.equal(await resolveToken(inline), 'inline-secret', 'an inline secret keeps working (no forced migration)');

  const referenced:Device = { name:'B', url:'https://x', token_ref:'id-b', ca:'/dev/null', device_id:'id-b' };
  const store = fakeStore({ 'id-b':'from-keychain' });
  assert.equal(await resolveToken(referenced, store), 'from-keychain');

  await assert.rejects(resolveToken(referenced, null), /keychain, which is not available/);
  await assert.rejects(resolveToken(referenced, fakeStore()), /not found in the system keychain/);
  await assert.rejects(resolveToken({ ...referenced, token_ref:undefined }, store), /no credential/);
});

test('migration moves secrets into the store, keeps a backup, and is verifiable',async t=>{
  const dir = await mkdtemp(path.join(os.tmpdir(),'agentlink-secrets-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const registry = path.join(dir,'runtime.local.json');
  const original = JSON.stringify({ devices: [
    { name:'RTX-PC', device_id:'device-1', token:'a'.repeat(64), ca:'/tmp/x.pem', url:'https://192.0.2.1:7443' },
    { name:'Office-PC', device_id:'device-2', token_ref:'device-2', ca:'/tmp/y.pem', url:'https://192.0.2.2:7443' },
  ] }, null, 2);
  await writeFile(registry, original, { mode:0o600 });
  const store = fakeStore({ 'device-2':'existing' });

  const plan = await planSecretMigration(registry, store);
  assert.equal(plan.changes.length, 1, 'only the device with an inline secret is migrated');
  assert.deepEqual(plan.already_moved, ['Office-PC']);
  assert.equal(plan.file, await (await import('node:fs/promises')).realpath(registry));

  const result = await applySecretMigration(plan, store);
  assert.deepEqual(result.migrated, ['RTX-PC']);
  assert.ok(result.backup && existsSync(result.backup), 'the previous registry must be preserved');
  assert.equal(await readFile(result.backup,'utf8'), original);

  const saved = JSON.parse(await readFile(registry,'utf8'));
  assert.equal(saved.devices[0].token, undefined, 'the secret must no longer be in the file');
  assert.equal(saved.devices[0].token_ref, 'device-1');
  assert.equal(store.values['device-1'], 'a'.repeat(64));
  assert.equal(JSON.stringify(saved).includes('a'.repeat(64)), false, 'no secret may remain anywhere in the file');

  // The migrated registry must still authenticate.
  const restored = await resolveToken(saved.devices[0] as Device, store);
  assert.equal(restored, 'a'.repeat(64));

  const status = await secretStatus(registry, store);
  assert.deepEqual(status.devices.map(entry => entry.storage), ['keychain','keychain']);
  assert.ok(status.devices.every(entry => entry.present));
  const second = await planSecretMigration(registry, store);
  assert.equal(second.nothing_to_do, true, 'migrating twice must be a no-op');
});

test('a store that does not return what it stored aborts the migration',async t=>{
  const dir = await mkdtemp(path.join(os.tmpdir(),'agentlink-secrets-bad-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const registry = path.join(dir,'runtime.local.json');
  const original = JSON.stringify({ devices: [{ name:'PC', device_id:'d1', token:'b'.repeat(32), ca:'/tmp/x.pem', url:'https://192.0.2.1:7443' }] });
  await writeFile(registry, original, { mode:0o600 });
  const lying:SecretStore = { kind:'lying', async get(){ return null; }, async set(){}, async remove(){} };
  const plan = await planSecretMigration(registry, lying);
  await assert.rejects(applySecretMigration(plan, lying), /did not return the value it stored/);
  assert.equal(await readFile(registry,'utf8'), original, 'the registry must be untouched when the store misbehaves');
});

test('macOS keychain integration works end to end', { skip: process.platform !== 'darwin' }, async t=>{
  const dir = await mkdtemp(path.join(os.tmpdir(),'agentlink-keychain-'));
  const keychain = path.join(dir,'test.keychain');
  execFileSync('/usr/bin/security',['create-keychain','-p','test-password',keychain]);
  execFileSync('/usr/bin/security',['unlock-keychain','-p','test-password',keychain]);
  t.after(async () => { await rm(dir,{recursive:true,force:true}); });
  const store = macKeychainStore({ keychain, service:'AgentLinkTest' });
  assert.equal(await store.get('device-1'), null, 'a missing entry must read as absent, not throw');
  await store.set('device-1','s3cret-value');
  assert.equal(await store.get('device-1'), 's3cret-value');
  await store.set('device-1','rotated-value');
  assert.equal(await store.get('device-1'), 'rotated-value', 'updating must replace the value');
  await store.remove('device-1');
  assert.equal(await store.get('device-1'), null);
  assert.ok(existsSync(keychain));
  await mkdir(path.join(dir,'done'));
});

test('signing identity setup keeps the private key in the store and prints the peer configuration',async t=>{
  const dir = await mkdtemp(path.join(os.tmpdir(),'agentlink-trust-init-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const registry = path.join(dir,'runtime.local.json');
  const original = JSON.stringify({ devices:[{ name:'RTX-PC', device_id:'d1', token:'x'.repeat(32), ca:'/tmp/x.pem', url:'https://192.0.2.1:7443' }] }, null, 2);
  await writeFile(registry, original, { mode:0o600 });
  const store = fakeStore();

  const { plan, privateKey } = await planTrustInit(registry, store, {});
  assert.ok(plan.client_id.startsWith('mac-'));
  assert.equal(plan.key_ref, plan.client_id + ':signing');
  assert.deepEqual(plan.devices, ['RTX-PC']);
  assert.equal(plan.fingerprint.length, 32);
  const peer = plan.node_configuration as { trusted_clients: Array<{ device_id:string; public_key:string }> };
  assert.equal(peer.trusted_clients[0].device_id, plan.client_id);
  assert.equal(peer.trusted_clients[0].public_key, plan.public_key);
  assert.equal(await readFile(registry,'utf8'), original, 'planning must not change anything');

  await assert.rejects(applyTrustInit(plan, privateKey, null), /refusing/, 'without a keychain the setup must refuse instead of writing a private key to disk');

  const result = await applyTrustInit(plan, privateKey, store);
  assert.ok(result.backup && existsSync(result.backup));
  assert.equal(result.updated, 1);
  const saved = JSON.parse(await readFile(registry,'utf8'));
  assert.equal(saved.devices[0].signing.device_id, plan.client_id);
  assert.equal(saved.devices[0].signing.key_ref, plan.key_ref);
  assert.equal(JSON.stringify(saved).includes(privateKey), false, 'the private key must never appear in the configuration');
  assert.equal(await resolveSigningKey(saved.devices[0] as Device, store), privateKey, 'requests can sign with the stored key');

  const status = await trustStatus(registry, store);
  assert.deepEqual(status.devices.map(entry => entry.signing), [true]);
  assert.equal(status.devices[0].key_present, true);
  assert.equal(status.devices[0].fingerprint, plan.fingerprint);
});
