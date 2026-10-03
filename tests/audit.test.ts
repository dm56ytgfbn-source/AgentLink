import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {AuditLog,maskSecrets,redactCommand,redactDetail} from '../apps/node/audit.js';

test('secrets are masked but ordinary commands stay readable',()=>{
 const masked=maskSecrets('powershell -c "Get-Item C:\\work\\file.txt"');
 assert.ok(masked.includes('C:/work/file.txt'.replace(/\//g,'\\'))||masked.includes('file.txt'),'an ordinary path must survive');
 assert.equal(maskSecrets('curl -H "authorization: Bearer abc"'),'curl -H "authorization: Bearer abc"');
 assert.ok(maskSecrets('deploy --token 8f3c1d9a77b24e5f8c0d1e2f3a4b5c6d').includes('<masked'));
 assert.ok(maskSecrets('setup --password hunter2secret').includes('<masked'));
 assert.ok(maskSecrets('echo ' + 'A'.repeat(40)).includes('<masked:40>'));
 assert.ok(!maskSecrets('deploy --token 8f3c1d9a77b24e5f8c0d1e2f3a4b5c6d').includes('8f3c1d9a77b24e5f8c0d1e2f3a4b5c6d'));
});

test('a command is stored as a masked preview plus a stable hash',()=>{
 const command='run --token 0123456789abcdef0123456789abcdef build';
 const redacted=redactCommand(command,false) as {preview:string;length:number;sha256:string;masked:boolean};
 assert.equal(redacted.length,command.length);
 assert.equal(redacted.masked,true);
 assert.equal(redacted.sha256,createHash('sha256').update(command).digest('hex'));
 assert.ok(!redacted.preview.includes('0123456789abcdef0123456789abcdef'));
 const full=redactCommand(command,true) as {value:string};
 assert.equal(full.value,command,'debugging mode must still be able to keep the raw command');
 const detail=redactDetail({path:'D:\\x',command:'a'.repeat(40),task_key:'k',token:'should-not-appear'},false) as Record<string,unknown>;
 assert.equal(detail.path,'D:\\x');
 assert.equal(detail.token,'<masked>');
 assert.ok(!JSON.stringify(detail).includes('a'.repeat(40)));
 assert.equal(redactDetail({offset:0,length:10,size:undefined},false) && (redactDetail({offset:0,length:10,size:undefined},false) as Record<string,unknown>).size, undefined,'undefined fields are dropped');
});

test('health probes do not flood the log, and real operations are recorded',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-audit-'));
 const file=path.join(dir,'audit.jsonl');
 const log=new AuditLog({file, maxBytes:1024, now:()=>new Date('2026-09-21T00:00:00Z')});
 await log.initialize();
 assert.equal(await log.record({operation:'/info',result:'SUCCESS'}),false,'health probes must be skipped by default');
 await log.record({operation:'files.write',result:'STARTED',detail:{path:'D:\\a.txt',command:'echo '+ 'B'.repeat(40)}});
 await log.record({operation:'files.write',result:'SUCCESS',detail:{path:'D:\\a.txt'}});
 await log.flush();
 const lines=(await readFile(file,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
 assert.equal(lines.length,2);
 assert.equal(lines[0].operation,'files.write');
 assert.equal(lines[0].timestamp,'2026-09-21T00:00:00.000Z');
 assert.equal(lines[0].result,'STARTED');
 assert.equal(typeof lines[0].detail.command.sha256,'string');
 assert.ok(!JSON.stringify(lines).includes('B'.repeat(40)),'the raw command must not be written');
 const mode=(await import('node:fs/promises')).stat(file);
 assert.ok(((await mode).mode & 0o777) === 0o600);
});

test('a growing log is sealed into segments and nothing is ever deleted',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-audit-seal-'));
 const file=path.join(dir,'audit.jsonl');
 let tick=0;
 const log=new AuditLog({file, maxBytes:180, now:()=>new Date(Date.parse('2026-09-21T00:00:00Z')+tick++*1000)});
 await log.initialize();
 for(let index=0;index<12;index++) await log.record({operation:'files.read',result:'SUCCESS',id:'request-'+index,detail:{path:'D:\\file-'+index+'.txt'}});
 await log.flush();
 const entries=await readdir(dir);
 const segments=entries.filter(name=>name.startsWith('audit-'));
 assert.ok(segments.length>=1,'a log that exceeds its limit must be sealed into a segment');
 assert.ok(entries.includes('audit.jsonl'),'the active log must continue after sealing');
 const total=(await Promise.all(entries.map(async name => (await readFile(path.join(dir,name),'utf8')).split('\n').filter(Boolean).length))).reduce((sum,count)=>sum+count,0);
 assert.equal(total,12,'sealing must not lose records');
 const active=(await readFile(file,'utf8')).split('\n').filter(Boolean);
 assert.ok(active.length<12,'the active log must have been reset at least once');
});

test('the health option is explicit, and a broken audit path fails closed',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentlink-audit-opt-'));
 const file=path.join(dir,'audit.jsonl');
 const log=new AuditLog({file, includeHealth:true});
 await log.initialize();
 assert.equal(await log.record({operation:'/info',result:'SUCCESS'}),true,'recording health is opt-in, never silent');
 await log.flush();
 const missing=new AuditLog({file:path.join(dir,'no-such-dir','audit.jsonl')});
 await assert.rejects(missing.record({operation:'files.read',result:'SUCCESS'}),/AUDIT_WRITE_FAILED/,'an unrecordable operation must not look recorded');
 await writeFile(path.join(dir,'marker'),'x');
});
