import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createBridge,type Roots} from './webdav.js';
import type {Device} from './client.js';
import {resolvePaths,registryForRead,bridgeForRead} from '../../packages/config/index.js';
// Path-agnostic entry point: registry and bridge settings come from the resolved install
// layout, so the same build runs from a source tree, an installed release or a test fixture.
const paths=resolvePaths();
const registryFile=registryForRead(paths);
const bridgeFile=bridgeForRead(paths);
const readRegistry=async()=>JSON.parse(await readFile(registryFile,'utf8')) as {devices:Device[]};
try {
 const config=await readRegistry();
 let settings:{name:string;remoteRoot?:string;roots?:Record<string,string>;password:string;port:number};
 try{settings=JSON.parse(await readFile(bridgeFile,'utf8'));}
 catch(e){
  if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
  const fallback=process.env.AGENTLINK_DEFAULT_REMOTE_ROOT;
  const device=config.devices[0];
  if(!fallback||!device)throw Error('No file bridge configuration at '+bridgeFile+'. Configure an exported folder for a paired computer first (or set AGENTLINK_DEFAULT_REMOTE_ROOT).');
  settings={name:device.name,remoteRoot:fallback,password:randomBytes(32).toString('hex'),port:7480};
  console.warn('Created bridge configuration at '+bridgeFile+' using default remote root '+fallback+'. Review it before relying on it.');
  await writeFile(bridgeFile,JSON.stringify(settings,null,2),{mode:0o600,flag:'wx'});
 }
 const d=config.devices.find(candidate=>candidate.name===settings.name);if(!d)throw Error('Device not paired: '+settings.name);
 const configured:Roots|undefined = settings.roots && Object.keys(settings.roots).length ? settings.roots : settings.remoteRoot;
 if(!configured)throw Error('Bridge configuration has neither roots nor remoteRoot; refusing to guess an exported folder.');
 const target:Roots = configured;
 const server=await createBridge(d,target,settings.password,settings.port,'windows',async()=>{
  const current=await readRegistry();
  const matches=current.devices.filter(candidate=>candidate.device_id===d.device_id&&candidate.name===d.name);
  if(matches.length!==1)throw Error('Paired device no longer configured');
  return matches[0];
 });
 server.start(()=>console.log('AgentLink 文件桥已启动：127.0.0.1:'+settings.port+' → '+d.name+' '+(typeof target==='string'?'['+target+']':'['+Object.entries(target).map(([k,v])=>k+'='+v).join(', ')+']')));
 for(const sig of ['SIGINT','SIGTERM'] as const)process.on(sig,()=>server.stop(()=>process.exit()));
}catch(e){console.error((e as Error).message);process.exitCode=1;}
