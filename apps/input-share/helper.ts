import {launchNative,type HelperProcess,type LaunchMode} from './native-process.js';
import {EventEmitter} from 'node:events';
import {nativeMessageSchema,type Command,type NativeMessage,type Input} from '../../packages/input-share/protocol.js';
// Coalesces ONLY consecutive motion; all button/key/wheel boundaries remain ordered.
export class MotionBatcher {
 private pending:Extract<Input,{kind:'move'}>|null=null;private timer:NodeJS.Timeout|undefined;
 constructor(private deliver:(e:Input)=>void,private interval=4){}
 push(e:Input){if(e.kind!=='move'){this.flush();this.deliver(e);return;}
  this.pending=this.pending?{...e,dx:this.pending.dx+e.dx,dy:this.pending.dy+e.dy}:e;
  if(!this.timer)this.timer=setTimeout(()=>this.flush(),this.interval);
 }
 flush(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;const e=this.pending;this.pending=null;if(e)this.deliver(e);}
 discard(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.pending=null;}
}
export interface HelperPort {on(event:'message',listener:(m:NativeMessage)=>void):this;on(event:'closed',listener:(reason:string)=>void):this;send(c:Command):void;stop():void;}
export class NativeHelper extends EventEmitter implements HelperPort {
 private process:HelperProcess;private buffer='';private stopped=false;private epoch=0;private batch:MotionBatcher;
 constructor(executable:string,mode:'app'|'direct'='app'){super();
  this.batch=new MotionBatcher(e=>this.emit('message',{t:'event',epoch:this.epoch,e}));
  this.process=launchNative(executable,mode);
  this.process.output.setEncoding('utf8');this.process.output.on('data',(s:string)=>this.read(s));
  this.process.child.on('error',()=>this.fail('native-helper-start-failed'));
  this.process.child.on('exit',()=>{this.fail('native-helper-exited; check OS permissions');this.process.dispose();});
  this.process.output.on('error',()=>this.fail('native-helper-output-closed'));
  this.process.input.on('error',()=>this.fail('native-helper-pipe-closed'));
 }
 private read(s:string){if(this.stopped)return;this.buffer+=s;if(this.buffer.length>256*1024){this.fail('native-buffer-limit');return;}
  while(true){const n=this.buffer.indexOf('\n');if(n<0){if(this.buffer.length>16384)this.fail('native-frame-limit');return;}
   const line=this.buffer.slice(0,n);this.buffer=this.buffer.slice(n+1);
   const parsed=(()=>{try{return nativeMessageSchema.safeParse(JSON.parse(line));}catch{return null;}})();
   if(!parsed?.success){this.fail('invalid-native-message');return;}
   const m=parsed.data;
   if(m.t==='event'){if(m.epoch!==this.epoch){this.batch.discard();this.epoch=m.epoch;}this.batch.push(m.e);}
   else{this.batch.flush();this.emit('message',m);}
  }
 }
 send(c:Command){if(this.stopped)return;if(c.t==='mode')this.batch.discard();
  if(this.process.input.writableLength>65536){this.fail('native-backpressure');return;}
  this.process.input.write(JSON.stringify(c)+'\n');
 }
 private fail(reason:string){if(this.stopped)return;this.stop();this.emit('closed',reason);}
 stop(){if(this.stopped)return;this.send({t:'stop'});this.stopped=true;this.batch.discard();this.process.input.end();
  // Give the helper time to synthesize releases; then kill only this owned helper.
  const timer=setTimeout(()=>this.process.dispose(),1800);timer.unref();this.process.child.once('exit',()=>clearTimeout(timer));
 }
}
