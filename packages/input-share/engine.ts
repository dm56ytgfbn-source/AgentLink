import { EventEmitter } from 'node:events';
import { clamp, crossing, validateLayout, type Screens } from './layout.js';
import { translateKey } from './keys.js';
import type {Command, Input, Layout, Point, Side} from './protocol.js';
export interface FocusEvent {version:1;type:'input-focus';epoch:number;source:Side|null;target:Side|null;reason:string;timestamp:number}
// Future Computer Context consumers subscribe to focus; no implicit mutation of an agent's context.
export class InputSharingEngine extends EventEmitter {
 epoch=0;source:Side|null=null;target:Side|null=null;point:Point={x:0,y:0};
 private pending:{phase:'target'|'source';source:Side;target:Side;point:Point;deadline:number}|null=null;
 private changed=0; private held=new Set<string>();private paused=false;private rearmAt=0;
 constructor(public screens:Screens,public layout:Layout,private send:(side:Side,c:Command)=>void,private now=()=>Date.now()) {super();validateLayout(layout,screens);}
 start(){this.reset('connected');}
 // A half-completed handoff must explicitly release both native helpers before geometry changes.
 setLayout(layout:Layout){
  if(JSON.stringify(layout)===JSON.stringify(this.layout))return;
  validateLayout(layout,this.screens);
  if(this.pending || this.source) this.reset('layout-changed');
  this.layout=layout;
 }
 // pause=true always returns BOTH machines to local control. rearm_ms>0 additionally
 // re-arms the portal after a bounded cooldown, so one lost ACK (or a 700 ms hiccup)
 // cannot kill sharing until the user restarts both entry points by hand.
 reset(reason:string, pause=false, rearmMs=0){this.epoch++;this.pending=null;this.source=null;this.target=null;this.held.clear();this.paused=pause;this.rearmAt=pause&&rearmMs>0?this.now()+rearmMs:0;this.changed=this.now();
  for(const side of ['windows','mac'] as const)this.send(side,{t:'mode',mode:'local',epoch:this.epoch});this.focus(reason);
 }
 private focus(reason:string){this.emit('focus',{version:1,type:'input-focus',epoch:this.epoch,source:this.source,target:this.target,reason,timestamp:this.now()} satisfies FocusEvent);}
 tick(){
  if(this.pending&&this.now()>this.pending.deadline){this.reset('switch-timeout',true,1200);return;}
  if(this.paused&&this.rearmAt&&this.now()>=this.rearmAt){this.paused=false;this.rearmAt=0;this.changed=this.now();this.focus('rearmed');}
 }
 get isPaused(){return this.paused;}
 get rearm_at(){return this.rearmAt;}
 private transfer(source:Side,target:Side,point:Point){
  this.epoch++;this.pending={phase:'target',source,target,point,deadline:this.now()+700};
  // Receiver must confirm it is ready BEFORE swallowing any source input.
  this.send(target,{t:'mode',epoch:this.epoch,mode:source===target?'local':'receive',point});
 }
 ack(side:Side,epoch:number){const p=this.pending;if(!p||epoch!==this.epoch)return;
  if(p.phase==='target'&&side===p.target){
   if(p.source===p.target){const old=this.target;if(old&&old!==p.target)this.send(old,{t:'mode',epoch:this.epoch,mode:'local'});this.finish(p);}
   else {p.phase='source';this.send(p.source,{t:'mode',epoch:this.epoch,mode:'remote'});}
  }else if(p.phase==='source'&&side===p.source)this.finish(p);
 }
 private finish(p:NonNullable<InputSharingEngine['pending']>){this.source=p.source;this.target=p.target;this.point=p.point;this.pending=null;this.held.clear();this.changed=this.now();this.focus('edge');}
 input(side:Side,epoch:number,e:Input){if(this.paused||epoch!==this.epoch||this.pending)return;
  // Physical input on the receiver immediately gives the human local control again.
  if(this.source&&side!==this.source){if(e.kind!=='move'||e.dx||e.dy)this.reset('receiver-activity');return;}
  const target=this.target??side;
  if(e.kind==='key'||e.kind==='button'){
   const id=e.kind==='key'?'k'+e.code:'b'+e.button;if(e.down)this.held.add(id);else this.held.delete(id);
  }
  if(e.kind==='move'){
   const p=target===side?{x:e.x,y:e.y}:{x:this.point.x+e.dx*this.layout.speed,y:this.point.y+e.dy*this.layout.speed};
   if(e.held===0&&this.held.size===0&&this.now()-this.changed>=this.layout.cooldown_ms){
    // Test the current location for large deltas; never teleport across a display gap.
    const edgePoint=target===side?p:clamp(this.screens[target],p);
    const next=crossing(this.layout,this.screens,target,edgePoint,e.dx,e.dy);
    if(next){this.transfer(side,next.side,next.point);return;}
   }
   this.point=clamp(this.screens[target],p);
   if(target!==side)this.send(target,{t:'input',epoch:this.epoch,e:{...e,...this.point}});
  }else if(target!==side){
   if(e.kind==='key'){const code=translateKey(side,e.code);if(code===undefined)return;this.send(target,{t:'input',epoch:this.epoch,e:{...e,code}});}
   else this.send(target,{t:'input',epoch:this.epoch,e});
  }
 }
}
