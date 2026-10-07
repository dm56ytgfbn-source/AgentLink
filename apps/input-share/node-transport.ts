import type {InputPlatform} from '../../packages/input-share/keys.js';
import https from 'node:https';
import type {TLSSocket} from 'node:tls';
import {readFile} from 'node:fs/promises';
import {JsonChannel,secretEqual} from '../../packages/input-share/channel.js';
import type {Layout} from '../../packages/input-share/protocol.js';
import {resolveToken,type Device} from '../runtime/client.js';
import type {HelperPort} from './helper.js';
import {hostSession} from './session.js';
import type {MacPosition} from '../../packages/input-share/layout.js';
export interface NodeInputOptions {platform?:InputPlatform;device_id:string;token:string;enabled:()=>boolean;helper:()=>HelperPort;layout?:Layout;position?:()=>MacPosition|undefined;}
// Optional HTTP Upgrade on the already paired HTTPS port. No additional firewall rule or listener.
export function attachNodeInput(server:https.Server,options:NodeInputOptions){
 let active:JsonChannel|undefined;
 const stop=()=>{active?.close('node-disabled');active=undefined;};
 server.on('upgrade',(req,socket,head)=>{
  const reject=(status:number)=>socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  if(req.method!=='GET'||req.url!=='/input-share'||req.headers.upgrade!=='agentlink-input-v1') {reject(404);return;}
  if(!options.enabled()){reject(403);return;}
  if(!secretEqual(String(req.headers.authorization??''),'Bearer '+options.token)){reject(401);return;}
  if((socket as TLSSocket).getProtocol()!=='TLSv1.3'){reject(426);return;}
  if(active){reject(409);return;}
  const tlsSocket=socket as TLSSocket;tlsSocket.setTimeout(0);tlsSocket.setNoDelay(true);tlsSocket.setKeepAlive(true,1000);
  socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: agentlink-input-v1\r\n\r\n');
  const channel=new JsonChannel(socket);active=channel;
  channel.on('closed',()=>{if(active===channel)active=undefined;});
  hostSession(channel,{platform:options.platform,device_id:options.device_id,token:options.token,helper:options.helper,layout:options.layout,
   macPosition:options.position?.(),currentPosition:options.position,disabled:()=>!options.enabled()});
  if(head.length)socket.unshift(head);
 });
 return stop;
}
export async function connectNodeInput(device:Device):Promise<JsonChannel>{
 const url=new URL('/input-share',device.url);if(url.protocol!=='https:')throw Error('HTTPS required');
 const ca=await readFile(device.ca);
 const token=await resolveToken(device);
 return new Promise((resolve,reject)=>{
  const req=https.request(url,{method:'GET',ca,servername:device.tls_server_name,rejectUnauthorized:true,minVersion:'TLSv1.3',agent:false,
   headers:{Connection:'Upgrade',Upgrade:'agentlink-input-v1',Authorization:'Bearer '+token}});
  const deadline=setTimeout(()=>req.destroy(Error('Input upgrade timed out')),5000);
  req.once('error',e=>{clearTimeout(deadline);reject(e);});
  req.once('response',res=>{clearTimeout(deadline);res.resume();reject(Error(`Node input sharing unavailable (HTTP ${res.statusCode}); check input_share configuration`));});
  req.once('upgrade',(res,socket,head)=>{clearTimeout(deadline);
   if(res.statusCode!==101||res.headers.upgrade!=='agentlink-input-v1'){socket.destroy();reject(Error('Invalid input upgrade'));return;}
   socket.setNoDelay(true);socket.setKeepAlive(true,1000);const channel=new JsonChannel(socket);
   // Caller installs session handlers before any future peer messages are received.
   resolve(channel);if(head.length)queueMicrotask(()=>socket.unshift(head));
  });req.end();
 });
}
