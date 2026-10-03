import {readFile,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
const app=path.resolve(process.argv[2]??'');
const resources=path.join(app,'Contents/Resources'), root=path.join(resources,'runtime');
const manifest=JSON.parse(await readFile(path.join(root,'release-manifest.json'),'utf8'));
for(const [name,hash] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(await readFile(path.join(root,name))).digest('hex'),hash,'package hash mismatch: '+name);
const home=await mkdtemp(path.join(os.tmpdir(),'agentlink-release-check-'));
await mkdir(path.join(home,'config'));const registry=path.join(home,'config/runtime.local.json');
await writeFile(registry,JSON.stringify({devices:[]}));
const env={...process.env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',AGENTLINK_HOME:home,AGENTLINK_CONFIG:registry};
for(const key of ['AGENTLINK_RUNTIME_ROOT','AGENTLINK_NODE','AGENTLINK_UI_TOKEN','AGENTLINK_BRIDGE_CONFIG'])delete env[key];
const node=path.join(root,'bin/node'),cli=path.join(root,'dist/apps/runtime/cli.js');
const run=(file,args)=>execFileSync(file,args,{cwd:home,env,encoding:'utf8',timeout:30000});
assert.match(run(path.join(resources,'AgentLink Settings.app/Contents/MacOS/AgentLinkSettings'),['--selftest']),/SELFTEST OK/);
assert.match(run(path.join(root,'build/AgentLink Input Preview.app/Contents/MacOS/AgentLinkInput'),['--test-input-state']),/PASS/);
assert.match(run(node,[cli,'help']),/node setup/);
const setup=JSON.parse(run(node,[cli,'node','setup','--dir',path.join(home,'node'),'--share',path.join(home,'share')]));
assert.ok(setup.config && existsSync(setup.config));
const child=spawn(node,[cli,'ui','--no-open','--json'],{cwd:home,env,stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',v=>{stderr+=v});
try {
 const url=await new Promise((resolve,reject)=>{
  let text='';const timeout=setTimeout(()=>reject(Error('UI startup timeout: '+stderr)),15000);
  child.once('error',e=>{clearTimeout(timeout);reject(e)});
  child.once('exit',()=>{clearTimeout(timeout);reject(Error('UI exited before readiness: '+stderr))});
  child.stdout.on('data',v=>{text+=v;if(text.includes('\n')){clearTimeout(timeout);try{resolve(new URL(JSON.parse(text.split('\n')[0]).url))}catch(e){reject(e)}}});
 });
 const token=url.hash.slice(1);url.hash='';assert.equal(token.length,64);
 assert.equal((await fetch(new URL('/api/status',url))).status,403);
 const headers={'x-agentlink-session':token,'content-type':'application/json'};
 const status=await fetch(new URL('/api/status',url),{headers});assert.equal(status.status,200);await status.json();
 const layout=await fetch(new URL('/api/layout',url),{method:'POST',headers,body:JSON.stringify({device:'release-check',position:'left'})});assert.equal(layout.status,200);
 assert.equal((await fetch(new URL('/api/layout',url),{method:'POST',headers:{...headers,origin:'https://unrelated.example'},body:'{}'})).status,403);
 console.log(JSON.stringify({ok:true,version:manifest.version,checks:['manifest','bundle-relative-settings','native-input-state','bundled-node-without-PATH-node','fresh-node-setup','settings-session-and-origin','settings-layout-write'],fixtures:home},null,2));
} finally {
 if(child.exitCode===null && child.signalCode===null){
  const exited=once(child,'exit');child.kill('SIGTERM');await exited;
 }
}
