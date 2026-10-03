import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {discover,buildInstallPlan,applyInstallPlan,canonicalReleasePath,parseLaunchAgentPlist,parsePluginLauncher,runtimeRootFromMcpPath,summarizeDiscovery,verifyRelease} from '../apps/runtime/install.js';
import {resolvePaths} from '../packages/config/index.js';

const LAUNCHER_OLD = '#!/bin/zsh\nset -e\nexport AGENTLINK_CONFIG="${AGENTLINK_CONFIG:-/Users/example/Desktop/AgentLink V0/agentlink/runtime.local.json}"\nexport AGENTLINK_SESSION="${AGENTLINK_SESSION:-agentlink-plugin-${PPID}}"\nexec /Users/example/.local/node/bin/node "/Users/example/Desktop/AgentLink V0/agentlink/dist/apps/runtime/mcp.js"\n';

function plist(label:string, args:string[]) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>' + label
    + '</string><key>ProgramArguments</key><array>' + args.map(value => '<string>' + value + '</string>').join('')
    + '</array><key>RunAtLoad</key><true/></dict></plist>\n';
}

async function fixture(){
 const home=await mkdtemp(path.join(os.tmpdir(),'agentlink-converge-'));
 const runtimeRoot=await mkdtemp(path.join(os.tmpdir(),'agentlink-tree-'));
 const paths=resolvePaths({home,sourceRoot:runtimeRoot});
 // a tree that looks like the real product
 for (const item of ['dist','scripts','agents']) await mkdir(path.join(runtimeRoot,item),{recursive:true});
 await mkdir(path.join(runtimeRoot,'dist','apps','runtime'),{recursive:true});
 await writeFile(path.join(runtimeRoot,'dist','apps','runtime','mcp.js'),'// mcp\n');
 await writeFile(path.join(runtimeRoot,'package.json'),JSON.stringify({version:'9.9.9'}));
 await mkdir(paths.configDir,{recursive:true});
 await writeFile(paths.registry,JSON.stringify({devices:[{name:'RTX-PC'}]}),{mode:0o600});
 // an old release plus a stale launch agent and a stale plugin registration
 const oldRelease=path.join(home,'releases','0.1.0-rc.1');
 await mkdir(path.join(oldRelease,'dist','apps','runtime'),{recursive:true});
 await writeFile(path.join(oldRelease,'dist','apps','runtime','mcp.js'),'// old\n');
 const launchAgentsDir=path.join(home,'LaunchAgents');
 const pluginsDir=path.join(home,'plugins');
 await mkdir(launchAgentsDir,{recursive:true});
 await mkdir(path.join(pluginsDir,'agentlink','scripts'),{recursive:true});
 await writeFile(path.join(launchAgentsDir,'local.agentlink.windows-viewer.plist'),
   plist('local.agentlink.windows-viewer',['/usr/bin/open','-a','AgentLink Windows.app']));
 await writeFile(path.join(launchAgentsDir,'local.agentlink.runtime.rc1.plist'),
   plist('local.agentlink.runtime.rc1',['/usr/local/bin/node',path.join(oldRelease,'scripts','mac-supervisor.mjs'),paths.registry,path.join(paths.configDir,'bridge.local.json'),paths.stateDir,path.join(home,'AgentLink','RTX-PC')]));
 await writeFile(path.join(pluginsDir,'agentlink','scripts','launch-agentlink-mcp'),
   LAUNCHER_OLD.replace(/\/Users\/example\/Desktop\/AgentLink V0\/agentlink/g, path.join(home,'releases','0.1.0-rc.1')));
 return {home,runtimeRoot,oldRelease,launchAgentsDir,pluginsDir,paths};
}

test('runtime paths inside launcher scripts are parsed without hardcoding a user name',()=>{
 assert.equal(runtimeRootFromMcpPath('/opt/agentlink/dist/apps/runtime/mcp.js'),'/opt/agentlink');
 const separator=String.fromCharCode(92);
 const parsedWindows=runtimeRootFromMcpPath(['C:','agentlink','dist','apps','runtime','mcp.js'].join(separator));
 assert.equal(parsedWindows,'C:/agentlink');
 assert.equal(parsedWindows?.includes(separator),false,'separators must be normalised');
 assert.equal(runtimeRootFromMcpPath('/opt/agentlink/other.js'),null);
 const parsed=parsePluginLauncher(LAUNCHER_OLD.replaceAll('/Users/example/Desktop/AgentLink V0/agentlink','/opt/agentlink'));
 assert.equal(parsed.runtime_root,'/opt/agentlink');
 assert.equal(parsed.config,'/opt/agentlink/runtime.local.json');
 const agent=parseLaunchAgentPlist(plist('local.agentlink.runtime',['/bin/node','/opt/r/scripts/mac-supervisor.mjs']),'/tmp/x.plist');
 assert.equal(agent.label,'local.agentlink.runtime');
 assert.equal(agent.program,'/bin/node');
 assert.deepEqual(agent.args,['/opt/r/scripts/mac-supervisor.mjs'],'the XML fallback must match plutil semantics');
});

test('discovery finds releases, login agents and registrations, and flags the stale ones',async()=>{
 const f=await fixture();
 const discovery=await discover({paths:f.paths,launchAgentsDir:f.launchAgentsDir,pluginDirs:[f.pluginsDir]});
 assert.equal(discovery.version,'9.9.9');
 assert.equal(discovery.releases.length,1);
 assert.equal(discovery.releases[0].version,'0.1.0-rc.1');
 assert.equal(discovery.launch_agents.length,2);
 const managed=discovery.launch_agents.filter(agent=>agent.managed);
 const unmanaged=discovery.launch_agents.filter(agent=>!agent.managed);
 assert.equal(managed.length,1);
 assert.equal(managed[0].runtime_root,f.oldRelease);
 assert.equal(unmanaged.length,1,'a viewer helper must be discovered but not managed');
 const viewerPlan=buildInstallPlan(discovery,{release:path.join(f.home,'releases','x')});
 assert.equal(viewerPlan.some(action=>action.id.includes('windows-viewer')),false,'a non-supervisor agent must never be rewritten');
 assert.equal(discovery.plugins.length,1);
 assert.equal(discovery.plugins[0].runtime_root,f.oldRelease.replaceAll('\\','/'));
 assert.equal(discovery.registry.devices,1);
 const text=summarizeDiscovery(discovery);
 assert.ok(text.includes('0.1.0-rc.1'));
 const target=canonicalReleasePath(discovery,new Date('2026-09-21T10:20:30Z'));
 assert.ok(target.startsWith(path.join(f.home,'releases','9.9.9-converged-')));
 const plan=buildInstallPlan(discovery,{release:target});
 assert.ok(plan.every(action=>action.will_change),'every action must be pending while everything points at the old release');
});

test('applying the plan copies the runtime, rewrites the agent registration and keeps backups',async()=>{
 const f=await fixture();
 const discovery=await discover({paths:f.paths,launchAgentsDir:f.launchAgentsDir,pluginDirs:[f.pluginsDir]});
 const target=path.join(f.home,'releases','9.9.9-converged-test');
 const plan=buildInstallPlan(discovery,{release:target});
 const result=await applyInstallPlan(discovery,plan,{paths:f.paths,run:false});
 assert.equal(result.skipped.length,0);
 assert.ok(existsSync(path.join(target,'dist','apps','runtime','mcp.js')),'the release must contain the runtime');
 assert.ok(existsSync(path.join(target,'package.json')),'the release must contain package.json');
 assert.ok((await readdir(path.join(target))).includes('scripts'),'the release must contain the supervisor scripts');
 const plistFile=path.join(f.launchAgentsDir,'local.agentlink.runtime.rc1.plist');
 const plistText=await readFile(plistFile,'utf8');
 assert.ok(plistText.includes(path.join(target,'scripts','mac-supervisor.mjs')),'the login agent must point at the canonical release');
 const backups=(await readdir(f.launchAgentsDir)).filter(name=>name.includes('agentlink-backup-'));
 assert.equal(backups.length,1,'the previous login agent definition must be preserved');
 assert.ok((await readFile(path.join(f.launchAgentsDir,backups[0]),'utf8')).includes(f.oldRelease));
 const launcher=path.join(f.pluginsDir,'agentlink','scripts','launch-agentlink-mcp');
 const launcherText=await readFile(launcher,'utf8');
 assert.ok(launcherText.includes(path.join(target,'dist','apps','runtime','mcp.js')));
 assert.ok(launcherText.includes('AGENTLINK_CONFIG:-'+f.paths.registry),'the registration must read the canonical registry, not a file inside a release');
 assert.ok(!launcherText.includes(f.oldRelease),'no reference to the previous copy may remain');
 const launcherBackups=(await readdir(path.dirname(launcher))).filter(name=>name.includes('agentlink-backup-'));
 assert.equal(launcherBackups.length,1);
 // Re-running must be a no-op: the plan is built from the new discovery.
 const after=await discover({paths:f.paths,launchAgentsDir:f.launchAgentsDir,pluginDirs:[f.pluginsDir]});
 const secondPlan=buildInstallPlan(after,{release:target});
 assert.ok(secondPlan.every(action=>!action.will_change),'a converged installation must report nothing to do');
 const secondResult=await applyInstallPlan(after,secondPlan,{paths:f.paths,run:false});
 assert.equal(secondResult.applied.length,0);
 assert.equal(secondResult.skipped.length,3);
});

test('verification runs the release instead of assuming it works',async()=>{
 const f=await fixture();
 const target=path.join(f.home,'releases','verify-me');
 await mkdir(path.join(target,'dist','apps','runtime'),{recursive:true});
 const failed=await verifyRelease(target);
 assert.equal(failed.ok,false);
 // The real CLI reports canonical paths, so a symlinked release must still verify.
 await writeFile(path.join(target,'dist','apps','runtime','cli.js'),
   'import {realpathSync} from "node:fs";console.log(JSON.stringify({source_root:realpathSync(' + JSON.stringify(target) + '),home:' + JSON.stringify(f.home) + '}));\n');
 const ok=await verifyRelease(target);
 assert.equal(ok.ok,true);
 assert.ok((ok.source_root ?? '').endsWith('verify-me'),'verification reports the canonical release path');
 assert.equal(ok.release,await realpath(target));
 const link=path.join(f.home,'releases','linked');
 await symlink(target,link);
 assert.equal((await verifyRelease(link)).ok,true,'a symlinked release path must not fail verification');
 const missing=await verifyRelease(path.join(f.home,'nowhere'));
 assert.equal(missing.ok,false);
});
