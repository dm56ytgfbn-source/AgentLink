import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, stat} from 'node:fs/promises';
import {execFileSync, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createNode, type Config} from '../apps/node/server.js';

// The CLI used to fail above 1 MiB because files.read/write stop there. This drives the real
// command against a real node over real TLS with a file well above that limit.
const cli = fileURLToPath(new URL('../apps/runtime/cli.js', import.meta.url));

test('the CLI transfers files larger than the single-request limit, both ways',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-cli-large-'));
 const root=path.join(dir,'share'); await mkdir(root);
 const cert=path.join(dir,'cert.pem'), key=path.join(dir,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
 const config:Config={device_id:'cli-test',name:'Test',host:'127.0.0.1',port:0,token:'c'.repeat(64),cert,key,
   allowed_roots:[root],mode:'developer',capabilities:['filesystem'],audit:path.join(dir,'audit.jsonl'),kill_switch:path.join(dir,'STOP')};
 const {server}=await createNode(config);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
 const registry=path.join(dir,'runtime.local.json');
 await writeFile(registry,JSON.stringify({devices:[{name:'Test',device_id:'cli-test',token:config.token,ca:cert,
   url:'https://127.0.0.1:'+(server.address() as {port:number}).port}]}),{mode:0o600});
 const run=(args:string[])=>promisify(execFile)(process.execPath,[cli,...args],{env:{...process.env,AGENTLINK_CONFIG:registry},timeout:120000});

 // 2.5 MiB of deterministic bytes, well above the 1 MiB single-request limit.
 const payload=Buffer.alloc(2_500_000); for(let index=0;index<payload.length;index++) payload[index]=index%251;
 const source=path.join(dir,'large.bin'); await writeFile(source,payload);
 await run(['write','Test',path.join(root,'uploaded.bin'),source]);
 assert.equal((await stat(path.join(root,'uploaded.bin'))).size,payload.length,'the whole file must arrive');
 assert.deepEqual(await readFile(path.join(root,'uploaded.bin')),payload);

 const destination=path.join(dir,'downloaded.bin');
 const read=await run(['read','Test',path.join(root,'uploaded.bin'),destination]);
 assert.ok(read.stdout.includes('"bytes": 2500000'),'the CLI must report the number of bytes read');
 assert.deepEqual(await readFile(destination),payload);

 // Replacing a large file with a small one must not leave stale bytes behind.
 const small=path.join(dir,'small.txt'); await writeFile(small,'tiny');
 await run(['write','Test',path.join(root,'uploaded.bin'),small]);
 assert.equal(await readFile(path.join(root,'uploaded.bin'),'utf8'),'tiny');
 const again=path.join(dir,'small-out.txt');
 await run(['read','Test',path.join(root,'uploaded.bin'),again]);
 assert.equal(await readFile(again,'utf8'),'tiny');

 // An empty file must still create (and truncate) the remote file.
 const empty=path.join(dir,'empty.bin'); await writeFile(empty,'');
 await run(['write','Test',path.join(root,'empty.bin'),empty]);
 assert.equal((await stat(path.join(root,'empty.bin'))).size,0);
 assert.ok((await readdir(root)).includes('empty.bin'));
});
