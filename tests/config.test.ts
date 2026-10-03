import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolvePaths,registryForRead,registryForWrite,bridgeForRead,contextStateFile,defaultHome} from '../packages/config/index.js';

test('paths derive from AGENTLINK_HOME and never from a user name or repository location',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'agentlink-paths-'));
 const paths=resolvePaths({home,sourceRoot:path.join(home,'release')});
 assert.equal(paths.home,path.resolve(home));
 assert.equal(paths.registry,path.join(home,'config','runtime.local.json'));
 assert.equal(paths.tasksDir,path.join(home,'tasks'));
 assert.equal(paths.certDir,path.join(home,'config','certificates'));
 assert.equal(contextStateFile(paths,'agent-a'),path.join(home,'state','context','agent-a.json'));
 assert.equal(defaultHome({AGENTLINK_HOME:home} as NodeJS.ProcessEnv),path.resolve(home));
 assert.ok(!paths.home.includes(os.userInfo().username)||paths.home.startsWith(os.tmpdir()));
});

test('registry resolution prefers explicit, then env, then installed, then a development tree',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'agentlink-registry-home-'));
 const source=await mkdtemp(path.join(os.tmpdir(),'agentlink-registry-source-'));
 const paths=resolvePaths({home,sourceRoot:source});
 assert.equal(registryForRead(paths),paths.registry);
 assert.equal(registryForWrite(paths),paths.registry);
 await mkdir(paths.configDir,{recursive:true});
 await writeFile(paths.registry,'{"devices":[]}\n',{mode:0o600});
 assert.equal(registryForRead(paths),paths.registry);
 const legacy=path.join(source,'runtime.local.json');
 const other=await mkdtemp(path.join(os.tmpdir(),'agentlink-registry-other-'));
 await mkdir(other,{recursive:true});
 await writeFile(legacy,'{"devices":[]}\n',{mode:0o600});
 const sourceOnly=resolvePaths({home:path.join(other,'missing'),sourceRoot:source});
 assert.equal(registryForRead(sourceOnly),path.resolve(legacy));
 assert.equal(registryForWrite(sourceOnly),sourceOnly.registry);
 assert.equal(registryForRead(paths,'/explicit/runtime.json'),path.resolve('/explicit/runtime.json'));
 assert.equal(registryForRead(paths,undefined,{AGENTLINK_CONFIG:'/from/env.json'} as NodeJS.ProcessEnv),path.resolve('/from/env.json'));
 assert.equal(registryForWrite(paths,undefined,{AGENTLINK_CONFIG:'/from/env.json'} as NodeJS.ProcessEnv),path.resolve('/from/env.json'));
});

test('bridge settings prefer env, then installed, then the development tree',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'agentlink-bridge-home-'));
 const source=await mkdtemp(path.join(os.tmpdir(),'agentlink-bridge-source-'));
 const paths=resolvePaths({home,sourceRoot:source});
 assert.equal(bridgeForRead(paths),paths.bridge);
 await writeFile(path.join(source,'bridge.local.json'),'{}\n',{mode:0o600});
 assert.equal(bridgeForRead(paths),path.join(source,'bridge.local.json'));
 await mkdir(paths.configDir,{recursive:true});
 await writeFile(paths.bridge,'{}\n',{mode:0o600});
 assert.equal(bridgeForRead(paths),paths.bridge);
 assert.equal(bridgeForRead(paths,undefined,{AGENTLINK_BRIDGE_CONFIG:'/env/bridge.json'} as NodeJS.ProcessEnv),path.resolve('/env/bridge.json'));
});
