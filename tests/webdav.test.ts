import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createNode,type Config} from '../apps/node/server.js';
import {createBridge} from '../apps/runtime/webdav.js';
// End-to-end DAV -> HTTPS -> real files; no Windows or user credentials required.
// The Windows path adapter is not used on this portable fixture: map its root to local paths.
import {RemoteFileSystem} from '../apps/runtime/webdav.js';
import {v2 as dav} from 'webdav-server';
import type {Device} from '../apps/runtime/client.js';
function curl(url:string,method:string,password:string,args:string[]=[]):Promise<Buffer>{return new Promise((resolve,reject)=>{
 const child=spawn('curl',['--noproxy','*','--silent','--show-error','--max-time','15','--digest','--config','-','-X',method,url,...args]);const out:Buffer[]=[];let err='';
 child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',c=>c===0?resolve(Buffer.concat(out)):reject(Error(err)));
 child.stdin.end('user = "agentlink:'+password+'"\n');
});}
test('DAV auth, streaming edit, lock tokens, rename and nonrecursive directory deletion',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentlink-dav-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files=path.join(root,'files');await (await import('node:fs/promises')).mkdir(files);
 const cert=path.join(root,'cert.pem'),key=path.join(root,'key.pem');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
 const cfg:Config={device_id:'fixture',name:'Test',host:'127.0.0.1',port:0,token:'f'.repeat(64),cert,key,allowed_roots:[files],mode:'developer',capabilities:['filesystem'],audit:path.join(root,'audit'),kill_switch:path.join(root,'STOP')};
 const {server}=await createNode(cfg);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));});
 const device:Device={device_id:'fixture',name:'Test',url:`https://127.0.0.1:${(server.address() as {port:number}).port}`,token:cfg.token,ca:cert};
 const password='b'.repeat(64);const bridge=await createBridge(device,files,password,0,'native');
 const port=await new Promise<number>(r=>bridge.start(s=>r((s!.address() as {port:number}).port)));t.after(()=>new Promise<void>(r=>bridge.stop(r)));
 const url=`http://127.0.0.1:${port}`;
 const request=async(m:string,p:string,args:string[]=[])=>curl(url+p,m,password,args);
 assert.equal((await curl(url+'/','PROPFIND','wrong',['-w','%{http_code}'])).toString(),'401');
 assert.match((await request('MKCOL','/folder',['-w','%{http_code}'])).toString(),/201$/);
 const content=Buffer.alloc(2200000,42),input=path.join(root,'input');await writeFile(input,content);
 assert.match((await request('PUT','/folder/file.bin',['--data-binary','@'+input,'-w','%{http_code}'])).toString(),/20[014]$/);
 assert.deepEqual(await request('GET','/folder/file.bin'),content);
 await request('PUT','/folder/file.bin',['--data-binary','new text']);assert.equal((await request('GET','/folder/file.bin')).toString(),'new text');
 const locked=(await request('LOCK','/folder/file.bin',['-i','-H','Content-Type: application/xml','--data-binary','<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>fixture</D:owner></D:lockinfo>'])).toString();
 const token=locked.match(/Lock-Token:\s*(<[^>]+>)/i)?.[1];assert.ok(token);
 assert.match((await request('PUT','/folder/file.bin',['--data-binary','blocked','-w','%{http_code}'])).toString(),/423$/);
 assert.match((await request('PUT','/folder/FILE.BIN',['--data-binary','blocked','-w','%{http_code}'])).toString(),/423$/);
 assert.equal(await readFile(path.join(files,'folder/file.bin'),'utf8'),'new text');
 await request('UNLOCK','/folder/file.bin',['-H','Lock-Token: '+token]);
 await request('MOVE','/folder/file.bin',['-H','Destination: '+url+'/folder/renamed.bin']);
 assert.equal(await readFile(path.join(files,'folder/renamed.bin'),'utf8'),'new text');
 // Folder deletion is recoverable now: the entry is moved into the trash, not destroyed.
 await request('DELETE','/folder');
 await assert.rejects(readFile(path.join(files,'folder','renamed.bin')));
 const buckets=await readdir(path.join(files,'.agentlink-trash'));
 assert.equal(buckets.length,1,'one trash bucket must be created');
 assert.equal(await readFile(path.join(files,'.agentlink-trash',buckets[0],'folder','renamed.bin'),'utf8'),'new text');
});
