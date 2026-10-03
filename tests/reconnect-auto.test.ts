import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {addressCandidates, reconnectAuto} from '../apps/runtime/reconnect.js';
import type {Device} from '../apps/runtime/client.js';

const base:Device={ name:'RTX-PC', device_id:'d1', url:'https://192.0.2.10:7443', ca:'/tmp/x.pem', token:'t'.repeat(32),
  url_history:['https://192.0.2.99:7443','https://192.0.2.10:7443'] };

async function fixture(device:Device = base) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-auto-reconnect-'));
  const file=path.join(dir,'runtime.local.json');
  const original=JSON.stringify({devices:[device]},null,2);
  await writeFile(file,original,{mode:0o600});
  return { dir, file, original };
}

test('candidate addresses are ordered so the cheapest checks happen first',()=>{
  const list=addressCandidates(base,{candidates:['https://explicit:7443'],port:8443});
  assert.deepEqual(list,['https://explicit:7443','https://192.0.2.10:7443','https://192.0.2.99:7443','https://192.0.2.10:8443']);
  const broken=addressCandidates({...base,url:'not a url'},{});
  assert.ok(broken.includes('https://192.0.2.99:7443'),'a remembered address still applies when the stored one is unusable');
});

test('auto reconnect saves the first address that proves the paired identity',async t=>{
  const f=await fixture(); t.after(async()=>{ const {rm}=await import('node:fs/promises'); await rm(f.dir,{recursive:true,force:true}); });
  const tried:string[]=[];
  const report=await reconnectAuto(f.file,'RTX-PC',{ probe: async candidate => {
    tried.push(candidate.url);
    if (candidate.url.includes('192.0.2.99')) return {device_id:'d1'};
    const error=Object.assign(new Error('connect ECONNREFUSED'),{code:'ECONNREFUSED'});
    throw error;
  }});
  assert.equal(report.changed,true,'the computer must be found again without the user doing anything');
  assert.equal(report.url,'https://192.0.2.99:7443');
  assert.equal(report.previous_url,'https://192.0.2.10:7443');
  assert.deepEqual(tried,['https://192.0.2.99:7443'],'the address already in use must not be re-probed by this path');
  assert.ok(report.backup&&existsSync(report.backup));
  assert.equal(await readFile(report.backup,'utf8'),f.original,'the previous registry must be preserved');
  const saved=JSON.parse(await readFile(f.file,'utf8')).devices[0];
  assert.equal(saved.url,'https://192.0.2.99:7443');
  assert.equal(saved.url_history[0],'https://192.0.2.99:7443','the working address must be remembered first');
  assert.ok(saved.url_history.includes('https://192.0.2.10:7443'),'the old address stays as a fallback candidate');
  assert.deepEqual(report.attempts,[{url:'https://192.0.2.99:7443',ok:true}],'the successful candidate is recorded, and no dead address was tried first');
});

test('an address that answers with the wrong identity is never saved',async t=>{
  const impostor='https://192.0.2.77:7443';
  const f=await fixture({...base,url_history:[impostor]});
  t.after(async()=>{ const {rm}=await import('node:fs/promises'); await rm(f.dir,{recursive:true,force:true}); });
  const report=await reconnectAuto(f.file,'RTX-PC',{ probe: async () => ({device_id:'someone-else'}) });
  assert.equal(report.changed,false);
  assert.equal(report.reason,'no candidate answered with the paired identity');
  assert.ok(report.attempts.length>=1);
  assert.ok(report.attempts.every(entry=>entry.reason==='identity-mismatch'));
  assert.equal(await readFile(f.file,'utf8'),f.original,'the registry must stay untouched');
});

test('reconnect refuses an ambiguous target and reports when nothing answers',async t=>{
  const f=await fixture();
  t.after(async()=>{ const {rm}=await import('node:fs/promises'); await rm(f.dir,{recursive:true,force:true}); });
  await assert.rejects(reconnectAuto(f.file,'Nope',{probe:async()=>({device_id:'d1'})}),/Unknown or ambiguous/);
  const report=await reconnectAuto(f.file,'RTX-PC',{ probe: async () => { throw Object.assign(new Error('timeout'),{code:'ETIMEDOUT'}); } });
  assert.equal(report.changed,false);
  assert.equal(report.url,base.url);
  assert.ok(report.attempts.every(entry=>entry.reason==='ETIMEDOUT'));
  assert.equal(await readFile(f.file,'utf8'),f.original);
});
