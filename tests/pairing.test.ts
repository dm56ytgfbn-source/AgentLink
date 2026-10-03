import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, stat, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {describeBundle, exportPairing, importPairing, validateBundle} from '../apps/runtime/pairing.js';
import {resolvePaths} from '../packages/config/index.js';
import {ComputerContext} from '../apps/runtime/context.js';
import {resolveToken} from '../apps/runtime/client.js';

async function fixture(){
  const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-pairing-'));
  const cert=path.join(dir,'cert.pem'), key=path.join(dir,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=paired.test','-addext','subjectAltName=DNS:paired.test'],{stdio:'ignore'});
  const source=resolvePaths({home:path.join(dir,'source-home'),sourceRoot:path.join(dir,'release')});
  await mkdir(source.configDir,{recursive:true});
  await writeFile(source.registry,JSON.stringify({devices:[{name:'RTX-PC',device_id:'device-1',token:'a'.repeat(64),ca:cert,url:'https://192.0.2.1:7443',tls_server_name:'paired.test'}]}),{mode:0o600});
  return { dir, cert, source, target: resolvePaths({home:path.join(dir,'target-home'),sourceRoot:path.join(dir,'release2')}) };
}

test('a pairing bundle installs on a computer with a different home directory',async t=>{
  const f=await fixture();
  t.after(() => rm(f.dir,{recursive:true,force:true}));
  const bundle=await exportPairing(f.source.registry);
  assert.equal(bundle.version,1);
  assert.equal(bundle.devices[0].token,'a'.repeat(64));
  assert.ok(bundle.devices[0].cert_pem.includes('BEGIN CERTIFICATE'),'the certificate travels with the bundle');
  const summary=await describeBundle(bundle);
  assert.equal(summary[0].certificate,new X509Certificate(await readFile(f.cert,'utf8')).fingerprint256);
  assert.ok(bundle.warning.length>0,'the bundle must warn that it contains a credential');

  const result=await importPairing(bundle,{paths:f.target});
  assert.equal(result.file,f.target.registry);
  assert.deepEqual(result.devices,['RTX-PC']);
  const saved=JSON.parse(await readFile(f.target.registry,'utf8')).devices[0];
  assert.ok(saved.ca.startsWith(f.target.certDir),'the certificate must be written under THIS machine home, not the exporter');
  assert.equal(saved.ca.includes('source-home'),false);
  assert.equal(existsSync(saved.ca),true);
  if(process.platform!=='win32') assert.equal((await stat(saved.ca)).mode & 0o777,0o600);
  assert.equal(await resolveToken(saved),'a'.repeat(64),'the imported credential still authenticates');
  const devices=await new ComputerContext(f.target.registry,'test').devices();
  assert.equal(devices.length,1);
  assert.equal(devices[0].name,'RTX-PC');
});

test('importing over an existing pairing is refused unless asked, and then keeps a backup',async t=>{
  const f=await fixture();
  t.after(() => rm(f.dir,{recursive:true,force:true}));
  const bundle=await exportPairing(f.source.registry);
  await importPairing(bundle,{paths:f.target});
  const first=await readFile(f.target.registry,'utf8');
  await assert.rejects(importPairing(bundle,{paths:f.target}),/已经配对过/);
  assert.equal(await readFile(f.target.registry,'utf8'),first,'a refused import must change nothing');
  const second=await importPairing(bundle,{paths:f.target,replace:true});
  assert.deepEqual(second.replaced,['RTX-PC']);
  assert.ok(second.backup&&existsSync(second.backup),'replacing must preserve the previous configuration');
  assert.equal(await readFile(second.backup,'utf8'),first);
  assert.equal(JSON.parse(await readFile(f.target.registry,'utf8')).devices.length,1,'replacing must not duplicate the computer');
});

test('two different computers with the same hostname remain separately paired', async t => {
  const f=await fixture();
  t.after(() => rm(f.dir,{recursive:true,force:true}));
  const first=await exportPairing(f.source.registry);
  await importPairing(first,{paths:f.target});
  const second={...first,devices:[{...first.devices[0],device_id:'device-2',url:'https://192.0.2.2:7443'}]};
  const result=await importPairing(second,{paths:f.target,replace:true});
  assert.deepEqual(result.replaced,[]);
  assert.deepEqual(result.devices,['RTX-PC (device-2)']);
  const devices=await new ComputerContext(f.target.registry,'test').devices();
  assert.equal(devices.length,2);
  assert.deepEqual(devices.map(device=>device.device_id),['device-1','device-2']);
  assert.deepEqual(devices.map(device=>device.name),['RTX-PC','RTX-PC (device-2)']);
});

test('a malformed bundle is rejected with a reason a person can act on',async()=>{
  const good=(await exportPairing((await fixture()).source.registry)).devices[0];
  const cases:[unknown,RegExp][]=[
    [null,/不是一个对象/],
    [{version:2,devices:[good]},/版本不受支持/],
    [{version:1,devices:[]},/没有任何电脑/],
    [{version:1,devices:[{...good,url:'http://192.0.2.1:7443'}]},/纯 HTTPS/],
    [{version:1,devices:[{...good,url:'https://user:pw@192.0.2.1:7443/'}]},/纯 HTTPS/],
    [{version:1,devices:[{...good,token:'short'}]},/令牌缺失或过短/],
    [{version:1,devices:[{...good,cert_pem:'nope'}]},/缺少配对证书/],
    [{version:1,devices:[{...good,cert_pem:'-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----'}]},/无法解析/],
    [{version:1,devices:[{...good,name:''}]},/缺少电脑名称/],
  ];
  for(const [value,pattern] of cases){
    assert.throws(()=>validateBundle(value),pattern);
    await assert.rejects(describeBundle(value),pattern);
  }
});

test('a credential kept in the keychain is not silently exported',async t=>{
  const f=await fixture();
  t.after(() => rm(f.dir,{recursive:true,force:true}));
  await writeFile(f.source.registry,JSON.stringify({devices:[{name:'RTX-PC',device_id:'device-1',token_ref:'device-1',ca:f.cert,url:'https://192.0.2.1:7443'}]}),{mode:0o600});
  await assert.rejects(exportPairing(f.source.registry),/钥匙串/);
});
