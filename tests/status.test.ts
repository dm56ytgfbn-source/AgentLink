import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {collectStatus,findMount,launchAgentLabels,mountPathCandidates,parseMountTable,probeBridge,readSupervisorState,summarize} from '../apps/runtime/status.js';
import {resolvePaths} from '../packages/config/index.js';

const TABLE = [
  'agentlink-bridge on /Volumes/Other (webdav, nodev, noowners)',
  'http://127.0.0.1:7480/ on /Users/someone/AgentLink/RTX-PC (webdav, nodev, noowners, mounted by someone)',
  '/dev/disk3s1 on / (apfs, local, read-only, journaled)',
].join('\n');

test('mount table parsing distinguishes our bridge, other mounts and nothing',()=>{
 assert.equal(parseMountTable(TABLE,'/Users/someone/AgentLink/RTX-PC',7480),'agentlink');
 assert.equal(parseMountTable(TABLE,'/Users/someone/AgentLink/RTX-PC',9999),'other','a different port is not our bridge');
 assert.equal(parseMountTable(TABLE,'/Users/someone/AgentLink/Missing',7480),'unmounted');
 assert.equal(parseMountTable(TABLE,'/Volumes/Other',7480),'other','a webdav mount of another source is not ours');
 assert.equal(parseMountTable('', '/x', 7480),'unmounted');
});

test('a working mount is found even when it lives at a legacy path',()=>{
 const home='/Users/someone/Library/Application Support/AgentLink';
 const paths=resolvePaths({home,sourceRoot:'/tmp/release'});
 const candidates=mountPathCandidates(paths,'RTX-PC',{AGENTLINK_MOUNT:undefined} as NodeJS.ProcessEnv);
 assert.deepEqual(candidates,[path.join(paths.home,'mount','RTX-PC'),path.join(os.homedir(),'AgentLink','RTX-PC')]);
 // The real mount table references the legacy home path, which is the second candidate.
 const legacyTable='http://127.0.0.1:7480/ on '+path.join(os.homedir(),'AgentLink','RTX-PC')+' (webdav, nodev, noexec, nosuid, mounted by someone)';
 assert.deepEqual(findMount(legacyTable,candidates,7480),{path:path.join(os.homedir(),'AgentLink','RTX-PC'),state:'agentlink'});
 assert.deepEqual(findMount(legacyTable,candidates,9999),{path:path.join(os.homedir(),'AgentLink','RTX-PC'),state:'other'});
 assert.deepEqual(findMount('',candidates,7480),{path:candidates[0],state:'unmounted'});
 assert.deepEqual(mountPathCandidates(paths,'RTX-PC',{AGENTLINK_MOUNT:'/Volumes/Custom'} as NodeJS.ProcessEnv)[0],'/Volumes/Custom');
});

test('launch agents are discovered by label instead of one hardcoded name',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-agents-'));
 assert.deepEqual(await launchAgentLabels(dir),[]);
 await writeFile(path.join(dir,'local.agentlink.runtime.rc1.plist'),'<plist/>');
 await writeFile(path.join(dir,'local.agentlink.windows-viewer.plist'),'<plist/>');
 await writeFile(path.join(dir,'com.example.other.plist'),'<plist/>');
 assert.deepEqual(await launchAgentLabels(dir),['local.agentlink.runtime.rc1','local.agentlink.windows-viewer']);
});

test('the bridge probe accepts only a challenge that identifies AgentLink',async()=>{
 const server=http.createServer((request,response)=>{
  if (request.url === '/agent') { response.writeHead(401,{'www-authenticate':'Digest realm="AgentLink"'}); response.end(); return; }
  if (request.url === '/other') { response.writeHead(401,{'www-authenticate':'Digest realm="Somebody"'}); response.end(); return; }
  response.writeHead(200); response.end('ok');
 });
 await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port;
 try{
  assert.equal(await probeBridge(port),false,'a 200 response is not our bridge');
 }finally{ await new Promise<void>(resolve=>server.close(()=>resolve())); }
 assert.equal(await probeBridge(1),false,'a closed port must not report running');
 const agentLink=http.createServer((_request,response)=>{response.writeHead(401,{'www-authenticate':'Digest realm="AgentLink"'});response.end();});
 await new Promise<void>(resolve => agentLink.listen(0,'127.0.0.1',resolve));
 const agentPort=(agentLink.address() as {port:number}).port;
 try{ assert.equal(await probeBridge(agentPort),true); }
 finally{ await new Promise<void>(resolve=>agentLink.close(()=>resolve())); }
});

test('status reports an offline device and an unconfigured bridge without throwing',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'agentlink-status-'));
 const paths=resolvePaths({home,sourceRoot:path.join(home,'release')});
 await mkdir(paths.configDir,{recursive:true});
 await mkdir(paths.stateDir,{recursive:true});
 await writeFile(paths.registry,JSON.stringify({devices:[{name:'RTX-PC',device_id:'device-1',token:'x'.repeat(64),ca:path.join(home,'missing.pem'),url:'https://127.0.0.1:1'}]}),{mode:0o600});
 const status=await collectStatus({paths,probe:async()=>false,mountSource:async()=>TABLE});
 assert.equal(status.registry.count,1);
 assert.equal(status.registry.error,null);
 const device=status.devices[0] as {name:string;online:boolean;error_code?:string};
 assert.equal(device.name,'RTX-PC');
 assert.equal(device.online,false);
 assert.equal(device.error_code,'CONFIG_INVALID','a missing certificate file must be reported as a configuration problem');
 assert.equal(status.bridge.configured,false);
 assert.equal(status.bridge.mount,'unconfigured');
 const text=summarize(status);
 assert.ok(text.includes('RTX-PC'));
 assert.ok(!text.includes('x'.repeat(64)),'the summary must never print a token');
 assert.equal(JSON.stringify(status).includes('x'.repeat(64)),false,'status output must never include credentials');
});

test('status surfaces the supervisor record and the live bridge probe',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'agentlink-status2-'));
 const paths=resolvePaths({home,sourceRoot:path.join(home,'release')});
 await mkdir(paths.configDir,{recursive:true});
 await mkdir(paths.stateDir,{recursive:true});
 await writeFile(paths.registry,JSON.stringify({devices:[]}),{mode:0o600});
 await writeFile(paths.bridge,JSON.stringify({name:'RTX-PC',port:7480,password:'p'.repeat(40),roots:{D:'D:\\\\'}}),{mode:0o600});
 await writeFile(path.join(paths.stateDir,'status.json'),JSON.stringify({at:'2026-09-21T00:00:00.000Z',computer:'RTX-PC',online:true,bridge:true,mount:'agentlink',mount_io:true,ready:true}));
 const supervisor=await readSupervisorState(paths.stateDir);
 assert.equal(supervisor?.ready,true);
 const mountPath=path.join(home,'mount','RTX-PC');
 const status=await collectStatus({paths,probe:async()=>true,mountSource:async()=>'http://127.0.0.1:7480/ on '+mountPath+' (webdav, nodev)'});
 assert.equal(status.bridge.configured,true);
 assert.equal(status.bridge.running,true);
 assert.equal(status.bridge.mount,'agentlink');
 assert.equal(status.bridge.mount_io,true);
 assert.equal(status.supervisor?.error_code,undefined);
 assert.ok(!JSON.stringify(status).includes('p'.repeat(40)),'the bridge password must never appear in status');
});

test('a stopped supervisor is reported as stale instead of ready',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'agentlink-status-stale-'));
 const paths=resolvePaths({home,sourceRoot:path.join(home,'release')});
 await mkdir(paths.configDir,{recursive:true});
 await mkdir(paths.stateDir,{recursive:true});
 await writeFile(paths.registry,JSON.stringify({devices:[]}),{mode:0o600});
 await writeFile(paths.bridge,JSON.stringify({name:'RTX-PC',port:7480,password:'p'.repeat(40),roots:{D:'D:'}}),{mode:0o600});
 const started='2026-09-21T12:00:00.000Z';
 await writeFile(path.join(paths.stateDir,'status.json'),JSON.stringify({at:started,computer:'RTX-PC',online:true,bridge:true,mount:'agentlink',mount_io:true,ready:true}));
 const fresh=await collectStatus({paths,now:()=>new Date(started),probe:async()=>true,mountSource:async()=>''});
 assert.equal(fresh.supervisor_stale,false);
 assert.equal(supervisorOf(fresh).stale,false);
 const stale=await collectStatus({paths,now:()=>new Date(Date.parse(started)+300000),probe:async()=>false,mountSource:async()=>''});
 assert.equal(stale.supervisor_stale,true,'a record that stopped advancing must not be reported as ready');
 assert.equal(supervisorOf(stale).age_seconds,300);
 const text=summarize(stale);
 assert.ok(text.includes('后台监督器: 已停止'));
 assert.ok(text.includes('文件桥未运行')||text.includes('文件桥: 未运行'));
});

function supervisorOf(status:Awaited<ReturnType<typeof collectStatus>>) {
 assert.ok(status.supervisor,'the supervisor record must be preserved for diagnosis');
 return status.supervisor;
}
