import type {Command,Display,NativeMessage,Mode} from '../../packages/input-share/protocol.js';

// Opt-in, bounded-test telemetry: counts and edge conditions only. Never emit key codes,
// text, individual coordinates or a stream from which pointer movement can be reconstructed.
export class InputDiagnostics {
 private displays:Display[]=[];
 private epoch=0;private mode:Mode='local';private ackEpoch:number|null=null;
 private counts=this.empty();
 constructor(private publish:(summary:unknown)=>void){}
 private empty(){return {moves:0,leftEdge:0,leftOutward:0,leftHeld:0,nonzeroDelta:0,keyEvents:0,buttonEvents:0};}
 command(c:Command){if(c.t==='mode'){this.flush();this.epoch=c.epoch;this.mode=c.mode;this.ackEpoch=null;}}
 message(m:NativeMessage){
  if(m.t==='ready'){this.displays=m.displays;this.publish({type:'input-diagnostics-ready',permissions:m.permissions,displayCount:m.displays.length});return;}
  if(m.t==='ack'){this.ackEpoch=m.epoch;return;}
  if(m.t!=='event')return;
  const e=m.e;
  if(e.kind==='key'){this.counts.keyEvents++;return;}
  if(e.kind==='button'){this.counts.buttonEvents++;return;}
  if(e.kind!=='move')return;
  this.counts.moves++;
  if(e.dx||e.dy)this.counts.nonzeroDelta++;
  const left=this.displays.reduce((a,b)=>b.x<a.x?b:a,this.displays[0]);
  if(left&&e.x<=left.x+1&&e.x>=left.x-500&&e.y>=left.y&&e.y<left.y+left.height){
   this.counts.leftEdge++;if(e.dx<0)this.counts.leftOutward++;if(e.held)this.counts.leftHeld++;
  }
 }
 flush(){
  if(Object.values(this.counts).some(n=>n))this.publish({type:'input-diagnostics',epoch:this.epoch,mode:this.mode,ackEpoch:this.ackEpoch,...this.counts});
  this.counts=this.empty();
 }
}
