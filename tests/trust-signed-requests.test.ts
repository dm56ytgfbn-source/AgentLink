import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {createNode, type Config} from '../apps/node/server.js';
import {call, type Device} from '../apps/runtime/client.js';
import {ReplayGuard, SIGNATURE_HEADERS, canonicalRequest, generateDeviceKeyPair, signRequest, verifySignedRequest} from '../packages/trust/index.js';

test('the server entry point rejects untrusted, unsigned and replayed requests',()=>{
 const keys=generateDeviceKeyPair();
 const other=generateDeviceKeyPair();
 const trusted={ 'client-1': keys.public_key };
 const body='{"id":"1"}';
 const ticket=()=>{
  const timestamp=Date.now(), nonce='n-'+Math.random().toString(16).slice(2);
  const canonical=canonicalRequest({method:'POST',path:'/rpc',timestamp,nonce,body});
  return { timestamp, nonce, headers:{
   [SIGNATURE_HEADERS.device]:'client-1',
   [SIGNATURE_HEADERS.timestamp]:String(timestamp),
   [SIGNATURE_HEADERS.nonce]:nonce,
   [SIGNATURE_HEADERS.signature]:signRequest(keys.private_key,canonical),
  }};
 };
 const valid=ticket();
 assert.deepEqual(verifySignedRequest({method:'POST',path:'/rpc',body,headers:valid.headers,trusted,guard:new ReplayGuard()}),{ok:true,device_id:'client-1'});

 const guard=new ReplayGuard();
 assert.equal(verifySignedRequest({method:'POST',path:'/rpc',body,headers:valid.headers,trusted,guard}).ok,true);
 assert.deepEqual(verifySignedRequest({method:'POST',path:'/rpc',body,headers:valid.headers,trusted,guard}),{ok:false,reason:'replayed-nonce'});

 const impostor=ticket();
 const forged={...impostor.headers,[SIGNATURE_HEADERS.signature]:signRequest(other.private_key,canonicalRequest({method:'POST',path:'/rpc',timestamp:impostor.timestamp,nonce:impostor.nonce,body}))};
 assert.deepEqual(verifySignedRequest({method:'POST',path:'/rpc',body,headers:forged,trusted,guard:new ReplayGuard()}),{ok:false,reason:'bad-signature'});
 assert.deepEqual(verifySignedRequest({method:'POST',path:'/rpc',body,headers:{authorization:'Bearer x'},trusted,guard:new ReplayGuard()}),{ok:false,reason:'missing-signature-headers'});
 const unknown=ticket();
 assert.deepEqual(verifySignedRequest({method:'POST',path:'/rpc',body,headers:{...unknown.headers,[SIGNATURE_HEADERS.device]:'nobody'},trusted,guard:new ReplayGuard()}),{ok:false,reason:'untrusted-device'});
 assert.deepEqual(verifySignedRequest({method:'POST',path:'/rpc',body:body+' ',headers:valid.headers,trusted,guard:new ReplayGuard()}),{ok:false,reason:'bad-signature'},'a changed body must not verify');
});

async function fixture(options:{trusted:boolean}) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-sign-'));
 const root=path.join(dir,'share'); await mkdir(root);
 const cert=path.join(dir,'cert.pem'), key=path.join(dir,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
 const clientKeys=generateDeviceKeyPair();
 const config:Config={device_id:'windows-node',name:'Fixture',host:'127.0.0.1',port:0,token:'t'.repeat(64),cert,key,
   allowed_roots:[root],mode:'developer',capabilities:['filesystem'],audit:path.join(dir,'audit.jsonl'),kill_switch:path.join(dir,'STOP'),
   ...(options.trusted ? {trusted_clients:[{device_id:'mac-client',public_key:clientKeys.public_key}]} : {})};
 const {server}=await createNode(config);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const device:Device={name:'Fixture',device_id:'windows-node',token:config.token,ca:cert,
   url:'https://127.0.0.1:'+(server.address() as {port:number}).port};
 return { dir, root, config, server, device, clientKeys };
}

test('a node that knows the peer key refuses unsigned calls but still serves signed ones',async t=>{
 const f=await fixture({trusted:true});
 t.after(()=>{f.server.closeAllConnections();return new Promise<void>(resolve=>f.server.close(()=>resolve()));});
 const signed:Device={...f.device, signing:{device_id:'mac-client',public_key:f.clientKeys.public_key,key_pem:f.clientKeys.private_key}};
 // /info stays a token-only read-only probe.
 assert.equal((await call(signed) as {name:string}).name,'Fixture');
 // A real operation must be signed.
 const target=path.join(f.root,'signed.txt');
 await call(signed,'files.write',{path:target,data:'hello',encoding:'utf8'});
 assert.equal((await call(signed,'files.read',{path:target}) as {data:string}).data,Buffer.from('hello').toString('base64'));

 await assert.rejects(call(f.device,'files.stat',{path:target}),/signature rejected: missing-signature-headers|UNAUTHORIZED/);
 const impostorKeys=generateDeviceKeyPair();
 await assert.rejects(call({...f.device, signing:{device_id:'mac-client',public_key:impostorKeys.public_key,key_pem:impostorKeys.private_key}},'files.stat',{path:target}),/bad-signature/);
 await assert.rejects(call({...f.device, signing:{device_id:'someone-else',public_key:f.clientKeys.public_key,key_pem:f.clientKeys.private_key}},'files.stat',{path:target}),/untrusted-device/);
});

test('a node without trusted clients keeps working exactly as before',async t=>{
 const f=await fixture({trusted:false});
 t.after(()=>{f.server.closeAllConnections();return new Promise<void>(resolve=>f.server.close(()=>resolve()));});
 const target=path.join(f.root,'legacy.txt');
 await call(f.device,'files.write',{path:target,data:'legacy',encoding:'utf8'});
 assert.equal((await call(f.device,'files.read',{path:target}) as {data:string}).data,Buffer.from('legacy').toString('base64'));
 // Signing material alone must not break an older node either.
 const signed:Device={...f.device, signing:{device_id:'mac-client',public_key:f.clientKeys.public_key,key_pem:f.clientKeys.private_key}};
 assert.equal((await call(signed,'files.read',{path:target}) as {data:string}).data,Buffer.from('legacy').toString('base64'));
});
