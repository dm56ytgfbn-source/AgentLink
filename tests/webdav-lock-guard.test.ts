import test from 'node:test';
import assert from 'node:assert/strict';
import {lockStoreStatus} from '../apps/runtime/webdav.js';

test('lock enforcement is verified instead of assumed',()=>{
  assert.equal(lockStoreStatus({resources:{}}).ok,true,'an empty cache is expected: resources are created lazily');
  assert.equal(lockStoreStatus({resources:{'/a':{locks:{getLocks(){}}}}}).ok,true);
  const missing=lockStoreStatus({resources:{'/a':{}}});
  assert.equal(missing.ok,false,'a resource without a lock store must be detected');
  assert.match(missing.reason ?? '',/lock store/);
  const noMap=lockStoreStatus({});
  assert.equal(noMap.ok,false,'a library that no longer exposes resources must be detected');
  assert.match(noMap.reason ?? '',/resource map/);
  assert.equal(lockStoreStatus(null).ok,false);
  assert.equal(lockStoreStatus(undefined).ok,false);
});
