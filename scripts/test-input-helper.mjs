// Bounded native smoke check: local/pass-through mode ONLY. Never injects or captures away input.
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const executable=process.argv[2];
if(!executable)throw Error('Pass the built native input helper path');
async function check(reason){
 const child=spawn(executable,[],{stdio:['pipe','pipe','pipe']});
 let buffer='',ready=false,panic='',timer;let error='';
 const deadline=setTimeout(()=>child.kill(),4500);
 child.stderr.on('data',b=>{error+=b.toString();});
 child.stdout.on('data',b=>{buffer+=b.toString();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);const m=JSON.parse(line);
  // Ignore all input events; only readiness and final stop reason are examined.
  if(m.t==='ready'){ready=true;assert.equal(m.permissions,true);assert.ok(m.displays.length);child.stdin.write('{"t":"ping"}\n');if(reason==='controller-exited')timer=setTimeout(()=>child.stdin.end(),250);}
  if(m.t==='panic')panic=m.reason;
 }});
 const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
 clearTimeout(deadline);if(timer)clearTimeout(timer);
 assert.equal(ready,true,error||'Native helper did not become ready');assert.equal(code,0);assert.equal(panic,reason);
 console.log(`PASS: local-only native helper recovered from ${reason}`);
}
await check('controller-exited');await check('controller-timeout');
