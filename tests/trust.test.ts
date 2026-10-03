import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayGuard, bodyDigest, canonicalRequest, generateDeviceKeyPair, newNonce, publicKeyFingerprint, signRequest, verifyRequest} from '../packages/trust/index.js';

test('a signed request verifies only with the matching key, and covers the body',()=>{
 const keys=generateDeviceKeyPair();
 const canonical=canonicalRequest({method:'POST',path:'/rpc',timestamp:1000,nonce:'n1',body:'{"a":1}'});
 const signature=signRequest(keys.private_key,canonical);
 assert.equal(verifyRequest(keys.public_key,canonical,signature),true);
 // A different body, path, timestamp or nonce must not verify.
 for(const changed of [
   canonicalRequest({method:'POST',path:'/rpc',timestamp:1000,nonce:'n1',body:'{"a":2}'}),
   canonicalRequest({method:'POST',path:'/info',timestamp:1000,nonce:'n1',body:'{"a":1}'}),
   canonicalRequest({method:'POST',path:'/rpc',timestamp:1001,nonce:'n1',body:'{"a":1}'}),
   canonicalRequest({method:'POST',path:'/rpc',timestamp:1000,nonce:'n2',body:'{"a":1}'}),
   canonicalRequest({method:'GET',path:'/rpc',timestamp:1000,nonce:'n1',body:'{"a":1}'}),
 ]) assert.equal(verifyRequest(keys.public_key,changed,signature),false);
 const other=generateDeviceKeyPair();
 assert.equal(verifyRequest(other.public_key,canonical,signature),false,'another device key must not verify');
 assert.equal(verifyRequest('not-a-key',canonical,signature),false,'garbage must fail closed instead of throwing');
 assert.equal(verifyRequest(keys.public_key,canonical,'not-base64'),false);
 assert.equal(bodyDigest(undefined),bodyDigest(Buffer.alloc(0)),'an empty body hashes consistently');
 assert.notEqual(publicKeyFingerprint(keys.public_key),publicKeyFingerprint(other.public_key));
});

test('the replay window rejects stale, future and repeated requests',()=>{
 let now=1_000_000;
 const guard=new ReplayGuard({windowMs:60_000,limit:3,now:()=>now});
 assert.deepEqual(guard.accept('a',now),{ok:true});
 assert.deepEqual(guard.accept('a',now),{ok:false,reason:'replayed-nonce'});
 assert.deepEqual(guard.accept('b',now-60_001),{ok:false,reason:'stale-timestamp'});
 assert.deepEqual(guard.accept('c',now+60_001),{ok:false,reason:'future-timestamp'});
 assert.deepEqual(guard.accept('d',now+1000),{ok:true});
 assert.deepEqual(guard.accept('e',now+1000),{ok:true});
 assert.ok(guard.size<=3,'the table must stay bounded');
 // After the window passes, entries age out and the table shrinks instead of growing forever.
 now+=120_000;
 for(let index=0;index<10;index++) guard.accept('x'+index,now);
 assert.ok(guard.size<=10);
 assert.deepEqual(guard.accept('nan',Number.NaN),{ok:false,reason:'stale-timestamp'});
 assert.equal(newNonce().length,32);
 assert.notEqual(newNonce(),newNonce());
});
