import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ComputerContext} from '../apps/runtime/context.js';
import type {NodeInfo} from '../packages/protocol/index.js';
test('context persistence, session isolation, unavailable node, removed identity and token separation',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-context-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const config=path.join(dir,'runtime.local.json');const devices=[{device_id:'win1',name:'RTX-PC',token:'DO-NOT-COPY-SECRET'},{device_id:'win2',name:'Office-PC'}];
 await writeFile(config,JSON.stringify({devices}));
 const probe=async(d:{device_id:string;name:string}):Promise<NodeInfo>=>({device_id:d.device_id,name:d.name,os:'win32',hostname:'test',architecture:'x64',capabilities:['filesystem']});
 const a=new ComputerContext(config,'agent-a',probe),b=new ComputerContext(config,'agent-b',probe);
 assert.equal((await a.current()).local,true);
 await a.use('RTX-PC','D:\\AgentLinkShare');
 assert.equal((await new ComputerContext(config,'agent-a',probe).current()).computer_id,'win1');
 assert.equal((await b.current()).local,true);
 await b.use('Office-PC');assert.equal((await a.current()).computer_id,'win1');
 await assert.rejects(a.use('typo'));assert.equal((await a.current()).computer_id,'win1');
 const offline=new ComputerContext(config,'agent-a',async()=>{throw Error('offline');});await assert.rejects(offline.use('Office-PC'));assert.equal((await a.current()).computer_id,'win1');
 assert.equal((await offline.list())[1].online,false);
 assert.equal((await a.info()).device_id,'win1');
 for(const f of await readdir(path.join(dir,'.agentlink-context')))assert.ok(!(await readFile(path.join(dir,'.agentlink-context',f),'utf8')).includes('DO-NOT-COPY-SECRET'));
 await writeFile(config,JSON.stringify({devices:[devices[1]]}));await assert.rejects(a.current(),/no longer paired/);
 await a.use('MacBook');assert.equal((await a.current()).local,true);
});
test('untrusted identity cannot become selected context',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-identity-'));t.after(()=>rm(dir,{recursive:true,force:true}));const config=path.join(dir,'runtime.local.json');
 await writeFile(config,JSON.stringify({devices:[{name:'RTX-PC',device_id:'right'}]}));
 const c=new ComputerContext(config,'default',async()=>({device_id:'wrong'} as NodeInfo));await assert.rejects(c.use('RTX-PC'),/identity mismatch/);assert.equal((await c.current()).local,true);
});

test('four mixed-platform peers keep stable identities and independent agent targets', async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-four-peers-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const config=path.join(dir,'runtime.local.json');
 const peers=[
  {device_id:'mac-1',name:'Design-Mac',os:'darwin',default_cwd:'/Users/designer/AgentLinkShare'},
  {device_id:'win-1',name:'Build-PC',os:'win32',default_cwd:'D:\\AgentLinkShare'},
  {device_id:'mac-2',name:'Render-Mac',os:'darwin',default_cwd:'/Users/render/AgentLinkShare'},
  {device_id:'win-2',name:'Test-PC',os:'win32',default_cwd:'C:\\AgentLinkShare'},
 ];
 await writeFile(config,JSON.stringify({devices:peers}));
 const probe=async(d:{device_id:string}):Promise<NodeInfo>=>{
  const peer=peers.find(p=>p.device_id===d.device_id)!;
  return {...peer,hostname:peer.name,architecture:'test',capabilities:['filesystem','shell']};
 };
 const local=async()=>({device_id:'own-mac',name:'My-Mac',hostname:'localhost',os:'darwin',architecture:'arm64',capabilities:['context'],local:true as const});
 const a=new ComputerContext(config,'agent-a',probe,local),b=new ComputerContext(config,'agent-b',probe,local);
 assert.equal((await a.list()).length,5);
 await a.use('Render-Mac');assert.equal((await a.current()).cwd,'/Users/render/AgentLinkShare');
 await b.use('Build-PC');assert.equal((await b.current()).cwd,'D:\\AgentLinkShare');
 await a.use('win-2');assert.equal((await a.current()).computer_id,'win-2');
 assert.equal((await b.current()).computer_id,'win-1');
 await assert.rejects(a.use('Design-Mac','C:\\wrong'),/absolute/);
 await assert.rejects(a.use('Test-PC','/wrong'),/absolute/);
 assert.equal((await a.current()).computer_id,'win-2');
 await a.use('local');assert.equal((await a.current()).computer_id,'own-mac');
 assert.equal((await b.current()).computer_id,'win-1');
});
