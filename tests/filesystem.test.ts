import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,stat,symlink,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {FileOperations} from '../adapters/filesystem.js';
test('file adapter large chunks, Unicode, versions, rename and nonrecursive delete',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentlink-files-'));t.after(()=>rm(root,{recursive:true,force:true}));const fs=new FileOperations([root]);
 const folder=path.join(root,'中文');await fs.run('files.mkdir',{path:folder});const file=path.join(folder,'large.bin');
 const chunks=[Buffer.alloc(1024*1024,17),Buffer.alloc(1024*1024,42),Buffer.from('中文尾部')];let offset=0;
 for(const b of chunks){await fs.run('files.write_chunk',{path:file,offset,data:b.toString('base64')});offset+=b.length;}
 assert.equal((await fs.run('files.stat',{path:file}) as {size:number}).size,offset);
 let position=0,version:string|undefined;const result:Buffer[]=[];
 while(position<offset){const r=await fs.run('files.read_chunk',{path:file,offset:position,length:500000,version}) as {data:string;bytes:number;version:string};version=r.version;result.push(Buffer.from(r.data,'base64'));position+=r.bytes;}
 assert.deepEqual(Buffer.concat(result),Buffer.concat(chunks));
 await fs.run('files.write_chunk',{path:file,offset:0,data:Buffer.from('x').toString('base64')});await assert.rejects(fs.run('files.read_chunk',{path:file,offset:0,length:1,version}),/changed/);
 await assert.rejects(fs.run('files.delete',{path:folder}));assert.equal((await stat(file)).size,offset);
 const renamed=path.join(folder,'改名.bin');await fs.run('files.rename',{path:file,destination:renamed});
 await writeFile(file,'keep');await assert.rejects(fs.run('files.rename',{path:renamed,destination:file}),/ALREADY_EXISTS/);assert.equal(await readFile(file,'utf8'),'keep');
 await fs.run('files.truncate',{path:renamed,size:3});assert.equal((await stat(renamed)).size,3);
 await fs.run('files.delete',{path:renamed});await fs.run('files.delete',{path:file});await fs.run('files.delete',{path:folder});
 await assert.rejects(fs.run('files.delete',{path:root}),/exported root/);
 await assert.rejects(fs.run('files.write_chunk',{path:path.join(root,'invalid'),offset:-1,data:''}));await assert.rejects(stat(path.join(root,'invalid')));
 await assert.rejects(fs.run('files.write_chunk',{path:path.join(root,'..','escape'),offset:0,data:''}),/PATH_DENIED/);
});
test('mutations reject symlink endpoints without deleting targets',{skip:process.platform==='win32'},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentlink-link-'));t.after(()=>rm(root,{recursive:true,force:true}));const fs=new FileOperations([root]);const target=path.join(root,'target');await writeFile(target,'keep');const link=path.join(root,'link');await symlink(target,link);
 await assert.rejects(fs.run('files.delete',{path:link}),/PATH_DENIED/);assert.equal(await readFile(target,'utf8'),'keep');
});

test('upload commit rejects changed destination and preserves prior data',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentlink-commit-'));t.after(()=>rm(root,{recursive:true,force:true}));const fs=new FileOperations([root]);
 const target=path.join(root,'target'),upload=path.join(root,'.agentlink-upload-test');await writeFile(target,'old');await writeFile(upload,'new');
 const info=await fs.run('files.stat',{path:target}) as {version:string};
 await assert.rejects(fs.run('files.commit',{path:upload,destination:target,version:null}),/changed/);assert.equal(await readFile(target,'utf8'),'old');
 await fs.run('files.commit',{path:upload,destination:target,version:info.version});assert.equal(await readFile(target,'utf8'),'new');
});

test('deleting a non-empty folder moves it to a recoverable trash instead of failing',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'agentlink-trash-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files=new FileOperations([root]);
 const folder=path.join(root,'project');
 await files.run('files.mkdir',{path:folder});
 await writeFile(path.join(folder,'a.txt'),'keep');
 await mkdir(path.join(folder,'sub'));
 await writeFile(path.join(folder,'sub','b.txt'),'keep too');
 // The strict delete still refuses, which is why Finder used to fail here.
 await assert.rejects(files.run('files.delete',{path:folder}));
 const result=await files.run('files.trash',{path:folder}) as {trashed:boolean;moved_to:string;restore:string};
 assert.equal(result.trashed,true);
 assert.equal(existsSync(folder),false,'the original entry must be gone from its place');
 assert.ok(result.moved_to.includes('.agentlink-trash'),'the entry must land inside the trash folder');
 assert.equal(await readFile(path.join(result.moved_to,'a.txt'),'utf8'),'keep');
 assert.equal(await readFile(path.join(result.moved_to,'sub','b.txt'),'utf8'),'keep too');
 assert.ok(result.restore.includes(folder),'the result must explain how to restore it');
 // The exported root itself, and anything outside it, can never be trashed.
 await assert.rejects(files.run('files.trash',{path:root}),/exported root/);
 await assert.rejects(files.run('files.trash',{path:path.join(root,'missing')}));
});
