import {createInterface} from 'node:readline';
import {connectNodeInput} from './node-transport.js';
import {parseArgs} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import net from 'node:net';
import {inspectNative} from './native-process.js';
import {z} from 'zod';
import {ComputerContext} from '../runtime/context.js';
import {call,resolveToken} from '../runtime/client.js';
import {JsonChannel} from '../../packages/input-share/channel.js';
import {layoutSchema,displaySchema} from '../../packages/input-share/protocol.js';
import {NativeHelper} from './helper.js';
import {InputDiagnostics} from './diagnostics.js';
import {hostSession,clientSession} from './session.js';
const {values,positionals}=parseArgs({allowPositionals:true,options:{
 'node-config':{type:'string'},registry:{type:'string'},device:{type:'string'},helper:{type:'string'},layout:{type:'string'},
 port:{type:'string',default:'7444'},standalone:{type:'boolean'},enable:{type:'boolean'},diagnostics:{type:'boolean'},'duration-seconds':{type:'string'},'status-file':{type:'string'},'launch-mode':{type:'string'},'mac-position':{type:'string'},'local-position':{type:'string'},'control-stdin':{type:'boolean'},help:{type:'boolean'}
}});
async function main(){
 const mode=positionals[0];
 if(values.help||!mode){console.log(`AgentLink input sharing (opt-in, interactive desktop only)
 inspect --helper <native executable>
 host --node-config <Windows node config> --helper <exe> --enable [--layout <json>]
 connect --registry <runtime registry> --device <paired name or ID> --helper <native executable> --enable
 Default connect uses the paired Node HTTPS port. --standalone --port 7444 uses a separate host.
 Options: --duration-seconds 60 --status-file <new private file>
 Ctrl+Alt+Escape on either computer immediately stops sharing. Ctrl+C also stops.
 The connecting computer is on the receiving computer's right by default. No autostart, IP changes or firewall changes are made.`);return;}
 if(!values.helper)throw Error('--helper is required');
 if(mode==='inspect'){
  const inspection=await inspectNative(values.helper);
  console.log(JSON.stringify(z.object({t:z.literal('ready'),permissions:z.boolean(),displays:z.array(displaySchema)}).strict().parse(inspection),null,2));return;
 }
 if(!values.enable)throw Error('Global input is opt-in: pass --enable only when ready to share');
 if(mode!=='host'&&mode!=='connect')throw Error('Unknown mode');
 if((mode==='host'&&process.platform!=='win32')||!['win32','darwin'].includes(process.platform))throw Error('Input sharing supports Windows and macOS; standalone host requires Windows');
 const platform=process.platform as 'win32'|'darwin';
 const port=Number(values.port);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
 const duration=values['duration-seconds']===undefined?undefined:Number(values['duration-seconds']);
 if(duration!==undefined&&(!Number.isFinite(duration)||duration<1||duration>86400))throw Error('Invalid bounded duration');
 if(values.diagnostics&&(duration===undefined||duration>600))throw Error('Diagnostics requires a bounded test of at most 600 seconds');
 const layout=values.layout?layoutSchema.parse(JSON.parse(await readFile(values.layout,'utf8'))):undefined;
 let statusPath=values['status-file'];
 if(statusPath)await writeFile(statusPath,JSON.stringify({version:1,type:'input-focus',source:null,target:null,reason:'starting'})+'\n',{flag:'wx',mode:0o600});
 let writes=Promise.resolve();
 const onFocus=(event:unknown)=>{console.log(JSON.stringify(event));if(statusPath)writes=writes.then(()=>writeFile(statusPath,JSON.stringify(event)+'\n',{mode:0o600})).catch(()=>{console.error('Status file write failed; stopping');stop();});};
 let stopping=false;let cleanup=()=>{};let timer:NodeJS.Timeout|undefined;
 let control:ReturnType<typeof createInterface>|undefined;
 const stop=()=>{if(stopping)return;stopping=true;cleanup();if(timer)clearTimeout(timer);control?.close();process.stdin.pause();};
 if(values['control-stdin']){control=createInterface({input:process.stdin});control.on('line',line=>{if(line==='stop')stop();});control.on('close',stop);}
 try{
 process.on('SIGINT',stop);process.on('SIGTERM',stop);
 const helper=()=>{
  // Which identity holds the permission is decided by the caller, which inspected both.
  const native=new NativeHelper(values.helper!,values['launch-mode']==='direct'?'direct':'app');
  if(values.diagnostics){
   const diagnostics=new InputDiagnostics(value=>console.log(JSON.stringify(value)));
   native.on('message',m=>diagnostics.message(m));
   const send=native.send.bind(native);native.send=c=>{diagnostics.command(c);send(c);};
   const report=setInterval(()=>diagnostics.flush(),1000);report.unref();
   const stopNative=native.stop.bind(native);native.stop=()=>{clearInterval(report);diagnostics.flush();stopNative();};
  }
  return native;
 };
 if(mode==='host'){
  if(!values['node-config'])throw Error('--node-config required');
  const config=z.object({device_id:z.string().min(1),token:z.string().min(16),cert:z.string(),key:z.string(),host:z.string(),mode:z.string(),kill_switch:z.string()}).parse(JSON.parse(await readFile(values['node-config'],'utf8')));
  if(config.mode!=='developer'||existsSync(config.kill_switch))throw Error('Node disabled or read-only; sharing denied');
  let active:JsonChannel|undefined;let session:ReturnType<typeof hostSession>|undefined;
  const sockets=new Set<tls.TLSSocket>();
  const server=tls.createServer({cert:await readFile(config.cert),key:await readFile(config.key),minVersion:'TLSv1.3',handshakeTimeout:3000},socket=>{
   if(active||stopping){socket.destroy();return;}
   socket.setNoDelay(true);socket.setKeepAlive(true,1000);active=new JsonChannel(socket);const channel=active;
   session=hostSession(channel,{platform,device_id:config.device_id,token:config.token,helper,layout,disabled:()=>existsSync(config.kill_switch),onFocus});
   channel.on('closed',reason=>{console.log('Input sharing stopped: '+reason);if(active===channel)active=undefined;if(session?.activated)stop();});
  });
  server.maxConnections=4;
  server.on('connection',socket=>{sockets.add(socket as tls.TLSSocket);socket.once('close',()=>sockets.delete(socket as tls.TLSSocket));});
  server.on('tlsClientError',()=>{});
  cleanup=()=>{session?.stop();active?.close('stopped');for(const socket of sockets)socket.destroy();server.close();};
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,config.host,resolve);});
  server.on('error',()=>{console.error('Input listener failed');stop();});
  console.log(`Input sharing ready on port ${port}; waiting for a paired computer. Ctrl+Alt+Escape stops.`);
 }else{
  if(!values.registry||!values.device)throw Error('--registry and --device required');
  const devices=await new ComputerContext(values.registry).devices();const device=devices.find(d=>d.name===values.device||d.device_id===values.device);
  if(!device)throw Error('Unknown paired computer');
  const info=await call(device) as {features?:string[]}; // Existing device identity and trust checks.
  const supportsPlatforms=info.features?.includes('input-sharing-peer-platform-v2')===true;
  if(platform==='win32'&&!supportsPlatforms)throw Error('对方的 AgentLink 版本尚不支持 Windows 发起键鼠共享，请先升级对方的 AgentLink。');
  const token=await resolveToken(device);
  if(stopping)return;
  let channel:JsonChannel;
  if(!values.standalone){channel=await connectNodeInput(device);}
  else {
  const url=new URL(device.url);
  const socket=tls.connect({host:url.hostname,port,servername:device.tls_server_name??(net.isIP(url.hostname)?undefined:url.hostname),ca:await readFile(device.ca),rejectUnauthorized:true,minVersion:'TLSv1.3'});
  socket.setNoDelay(true);socket.setKeepAlive(true,1000);
  cleanup=()=>socket.destroy();
  await new Promise<void>((resolve,reject)=>{const deadline=setTimeout(()=>{socket.destroy();reject(Error('Input connection timed out'));},5000);socket.once('secureConnect',()=>{clearTimeout(deadline);resolve();});socket.once('error',e=>{clearTimeout(deadline);reject(e);});});
  channel=new JsonChannel(socket);
  }
  if(stopping){channel.close('stopped');return;}
  cleanup=()=>channel.close('stopped');
  // The connecting computer owns the screen arrangement and sends it, so the same pair can be re-arranged
  // without touching the other computer's files.
  // Read again on a timer: the settings window writes the same file, so a position changed
  // there reaches the far side without this session being restarted.
  const preferenceFile=path.join(path.dirname(String(values.registry)),'input-share.local.json');
  const storedPosition=async()=>{
   try{
    const preferences=JSON.parse(await readFile(preferenceFile,'utf8')) as Record<string,{position?:string}>;
    const position=(preferences[device.device_id]??preferences[device.name])?.position;
    return ['left','right','top','bottom'].includes(String(position))?position as 'left'|'right'|'top'|'bottom':undefined;
   }catch{return undefined}
  };
  const requestedPosition=values['local-position']??values['mac-position']??await storedPosition()??'right';
  const session=clientSession(channel,{platform,protocolVersion:supportsPlatforms?2:1,device_id:device.device_id,token,helper,layout,onFocus,
   macPosition:['left','right','top','bottom'].includes(String(requestedPosition))?requestedPosition as 'left'|'right'|'top'|'bottom':undefined,
   currentPosition:storedPosition});
  channel.on('closed',reason=>{console.log('Input sharing stopped: '+reason);
  if(['disconnected','authentication-denied','invalid-peer-message','invalid-server-message'].includes(reason))
   console.log('请检查两端 AgentLink 版本及对方服务状态；共享已停止，本机键鼠已恢复。');
  stop();});cleanup=()=>session.stop();
 }
 if(duration!==undefined&&!stopping)timer=setTimeout(stop,duration*1000);
 }catch(error){stop();throw error;}
}
main().catch((e:Error)=>{console.error(e.message);process.exitCode=1;});
