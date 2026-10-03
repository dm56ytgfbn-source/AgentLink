import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Duplex} from 'node:stream';
import tls from 'node:tls';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {InputSharingEngine} from '../packages/input-share/engine.js';
import {crossing,clamp,defaultLayout,validateLayout,type Screens} from '../packages/input-share/layout.js';
import {layoutSchema,type Command,type Input,type NativeMessage} from '../packages/input-share/protocol.js';
import {translateKey} from '../packages/input-share/keys.js';
import {JsonChannel,secretEqual} from '../packages/input-share/channel.js';
import {MotionBatcher,type HelperPort} from '../apps/input-share/helper.js';
import {hostSession,clientSession} from '../apps/input-share/session.js';
import {InputDiagnostics} from '../apps/input-share/diagnostics.js';
import {waitForInspection} from '../apps/input-share/native-process.js';
const screens:Screens={windows:[{id:'w',x:0,y:0,width:1920,height:1080}],mac:[{id:'m',x:-1440,y:-200,width:1440,height:900}]};
const move=(x=1919,y=400,dx=3,dy=0,held=0):Input=>({kind:'move',x,y,dx,dy,held});
test('native inspection waits for a complete result independently of short-lived process tracking',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-inspection-retained-'));
 const file=path.join(dir,'result.json');await writeFile(file,'');
 const expected={t:'ready',permissions:false,displays:[]};
 const writer=(async()=>{await new Promise(r=>setTimeout(r,25));await writeFile(file,'{"t":');await new Promise(r=>setTimeout(r,25));await writeFile(file,JSON.stringify(expected));})();
 assert.deepEqual(await waitForInspection(file,1000),expected);await writer;
 await writeFile(path.join(dir,'incomplete.json'),'{');
 await assert.rejects(waitForInspection(path.join(dir,'incomplete.json'),25),/timed out/);
});
test('bounded input diagnostics distinguish missing movement, edge direction and held inputs without logging contents',()=>{
 const reports:unknown[]=[];const d=new InputDiagnostics(v=>reports.push(v));
 d.message({t:'ready',permissions:true,displays:screens.mac});
 d.command({t:'mode',epoch:9,mode:'local'});d.message({t:'ack',epoch:9});
 d.message({t:'event',epoch:9,e:move(-1440,300,-3,0,1)});
 d.message({t:'event',epoch:9,e:move(-100,300,0,0,0)});
 d.message({t:'event',epoch:9,e:{kind:'key',code:55,down:true}});
 d.flush();assert.deepEqual(reports.at(-1),{type:'input-diagnostics',epoch:9,mode:'local',ackEpoch:9,moves:2,leftEdge:1,leftOutward:1,leftHeld:1,nonzeroDelta:1,keyEvents:1,buttonEvents:0});
 const count=reports.length;d.flush();assert.equal(reports.length,count);
 assert.ok(!JSON.stringify(reports).includes('55'));assert.ok(!JSON.stringify(reports).includes('-1440'));
});
function fixture(){let now=1000;const sent:{side:string;c:Command}[]=[];const e=new InputSharingEngine(screens,defaultLayout(screens),(side,c)=>sent.push({side,c}),()=>now);e.start();now+=400;return {e,sent,advance:(n=400)=>now+=n};}
function enter(f:ReturnType<typeof fixture>){f.e.input('windows',f.e.epoch,move());const epoch=f.e.epoch;f.e.ack('mac',epoch);f.e.ack('windows',epoch);return epoch;}
test('switch waits for receiver and source ACK; keyboard target follows pointer',()=>{
 const f=fixture();f.e.input('windows',f.e.epoch,move());assert.equal(f.e.target,null);assert.equal(f.sent.at(-1)?.side,'mac');
 assert.equal(f.sent.at(-1)?.c.t,'mode');const n=f.e.epoch;f.e.ack('windows',n);assert.equal(f.e.target,null);
 f.e.ack('mac',n);assert.equal(f.sent.at(-1)?.side,'windows');assert.equal(f.e.target,null);f.e.ack('windows',n);assert.equal(f.e.target,'mac');
 f.e.input('windows',n,{kind:'key',code:30,down:true});assert.deepEqual(f.sent.at(-1),{side:'mac',c:{t:'input',epoch:n,e:{kind:'key',code:0,down:true}}});
});
test('same physical Windows mouse returns from Mac edge; local receiver is released',()=>{
 const f=fixture();enter(f);f.advance();f.e.input('windows',f.e.epoch,move(960,540,-12,0));assert.equal(f.sent.at(-1)?.side,'windows');
 const n=f.e.epoch;f.e.ack('windows',n);assert.equal(f.e.target,'windows');assert.equal(f.sent.at(-1)?.side,'mac');
 assert.deepEqual(f.sent.at(-1)?.c,{t:'mode',mode:'local',epoch:n});
});
test('physical Mac input can cross to Windows and keys translate in reverse',()=>{
 const f=fixture();f.e.input('mac',f.e.epoch,move(-1440,300,-2,0));f.e.ack('windows',f.e.epoch);f.e.ack('mac',f.e.epoch);
 assert.equal(f.e.source,'mac');assert.equal(f.e.target,'windows');f.e.input('mac',f.e.epoch,{kind:'key',code:55,down:true});
 assert.deepEqual(f.sent.at(-1)?.c,{t:'input',epoch:f.e.epoch,e:{kind:'key',code:347,down:true}});
});
test('stale input and ACK cannot re-enable remote control after reset',()=>{
 const f=fixture();const n=enter(f);f.e.reset('disconnect',true);const count=f.sent.length;
 f.e.ack('windows',n);f.e.input('windows',n,move());f.e.input('windows',f.e.epoch,move());assert.equal(f.sent.length,count);assert.equal(f.e.target,null);
});
test('lost ACK restores both local devices; portal re-arms after a bounded cooldown instead of dying',()=>{
 const f=fixture();f.e.input('windows',f.e.epoch,move());f.advance(701);f.e.tick();assert.equal(f.e.target,null);
 assert.deepEqual(f.sent.slice(-2).map(v=>v.c),[{t:'mode',mode:'local',epoch:f.e.epoch},{t:'mode',mode:'local',epoch:f.e.epoch}]);
 assert.equal(f.e.isPaused,true);
 // Inside the cooldown nothing may transfer, even with a fresh edge push.
 const count=f.sent.length;f.e.input('windows',f.e.epoch,move());assert.equal(f.sent.length,count);
 // After the cooldown the portal works again without restarting either entry point.
 f.advance(1200);f.e.tick();assert.equal(f.e.isPaused,false);
 f.advance(400);f.e.input('windows',f.e.epoch,move());assert.equal(f.sent.at(-1)?.side,'mac');
});
test('held inputs still block switching, and a phantom held flag from the peer is bounded',()=>{
 const f=fixture();
 f.e.input('windows',f.e.epoch,move(1919,400,3,0,1));assert.equal(f.e.epoch,1);
 f.advance(400);f.e.input('windows',f.e.epoch,move(1919,400,3,0,3));assert.equal(f.e.epoch,1);
 f.e.input('windows',f.e.epoch,move(1919,400,3,0,0));f.advance(400);
 f.e.input('windows',f.e.epoch,move(1919,400,3,0,0));assert.equal(f.sent.at(-1)?.side,'mac');
});
test('held keys/buttons and cooldown prevent accidental or mid-drag transfers',()=>{
 const f=fixture();f.e.input('windows',f.e.epoch,move(1919,400,3,0,1));assert.equal(f.e.epoch,1);
 f.e.input('windows',1,{kind:'button',button:0,down:true});f.e.input('windows',1,move());assert.equal(f.e.epoch,1);
 f.e.input('windows',1,{kind:'button',button:0,down:false});enter(f);f.e.input('windows',f.e.epoch,move(960,540,-20));assert.equal(f.e.target,'mac');
});
test('physical activity on receiving computer returns control to local devices',()=>{
 const f=fixture();enter(f);f.e.input('mac',f.e.epoch,move(0,0,1,0));assert.equal(f.e.target,null);assert.equal(f.sent.at(-1)?.c.t,'mode');
});
test('multi-monitor internal joins never trigger a cross-device switch',()=>{
 const multi:Screens={...screens,windows:[...screens.windows,{id:'w2',x:1920,y:0,width:2560,height:1440}]};
 assert.equal(crossing(defaultLayout(screens),multi,'windows',{x:1919,y:400},3,0),null);
 const layout=defaultLayout(multi);assert.equal(layout.links[0].from.display,'w2');assert.equal(crossing(layout,multi,'windows',{x:4479,y:400},3,0)?.side,'mac');
});
test('partial monitor adjacency leaves exposed edge available; negative coordinates and DPI map by edge fraction',()=>{
 const multi:Screens={...screens,windows:[...screens.windows,{id:'w2',x:1920,y:600,width:1000,height:480}]};
 const layout=defaultLayout(screens);assert.equal(crossing(layout,multi,'windows',{x:1919,y:700},3,0),null);
 const p=crossing(layout,multi,'windows',{x:1919,y:0},3,0)!;assert.deepEqual(p.point,{x:-1437,y:-200});
 const bottom=crossing(layout,screens,'windows',{x:1919,y:1079},3,0)!;assert.equal(bottom.point.y,699);
});
test('multiple explicit portals support vertical placement; invalid and ambiguous topology rejected',()=>{
 const l=layoutSchema.parse({links:[{from:{device:'windows',display:'w',edge:'top'},to:{device:'mac',display:'m',edge:'bottom'}}]});
 validateLayout(l,screens);assert.equal(crossing(l,screens,'windows',{x:960,y:0},0,-5)?.side,'mac');
 assert.throws(()=>validateLayout({...l,links:[...l.links,...l.links]},screens),/Ambiguous/);
 assert.throws(()=>validateLayout({...l,links:[{...l.links[0],to:{device:'mac',display:'gone',edge:'bottom'}}]},screens),/missing/);
 assert.equal(layoutSchema.safeParse({links:[],speed:Infinity}).success,false);
});
test('pointer clamps to actual monitor union, not empty bounding-box gaps',()=>{
 assert.deepEqual(clamp([{id:'1',x:-100,y:0,width:100,height:100},{id:'2',x:100,y:100,width:100,height:100}],{x:40,y:20}),{x:-1,y:20});
});
test('motion batching preserves total movement and key/button ordering',()=>{
 const out:Input[]=[];const batch=new MotionBatcher(e=>out.push(e));batch.push(move(10,10,2,3));batch.push(move(11,12,4,5));batch.push({kind:'button',button:0,down:true});
 assert.deepEqual(out,[move(11,12,6,8),{kind:'button',button:0,down:true}]);batch.push(move());batch.discard();batch.flush();assert.equal(out.length,2);
});
test('key positions are reversible for extended navigation and modifiers; unsupported keys are dropped',()=>{
 for(const code of [1,30,29,285,56,312,347,348,331,333,336,328,284,87,88]){const mac=translateKey('windows',code);assert.notEqual(mac,undefined);assert.equal(translateKey('mac',mac!),code);}
 assert.equal(translateKey('windows',511),undefined);assert.equal(secretEqual('a','a'),true);assert.equal(secretEqual('a','b'),false);
});
function pair(){let a:Duplex,b:Duplex;a=new Duplex({read(){},write(c,e,cb){b.push(c);cb();}});b=new Duplex({read(){},write(c,e,cb){a.push(c);cb();}});return [a,b] as const;}
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean){for(let i=0;i<100;i++){if(fn())return;await pause(10);}assert.fail('Timed out waiting for condition');}
test('transport rejects replayed sequences and unbounded frames',async()=>{
 const [a,b]=pair();const c=new JsonChannel(a);let reason='';c.on('closed',r=>reason=r);b.write('{"seq":1,"body":{"t":"ping"}}\n');b.write('{"seq":1,"body":{"t":"ping"}}\n');await until(()=>!!reason);assert.equal(reason,'invalid-frame');b.destroy();
 const [d,e]=pair();const f=new JsonChannel(d);f.on('closed',r=>reason=r);reason='';e.write('x'.repeat(17000));await until(()=>!!reason);assert.equal(reason,'frame-limit');e.destroy();
});
class FakeHelper extends EventEmitter implements HelperPort {
 commands:Command[]=[];stopped=false;epoch=0;
 constructor(side:'windows'|'mac'){super();queueMicrotask(()=>this.emit('message',{t:'ready',permissions:true,displays:screens[side]} satisfies NativeMessage));}
 send(c:Command){this.commands.push(c);if(c.t==='mode'){this.epoch=c.epoch;queueMicrotask(()=>this.emit('message',{t:'ack',epoch:c.epoch}));}}
 input(e:Input){this.emit('message',{t:'event',epoch:this.epoch,e});}
 stop(){this.stopped=true;}
}
test('authentication rejects unpaired tokens before any native helper is started',async()=>{
 const [a,b]=pair();const host=new JsonChannel(a),peer=new JsonChannel(b);let started=false,reason='';
 hostSession(host,{device_id:'fixture',token:'fixture-long-token',helper:()=>{started=true;return new FakeHelper('windows');}});host.on('closed',r=>reason=r);
 peer.send({t:'hello',version:1,device_id:'fixture',token:'unpaired-long-token'});await until(()=>!!reason);assert.equal(reason,'authentication-denied');assert.equal(started,false);peer.close('done');
});
test('Windows screen position overrides the Mac preference and changes during sharing',async()=>{
 const [a,b]=pair();let w:FakeHelper|undefined,m:FakeHelper|undefined;
 let windowsPosition:'left'|'right'='left';
 const host=hostSession(new JsonChannel(a),{device_id:'fixture',token:'fixture-long-token',
  macPosition:windowsPosition,currentPosition:()=>windowsPosition,helper:()=>w=new FakeHelper('windows')});
 const client=clientSession(new JsonChannel(b),{device_id:'fixture',token:'fixture-long-token',
  macPosition:'right',helper:()=>m=new FakeHelper('mac')});
 try{
  await until(()=>!!w&&!!m);await pause(400);
  w!.input(move(0,400,-4,0));
  await until(()=>m!.commands.some(command=>command.t==='mode'&&command.mode==='receive'));
  windowsPosition='right';
  await pause(2200);
  const before=m!.commands.filter(command=>command.t==='mode'&&command.mode==='receive').length;
  await pause(400);w!.input(move(1919,400,4,0));
  await until(()=>m!.commands.filter(command=>command.t==='mode'&&command.mode==='receive').length>before);
 }finally{host.stop();client.stop();}
});
test('actual TLS sessions route input both directions, survive idle heartbeats, and stop helpers on disconnect',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-input-retained-'));
 const cert=path.join(dir,'cert.pem'),key=path.join(dir,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-addext','extendedKeyUsage=serverAuth'],{stdio:'ignore'});
 let w:FakeHelper|undefined,m:FakeHelper|undefined,rtt=0;const focus:{source:unknown;target:unknown}[]=[];
 const server=tls.createServer({key:await readFile(key),cert:await readFile(cert),minVersion:'TLSv1.3'},socket=>{
  hostSession(new JsonChannel(socket),{device_id:'fixture',token:'fixture-long-token',helper:()=>w=new FakeHelper('windows'),onRtt:()=>rtt++,onFocus:e=>focus.push(e)});
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const socket=tls.connect({host:'127.0.0.1',port:(server.address() as {port:number}).port,servername:'localhost',ca:await readFile(cert),minVersion:'TLSv1.3'});
 try{
  await new Promise<void>((r,j)=>{socket.once('secureConnect',r);socket.once('error',j);});assert.equal(socket.authorized,true);socket.setNoDelay(true);
  const client=clientSession(new JsonChannel(socket),{device_id:'fixture',token:'fixture-long-token',helper:()=>m=new FakeHelper('mac')});
  await until(()=>!!w&&!!m&&focus.length>0);await pause(400);w!.input(move());await until(()=>focus.at(-1)?.target==='mac');
  w!.input({kind:'key',code:30,down:true});await until(()=>m!.commands.some(c=>c.t==='input'&&c.e.kind==='key'&&c.e.code===0&&c.e.down));
  w!.input({kind:'key',code:30,down:false});await pause(400);w!.input(move(960,540,-20));await until(()=>focus.at(-1)?.target==='windows');
  await pause(1700);assert.ok(rtt>=4);assert.equal(w!.stopped,false);assert.equal(m!.stopped,false);
  // Switch the physical source as well: a Windows mouse returning to Windows alone
  // does not prove that a Mac mouse/keyboard can initiate control of Windows.
  m!.input(move(-1400,300,-2));await until(()=>focus.at(-1)?.source===null);
  await pause(400);m!.input(move(-1440,300,-2));await until(()=>focus.at(-1)?.source==='mac'&&focus.at(-1)?.target==='windows');
  m!.input({kind:'key',code:0,down:true});await until(()=>w!.commands.some(c=>c.t==='input'&&c.e.kind==='key'&&c.e.code===30&&c.e.down));
  m!.input({kind:'key',code:0,down:false});await pause(400);m!.input(move(-1440,300,20));await until(()=>focus.at(-1)?.source==='mac'&&focus.at(-1)?.target==='mac');
  client.stop();await until(()=>w!.stopped&&m!.stopped);
  await writeFile(path.join(dir,'result.json'),JSON.stringify({encrypted:true,roundTripRouting:true,bothPhysicalSources:true,heartbeatSamples:rtt,helpersStopped:true}));
 }finally{socket.destroy();await new Promise<void>(r=>server.close(()=>r()));}
});
test('kill switch terminates active sharing without another network event',async()=>{
 const [a,b]=pair();let disabled=false,w:FakeHelper|undefined,m:FakeHelper|undefined;
 hostSession(new JsonChannel(a),{device_id:'fixture',token:'fixture-long-token',disabled:()=>disabled,helper:()=>w=new FakeHelper('windows')});
 const client=clientSession(new JsonChannel(b),{device_id:'fixture',token:'fixture-long-token',helper:()=>m=new FakeHelper('mac')});
 await until(()=>!!w&&!!m);disabled=true;await until(()=>w!.stopped);client.stop();assert.equal(m!.stopped,true);
});

test('input upgrade reuses paired HTTPS port; authentication, busy rejection and Node shutdown release the session',async()=>{
 const {createServer}=await import('node:https');
 const {attachNodeInput,connectNodeInput}=await import('../apps/input-share/node-transport.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-input-upgrade-retained-'));
 const cert=path.join(dir,'cert.pem'),key=path.join(dir,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
 let w:FakeHelper|undefined,m:FakeHelper|undefined,enabled=false;
 const server=createServer({key:await readFile(key),cert:await readFile(cert)},(_req,res)=>res.end('Existing Node route still available'));
 const stop=attachNodeInput(server,{device_id:'fixture',token:'fixture-long-token',enabled:()=>enabled,helper:()=>w=new FakeHelper('windows')});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const device={name:'fixture',device_id:'fixture',token:'fixture-long-token',url:`https://127.0.0.1:${(server.address() as {port:number}).port}`,ca:cert,tls_server_name:'localhost'};
 try{
  await assert.rejects(connectNodeInput(device),/403/);enabled=true;
  await assert.rejects(connectNodeInput({...device,token:'not-paired'}),/401/);assert.equal(w,undefined);
  const channel=await connectNodeInput(device);clientSession(channel,{...device,helper:()=>m=new FakeHelper('mac')});await until(()=>!!w&&!!m);
  await assert.rejects(connectNodeInput(device),/409/);stop();await until(()=>w!.stopped&&m!.stopped);
 }finally{stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
