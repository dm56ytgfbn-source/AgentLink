import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,chmodSync,openSync,closeSync,writeSync,constants,createReadStream,createWriteStream,readFileSync} from 'node:fs';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type {Readable,Writable} from 'node:stream';
export function macBundle(executable:string){
 const dir=path.dirname(path.resolve(executable));
 if(path.basename(dir)!=='MacOS'||path.basename(path.dirname(dir))!=='Contents')throw Error('macOS input helper must be inside its signed .app bundle');
 const app=path.dirname(path.dirname(dir));if(!app.endsWith('.app'))throw Error('Invalid input app bundle');return app;
}
export interface HelperProcess {child:ChildProcess;input:Writable;output:Readable;dispose:()=>void;}
// LaunchServices gives the explicitly authorized app its own TCC identity instead of inheriting
// the terminal/agent parent's identity. No tccutil, database writes, privilege elevation or prompts.
export type LaunchMode='app'|'direct';
export function launchNative(executable:string,mode:LaunchMode='app'):HelperProcess {
 if(process.platform!=='darwin'||mode==='direct'){
  const child=spawn(executable,[],{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stderr.on('data',()=>{});
  return {child,input:child.stdin,output:child.stdout,dispose:()=>{if(child.exitCode===null)child.kill();}};
 }
 const app=macBundle(executable),dir=mkdtempSync(path.join(os.tmpdir(),'agentlink-input-ipc-'));chmodSync(dir,0o700);
 const inputPath=path.join(dir,'commands'),outputPath=path.join(dir,'events'),errors=path.join(dir,'errors.log');
 execFileSync('/usr/bin/mkfifo',['-m','600',inputPath,outputPath]);
 const inputFd=openSync(inputPath,constants.O_RDWR),outputFd=openSync(outputPath,constants.O_RDWR);
 const errorFd=openSync(errors,'wx',0o600);closeSync(errorFd);
 const input=createWriteStream(inputPath,{fd:inputFd}),output=createReadStream(outputPath,{fd:outputFd});
 const child=spawn('/usr/bin/open',['-n','-g','-W','-a',app,'--stdin',inputPath,'--stdout',outputPath,'--stderr',errors],{stdio:'ignore'});
 let disposed=false;
 const dispose=()=>{if(disposed)return;disposed=true;
  // Wake an outstanding FIFO read before closing it. No input events are ever stored on disk.
  try{writeSync(outputFd,'\n');}catch{}input.destroy();output.destroy();
  // The app independently stops after missing heartbeats; killing `open` cannot kill another app.
  if(child.exitCode===null)child.kill();
 };
 return {child,input,output,dispose};
}
export async function inspectNative(executable:string,mode:LaunchMode='app'):Promise<unknown>{
 if(process.platform!=='darwin'||mode==='direct')return JSON.parse((await promisify(execFile)(executable,['--inspect'],{timeout:5000,maxBuffer:16384})).stdout);
 const app=macBundle(executable),dir=mkdtempSync(path.join(os.tmpdir(),'agentlink-input-inspect-'));chmodSync(dir,0o700);
 const result=path.join(dir,'result.json'),error=path.join(dir,'errors.log');
 for(const file of [result,error])closeSync(openSync(file,'wx',0o600));
 // The tiny inspection process can exit before `open -W` installs its kevent
 // watcher. Wait for its private result instead of tracking that short-lived PID.
 await promisify(execFile)('/usr/bin/open',['-n','-g','-a',app,'--stdout',result,'--stderr',error,'--args','--inspect'],{timeout:7000,maxBuffer:16384});
 return waitForInspection(result);
}
export interface LaunchDecision {mode:LaunchMode;inspection:Record<string,unknown>|null;permissions:boolean;displays:number}
// Granting Accessibility to the app bundle gives the cleanest identity, but it costs a manual
// trip to System Settings. When the bundle has not been granted yet while the context that
// launched this process already holds the permission (a terminal authorised earlier), running
// the helper directly inherits it and works immediately. Bundle first, inheritance second.
export async function resolveLaunchMode(executable:string):Promise<LaunchDecision>{
 const describe=(mode:LaunchMode,value:unknown):LaunchDecision=>{
  const record=(value??{}) as Record<string,unknown>;
  return {mode,inspection:value?record:null,permissions:record.permissions===true,
   displays:Array.isArray(record.displays)?record.displays.length:0};
 };
 if(process.platform!=='darwin')return describe('direct',await inspectNative(executable,'direct').catch(()=>null));
 const viaApp=describe('app',await inspectNative(executable,'app').catch(()=>null));
 if(viaApp.permissions)return viaApp;
 const direct=describe('direct',await inspectNative(executable,'direct').catch(()=>null));
 if(direct.permissions)return direct;
 return viaApp.inspection?viaApp:(direct.inspection?direct:viaApp);
}

export async function waitForInspection(result:string,timeout=7000):Promise<unknown>{
 const deadline=Date.now()+timeout;
 while(true){
  const text=readFileSync(result,'utf8');
  if(Buffer.byteLength(text)>16384)throw Error('Input helper inspection result exceeds limit');
  if(text.trim())try{return JSON.parse(text);}catch{}
  if(Date.now()>=deadline)throw Error('Input helper inspection timed out; no complete result received');
  await new Promise(resolve=>setTimeout(resolve,20));
 }
}
