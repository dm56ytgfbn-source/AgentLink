import {EventEmitter} from 'node:events';
import type {Duplex} from 'node:stream';
import {timingSafeEqual,createHash} from 'node:crypto';
export function secretEqual(a:string,b:string){return timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());}
// TLS provides authenticated ordered delivery. Per-connection sequence numbers reject replay/stale frames.
export class JsonChannel extends EventEmitter {
 private buffer=Buffer.alloc(0);private sent=0;private received=0;private closed=false;
 private window=Date.now();private count=0;
 constructor(public stream:Duplex){super();stream.on('data',(b:Buffer)=>this.data(b));stream.on('error',()=>this.close('transport-error'));stream.on('close',()=>this.close('disconnected'));stream.on('end',()=>this.close('disconnected'));}
 private data(chunk:Buffer){
  if(this.closed)return;
  if(this.buffer.length+chunk.length>256*1024){this.close('receive-limit');return;}
  this.buffer=Buffer.concat([this.buffer,chunk]);
  while(!this.closed){const n=this.buffer.indexOf(10);if(n<0){if(this.buffer.length>16384)this.close('frame-limit');return;}
   if(n>16384){this.close('frame-limit');return;}
   const line=this.buffer.subarray(0,n);this.buffer=this.buffer.subarray(n+1);
   let body:unknown;
   try{const now=Date.now();if(now-this.window>=1000){this.count=0;this.window=now;}if(++this.count>5000)throw Error();
    const frame=JSON.parse(line.toString());if(frame.seq!==this.received+1||!frame.body||typeof frame.body!=='object')throw Error();this.received++;body=frame.body;
   }catch{this.close('invalid-frame');return;}
   this.emit('message',body);
  }
 }
 send(body:unknown){if(this.closed)return false;const data=JSON.stringify({seq:++this.sent,body})+'\n';
  if(Buffer.byteLength(data)>16384||this.stream.writableLength+Buffer.byteLength(data)>64*1024){this.close('send-backpressure');return false;}
  return this.stream.write(data);
 }
 close(reason:string){if(this.closed)return;this.closed=true;this.stream.destroy();this.emit('closed',reason);}
}
