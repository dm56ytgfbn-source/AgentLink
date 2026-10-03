import {z} from 'zod';
import {JsonChannel,secretEqual} from '../../packages/input-share/channel.js';
import {VERSION,nativeMessageSchema,commandSchema,displaysSchema,layoutSchema,type Layout,type NativeMessage,type Side} from '../../packages/input-share/protocol.js';
import {defaultLayout,layoutFor,type MacPosition} from '../../packages/input-share/layout.js';
import {InputSharingEngine,type FocusEvent} from '../../packages/input-share/engine.js';
import type {HelperPort} from './helper.js';
const hello=z.object({t:z.literal('hello'),version:z.literal(VERSION),device_id:z.string().min(1).max(200),token:z.string().min(16).max(4096)}).strict();
const ping=z.object({t:z.literal('ping'),at:z.number().finite()}).strict();
const pong=z.object({t:z.literal('pong'),at:z.number().finite()}).strict();
const welcome=z.object({t:z.literal('welcome'),version:z.literal(VERSION),device_id:z.string()}).strict();
// Which screen sits where is a property of the person using the pair, not of the machine
// being used, so the client sends it: the Mac decides, the Windows host applies it. Changing it
// mid-session restarts the session instead of mutating a running engine's geometry.
const layoutMessage=z.object({t:z.literal('layout'),mac_position:z.enum(['left','right','top','bottom'])}).strict();
const focus=z.object({version:z.literal(1),type:z.literal('input-focus'),epoch:z.number().int(),source:z.enum(['windows','mac']).nullable(),target:z.enum(['windows','mac']).nullable(),reason:z.string(),timestamp:z.number()}).strict();
export interface SessionOptions {device_id:string;token:string;helper:()=>HelperPort;layout?:Layout;macPosition?:MacPosition;
 /** Polled so a position changed in another window takes effect without restarting the session. */
 currentPosition?:()=>Promise<MacPosition|undefined>|MacPosition|undefined;disabled?:()=>boolean;onFocus?:(event:FocusEvent)=>void;onRtt?:(ms:number)=>void;}
export function hostSession(channel:JsonChannel,options:SessionOptions){
 let helper:HelperPort|undefined,engine:InputSharingEngine|undefined,authenticated=false,closed=false;
 let windows:z.infer<typeof displaysSchema>|undefined,mac:z.infer<typeof displaysSchema>|undefined;
 let last=Date.now(),deadline=last+10000,pendingPing:number|null=null,activeLayout=options.layout,activePosition=options.macPosition;
 const finish=(reason:string)=>{if(closed)return;closed=true;clearInterval(timer);engine?.reset(reason,true);helper?.stop();channel.close(reason);};
 const maybeStart=()=>{if(engine||!windows||!mac)return;try{const screens={windows,mac};engine=new InputSharingEngine(screens,activeLayout??(activePosition?layoutFor(screens,activePosition):defaultLayout(screens)),(side,c)=>{if(side==='windows')helper?.send(c);else channel.send({t:'command',c});});
   engine.on('focus',(event:FocusEvent)=>{channel.send({t:'focus',event});options.onFocus?.(event);});engine.start();
  }catch{finish('invalid-display-layout');}};
 const native=(side:Side,m:NativeMessage)=>{
  if(m.t==='ready'){if(!m.permissions){finish('native-permission-required');return;}if(side==='windows')windows=m.displays;else mac=m.displays;maybeStart();}
  else if(m.t==='panic')finish(m.reason);
  else if(m.t==='ack')engine?.ack(side,m.epoch);
  else if(m.t==='event')engine?.input(side,m.epoch,m.e);
 };
 channel.on('message',(m:unknown)=>{
  if(closed)return;
  if(!authenticated){const h=hello.safeParse(m);if(!h.success||h.data.device_id!==options.device_id||!secretEqual(h.data.token,options.token)||options.disabled?.()){finish('authentication-denied');return;}
   authenticated=true;last=Date.now();channel.send({t:'welcome',version:VERSION,device_id:options.device_id});
   try{helper=options.helper();}catch{finish('native-helper-start-failed');return;}helper.on('message',m=>native('windows',m));helper.on('closed',finish);return;
  }
  const l=layoutMessage.safeParse(m);
  if(l.success){activePosition=l.data.mac_position;activeLayout=undefined;
   if(engine&&windows&&mac){try{engine.setLayout(layoutFor({windows,mac},activePosition));}catch{finish('invalid-display-layout');}}
   return;}
  const p=pong.safeParse(m);if(p.success){if(p.data.at!==pendingPing){finish('unexpected-pong');return;}options.onRtt?.(Date.now()-p.data.at);pendingPing=null;last=Date.now();return;}
  const n=nativeMessageSchema.safeParse(m);if(!n.success){finish('invalid-peer-message');return;}native('mac',n.data);
 });
 const timer=setInterval(()=>{
  if(options.disabled?.()){finish('kill-switch');return;}
  if(!engine&&Date.now()>deadline){finish('startup-timeout');return;}
  if(Date.now()-last>1500){finish('heartbeat-timeout');return;}
  if(authenticated){helper?.send({t:'ping'});if(pendingPing===null){pendingPing=Date.now();channel.send({t:'ping',at:pendingPing});}engine?.tick();}
 },250);
 channel.on('closed',finish);return {stop:()=>finish('stopped'),get activated(){return authenticated;}};
}
export function clientSession(channel:JsonChannel,options:SessionOptions){
 let helper:HelperPort|undefined,welcomed=false,closed=false,last=Date.now(),lastPosition=options.macPosition,ticks=0;
 const finish=(reason:string)=>{if(closed)return;closed=true;clearInterval(timer);helper?.stop();channel.close(reason);};
 channel.on('message',(m:unknown)=>{
  if(closed)return;
  if(!welcomed){const w=welcome.safeParse(m);if(!w.success||w.data.device_id!==options.device_id){finish('server-identity-mismatch');return;}
   welcomed=true;last=Date.now();helper=options.helper();helper.on('message',m=>channel.send(m));helper.on('closed',finish);
  if(options.macPosition)channel.send({t:'layout',mac_position:options.macPosition});return;
  }
  const p=ping.safeParse(m);if(p.success){last=Date.now();helper?.send({t:'ping'});channel.send({t:'pong',at:p.data.at});return;}
  const c=z.object({t:z.literal('command'),c:commandSchema}).strict().safeParse(m);if(c.success){helper?.send(c.data.c);return;}
  const f=z.object({t:z.literal('focus'),event:focus}).strict().safeParse(m);if(f.success){options.onFocus?.(f.data.event);return;}
  finish('invalid-server-message');
 });
 const timer=setInterval(()=>{
  if(Date.now()-last>1500){finish('heartbeat-timeout');return;}
  if(!welcomed||!options.currentPosition)return;
  // Every two seconds is enough for a setting a human just changed, and cheap enough to ignore.
  if(++ticks%8!==0)return;
  Promise.resolve(options.currentPosition()).then(position=>{
   if(!position||position===lastPosition)return;
   lastPosition=position;channel.send({t:'layout',mac_position:position});
  }).catch(()=>{});
 },250);
 channel.on('closed',finish);
 channel.send({t:'hello',version:VERSION,device_id:options.device_id,token:options.token});return {stop:()=>finish('stopped')};
}
