import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {TaskStore} from '../apps/node/tasks.js';

const input = (key:string) => ({ key, command:'echo test', cwd:os.tmpdir(), timeout:5000 });

test('repeated log reads reuse the parsed journal and only read new bytes',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-journal-incremental-'));
 let emit:((stream:string,text:string)=>void)|null=null;
 const store=new TaskStore(dir,async (_input,_signal,output)=>{ emit=output; await wait(80); return {exit_code:0,stdout:'',stderr:'',duration:80}; });
 await store.initialize();
 const task=await store.submit(input('incremental'));
 for(let index=0;index<200&&!emit;index++) await wait(10);
 assert.ok(emit,'the runner must start');
 (emit as unknown as (stream:string,text:string)=>void)('stdout','first');
 await wait(30);
 const first=await store.logs(task.id);
 assert.equal(first.events.length,1);
 const cachedBefore=store.stats.cached_reads;
 const second=await store.logs(task.id);
 assert.deepEqual(second.events,first.events);
 assert.ok(store.stats.cached_reads>cachedBefore,'an unchanged journal must be served from cache instead of re-read');
 (emit as unknown as (stream:string,text:string)=>void)('stdout','second');
 await wait(30);
 const third=await store.logs(task.id);
 assert.equal(third.events.length,2,'output written after the first read must appear');
 assert.equal(third.events[1].text,'second');
 assert.ok(store.stats.incremental_reads>0,'appended output must be read incrementally');
 assert.equal(store.stats.full_reads<=2,true,'steady-state polling must not keep re-reading the whole journal');
 // A fresh process must still see the complete journal.
 const reopened=new TaskStore(dir,async()=>{ throw new Error('persisted tasks must never run again'); });
 await reopened.initialize();
 assert.ok((await reopened.get(task.id)).event_count>=3);
 await store.cancel(task.id);
});

test('a journal failure degrades the task service instead of stopping it for good',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-journal-degrade-'));
 let release:(()=>void)|null=null;
 const gate=new Promise<void>(resolve=>{ release=resolve; });
 const store=new TaskStore(dir,async ()=>{ await gate; return {exit_code:0,stdout:'',stderr:'',duration:1}; });
 await store.initialize();
 const task=await store.submit(input('degrade'));
 await rm(dir,{recursive:true,force:true});
 (release as unknown as ()=>void)();
 for(let index=0;index<300&&!store.health.degraded;index++) await wait(10);
 assert.ok(store.health.degraded,'a storage failure must be recorded, not swallowed');
 assert.equal(store.health.closed,false,'one storage error must not close the store permanently');
 await mkdir(dir,{recursive:true});
 const again=await store.submit(input('after-degrade'));
 assert.equal(again.status,'accepted');
 assert.equal(store.health.degraded,null,'a successful journal write clears the degraded state');
 assert.equal(await store.get(again.id).then(value=>value.status.length>0),true);
 assert.ok(task.id.length===64);
});
