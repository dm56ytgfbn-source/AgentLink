import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, utimes, symlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FileOperations} from '../adapters/filesystem.js';
import {windowBrokerEnabled, windowBrokerSettings} from '../adapters/windows.js';

test('an external window helper is never discovered implicitly',()=>{
 const clean={} as NodeJS.ProcessEnv;
 assert.equal(windowBrokerSettings(clean),null,'no configuration means no external dependency');
 assert.equal(windowBrokerEnabled(clean),false);
 assert.equal(windowBrokerSettings({AGENTLINK_WINCTL_URL:'http://127.0.0.1:8766'} as NodeJS.ProcessEnv),null,'a token file is required');
 assert.deepEqual(windowBrokerSettings({AGENTLINK_WINCTL_URL:'http://127.0.0.1:8766',AGENTLINK_WINCTL_TOKEN_FILE:'C:/t.txt'} as NodeJS.ProcessEnv),
   {url:'http://127.0.0.1:8766',tokenFile:'C:/t.txt'});
 assert.equal(windowBrokerEnabled({AGENTLINK_WINCTL_URL:'http://localhost:8766',AGENTLINK_WINCTL_TOKEN_FILE:'C:/t.txt'} as NodeJS.ProcessEnv),true);
 assert.equal(windowBrokerSettings({AGENTLINK_WINCTL_URL:'https://127.0.0.1:8766',AGENTLINK_WINCTL_TOKEN_FILE:'C:/t.txt'} as NodeJS.ProcessEnv),null,'a loopback helper must not need TLS');
 assert.equal(windowBrokerSettings({AGENTLINK_WINCTL_URL:'http://10.0.0.5:8766',AGENTLINK_WINCTL_TOKEN_FILE:'C:/t.txt'} as NodeJS.ProcessEnv),null,'only loopback is allowed');
 assert.equal(windowBrokerSettings({AGENTLINK_WINCTL_URL:'not a url',AGENTLINK_WINCTL_TOKEN_FILE:'C:/t.txt'} as NodeJS.ProcessEnv),null);
});

test('upload leftovers are reported, and only removed when explicitly asked',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentlink-residue-'));
 t.after(async()=>{ const {rm}=await import('node:fs/promises'); await rm(root,{recursive:true,force:true}); });
 const files=new FileOperations([root]);
 await mkdir(path.join(root,'project','nested'),{recursive:true});
 const stale=path.join(root,'project','nested','.agentlink-upload-stale');
 const fresh=path.join(root,'.agentlink-upload-fresh');
 await writeFile(stale,'x'.repeat(1000));
 await writeFile(fresh,'y'.repeat(10));
 await writeFile(path.join(root,'project','keep.txt'),'keep');
 const twoHoursAgo=new Date(Date.now()-2*60*60*1000);
 await utimes(stale,twoHoursAgo,twoHoursAgo);

 const report=await files.run('files.upload_residue',{}) as {count:number;bytes:number;oldest_ms:number|null;files:Array<{path:string}>};
 assert.equal(report.count,2,'leftovers in nested folders must be found too');
 assert.equal(report.bytes,1010);
 assert.ok(report.files.some(entry=>entry.path.endsWith('.agentlink-upload-stale')));
 assert.ok(typeof report.oldest_ms==='number');

 await assert.rejects(files.run('files.cleanup_uploads',{older_than_ms:60000}),/one hour/,'a recent leftover may belong to an upload in flight');
 const result=await files.run('files.cleanup_uploads',{older_than_ms:60*60*1000}) as {removed:number;bytes:number};
 assert.equal(result.removed,1);
 assert.equal(result.bytes,1000);
 assert.equal(existsSync(stale),false);
 assert.equal(existsSync(fresh),true,'a leftover newer than the threshold must stay');
 assert.equal(await readFile(path.join(root,'project','keep.txt'),'utf8'),'keep','real files are never touched');
 assert.equal((await files.run('files.upload_residue',{}) as {count:number}).count,1);
});

test('the residue scan ignores symlinks instead of following them',{skip:process.platform==='win32'},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentlink-residue-link-'));
 t.after(async()=>{ const {rm}=await import('node:fs/promises'); await rm(root,{recursive:true,force:true}); });
 const files=new FileOperations([root]);
 const real=path.join(root,'real.bin'); await writeFile(real,'data');
 await symlink(real,path.join(root,'.agentlink-upload-link'));
 const report=await files.run('files.upload_residue',{}) as {count:number};
 assert.equal(report.count,0,'a symlink is not a staging leftover');
 assert.equal(existsSync(real),true);
 const result=await files.run('files.cleanup_uploads',{older_than_ms:365*24*60*60*1000}) as {removed:number};
 assert.equal(result.removed,0);
 assert.equal(await readFile(real,'utf8'),'data','the symlink target must survive');
});
