import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { request as httpRequest } from 'node:http';
import { PairingService, pairingWindowOpen, type StationInfo } from '../apps/node/pairing.js';
import { startUi } from '../apps/runtime/ui.js';

test('new pairing waits for local owner approval, expires, and cannot replay', async () => {
  let now=1000, saved=0, approved=false, displayed='';
  const p=new PairingService({station:()=>({} as StationInfo),markerFile:'/nonexistent-agentlink-test-marker',clients:[],
    now:()=>now,isApproved:()=>approved,onRequest:(id)=>{displayed=id},onPaired:async()=>{saved++}});
  const request=p.request({device_id:'client',name:'Mac'});assert.ok(request.ok);
  assert.equal(request.pending_id,displayed);
  assert.equal('code' in request,false,'no credential or challenge may be sent to the requester');
  assert.deepEqual(await p.complete(request.pending_id),{ok:false,reason:'awaiting-local-approval'});
  assert.equal(saved,0);
  approved=true;
  assert.equal((await p.complete(request.pending_id)).ok,true);
  assert.equal(saved,1);
  assert.equal((await p.complete(request.pending_id)).ok,false,'approval is one-time');
  approved=false;
  const another=new PairingService({station:()=>({} as StationInfo),markerFile:'/nonexistent-agentlink-test-marker',clients:[],
    now:()=>now,isApproved:()=>approved,onPaired:async()=>{saved++}});
  const expired=another.request({device_id:'another',name:'Mac'});assert.ok(expired.ok);
  now+=120001;approved=true;
  assert.equal((await another.complete(expired.pending_id)).ok,false,'late local approval must not create trust');
  assert.equal(saved,1);
});

test('manual pairing window expires and request flood is bounded without deleting files', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-pairing-hardening-'));
  const marker=path.join(dir,'PAIRING_OPEN');await writeFile(marker,'open');
  const now=Date.now();await utimes(marker,new Date(now-600001),new Date(now-600001));
  assert.equal(pairingWindowOpen(marker,true,now+10000,now),false);
  const p=new PairingService({station:()=>({} as StationInfo),markerFile:marker,clients:[],isApproved:()=>false,
    onPaired:async()=>{assert.fail('must not persist')}});
  for(let i=0;i<5;i++)assert.equal(p.request({device_id:'bad'+i,name:'Bad'}).ok,true);
  assert.equal(p.request({device_id:'extra',name:'Extra'}).ok,false);
});

test('settings API requires session, host, origin and JSON; valid UI writes still work', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'agentlink-ui-hardening-'));
  const previous = { home: process.env.AGENTLINK_HOME, config: process.env.AGENTLINK_CONFIG };
  const config = path.join(home, 'config'); await mkdir(config);
  const registry = path.join(config, 'runtime.local.json'); await writeFile(registry, JSON.stringify({devices:[]}));
  process.env.AGENTLINK_HOME = home; process.env.AGENTLINK_CONFIG = registry;
  t.after(() => { for (const [key, value] of [['AGENTLINK_HOME',previous.home],['AGENTLINK_CONFIG',previous.config]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } });
  const ui = await startUi({port:0,open:false}); t.after(() => ui.close());
  const base = new URL(ui.url); const token = base.hash.slice(1); base.hash = '';
  const body = JSON.stringify({device:'test-device',position:'left'});
  const send = (headers: Record<string,string>, data=body) => fetch(new URL('/api/layout', base), {method:'POST',headers,body:data});
  assert.equal((await send({'content-type':'application/json'})).status,403);
  const headers = {'content-type':'application/json','x-agentlink-session':token};
  assert.equal((await send({...headers,origin:'https://unrelated.example'})).status,403);
  const wrongHost = await new Promise<number>(resolve => { const req = httpRequest(new URL('/api/layout',base), {method:'POST',headers:{...headers,host:'attacker.example'}}, res => { res.resume(); resolve(res.statusCode!); }); req.end(body); });
  assert.equal(wrongHost,403);
  assert.equal((await send({...headers,'content-type':'text/plain'})).status,415);
  assert.equal((await send(headers,'x'.repeat(17000))).status,413);
  assert.equal((await send({...headers,origin:base.origin})).status,200);
  assert.equal(JSON.parse(await readFile(path.join(config,'input-share.local.json'),'utf8'))['test-device'].position,'left');
  assert.equal((await fetch(new URL('/api/status',base))).status,403);
  const page = await (await fetch(base)).text(); assert.equal(page.includes(token),false,'public HTML must not disclose session token');
});
