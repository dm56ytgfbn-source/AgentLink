import { open, stat, mkdir, rename, unlink, rmdir, realpath, lstat, readdir } from 'node:fs/promises';
// Deletions move into this folder inside the exported root instead of destroying data, so a
// mistake stays recoverable by renaming the entry back.
export const trashFolderName='.agentlink-trash';
// Staging files from interrupted writes. They are hidden from directory listings, so
// without an explicit report a failing upload silently consumes disk forever.
export const uploadPrefix='.agentlink-upload-';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveAllowed } from '../packages/security/index.js';
import { LinkError, str } from '../packages/protocol/index.js';
export const extendedFileActions=['files.write','files.stat','files.mkdir','files.rename','files.delete','files.trash','files.upload_residue','files.cleanup_uploads','files.read_chunk','files.write_chunk','files.truncate','files.commit','files.replace'];
const MAX=1024*1024;
function integer(v:unknown,max=Number.MAX_SAFE_INTEGER){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>max)throw new LinkError('INVALID_REQUEST');return v;}
export class FileOperations {
 private tail:Promise<unknown>=Promise.resolve();
 constructor(private roots:string[]){}
 // Serialize operations within this node. This is not an OS or cross-node file lock.
 run(action:string,p:Record<string,unknown>):Promise<unknown> {
  const result=this.tail.then(()=>this.dispatch(action,p));this.tail=result.catch(()=>{});return result;
 }
  // Which exported root contains this target (the trash must sit on the same volume).
  private async rootFor(target:string):Promise<string> {
    for(const root of this.roots){
      const real=await realpath(root);
      const rel=path.relative(real,target);
      if(rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)))return real;
    }
    throw new LinkError('PATH_DENIED','Target is outside the exported roots');
  }
  // Bounded scan for staging leftovers; never follows symlinks and never walks forever.
  private async scanUploads(cutoffMs?: number): Promise<Array<{ path: string; size: number; mtime_ms: number }>> {
    const found: Array<{ path: string; size: number; mtime_ms: number }> = [];
    const limit = 5000;
    for (const root of this.roots) {
      const real = await realpath(root);
      const queue: Array<{ dir: string; depth: number }> = [{ dir: real, depth: 0 }];
      let seen = 0;
      while (queue.length && found.length < limit) {
        const current = queue.shift()!;
        let entries;
        try { entries = await readdir(current.dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (++seen > limit) break;
          const full = path.join(current.dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (entry.name === trashFolderName) continue;
            if (current.depth < 6) queue.push({ dir: full, depth: current.depth + 1 });
            continue;
          }
          if (!entry.isFile() || !entry.name.startsWith(uploadPrefix)) continue;
          const info = await lstat(full).catch(() => null);
          if (!info?.isFile() || info.isSymbolicLink()) continue;
          if (cutoffMs !== undefined && info.mtimeMs >= cutoffMs) continue;
          found.push({ path: full, size: info.size, mtime_ms: info.mtimeMs });
        }
      }
    }
    return found;
  }
 private async protectRoot(target:string) {for(const root of this.roots)if(path.relative(await realpath(root),target)==='')throw new LinkError('PATH_DENIED','Cannot modify an exported root');}
 private async dispatch(action:string,p:Record<string,unknown>):Promise<unknown>{
  if(!extendedFileActions.includes(action))throw new LinkError('INVALID_REQUEST');
  // These two read no path: they must run before the shared path resolution below.
  if(action==='files.upload_residue'){
    const files=await this.scanUploads();
    return { count:files.length, bytes:files.reduce((sum,file)=>sum+file.size,0),
      oldest_ms:files.length?Math.min(...files.map(file=>file.mtime_ms)):null,
      files:files.slice(0,50), truncated:files.length>50 };
  }
  if(action==='files.cleanup_uploads'){
    // Explicit and conservative: only staging leftovers, only above one hour old, so an
    // upload that is still in progress can never be deleted by this call.
    const olderThan=integer(p.older_than_ms,365*24*60*60*1000);
    if(olderThan<60*60*1000)throw new LinkError('INVALID_REQUEST','Refusing to remove upload leftovers newer than one hour');
    const candidates=await this.scanUploads(Date.now()-olderThan);
    let removed=0,bytes=0;
    for(const candidate of candidates){
      await this.protectRoot(candidate.path);
      const info=await lstat(candidate.path).catch(()=>null);
      if(!info?.isFile()||info.isSymbolicLink())continue;
      await unlink(candidate.path);removed++;bytes+=info.size;
    }
    return {removed,bytes};
  }
  if(action==='files.write'){
   if(typeof p.data!=='string'||!['utf8','base64'].includes(String(p.encoding)))throw new LinkError('INVALID_REQUEST');
   if(p.encoding==='base64'&&!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.data))throw new LinkError('INVALID_REQUEST');
   const data=Buffer.from(p.data,p.encoding as BufferEncoding);if(data.length>MAX)throw new LinkError('INVALID_REQUEST');
   const target=await resolveAllowed(str(p.path),this.roots,true);await this.protectRoot(target);
   let version:string|null=null;
   try{const s=await lstat(str(p.path));if(!s.isFile()||s.isSymbolicLink()||s.nlink>1)throw new LinkError('PATH_DENIED');version=`${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   const staging=path.join(path.dirname(target),'.agentlink-upload-'+randomUUID());
   const file=await open(staging,'wx',0o600);
   try{await file.writeFile(data);await file.sync();}finally{await file.close();}
   // On conflict/failure the original and staged content remain available for recovery.
   await this.dispatch('files.commit',{path:staging,destination:target,version});
   return {bytes:data.length};
  }
  if(['files.delete','files.rename','files.write_chunk','files.truncate','files.commit','files.replace'].includes(action)){
   try{if((await lstat(str(p.path))).isSymbolicLink())throw new LinkError('PATH_DENIED');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
  if(action==='files.write_chunk'){
   const offset=integer(p.offset);
   if(typeof p.data!=='string'||p.data.length>Math.ceil(MAX/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.data))throw new LinkError('INVALID_REQUEST');
   const bytes=Buffer.from(p.data,'base64').length;if(bytes>MAX||!Number.isSafeInteger(offset+bytes))throw new LinkError('INVALID_REQUEST');
  }
  if(action==='files.truncate')integer(p.size);
  const target=await resolveAllowed(str(p.path),this.roots,action==='files.mkdir'||action==='files.write_chunk');
  if(action==='files.stat') {const s=await stat(target);return {type:s.isDirectory()?'directory':s.isFile()?'file':'other',size:s.size,mtime_ms:s.mtimeMs,ctime_ms:s.ctimeMs,mode:s.mode,version:`${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`};}
  if(action==='files.mkdir'){await mkdir(target);return {created:true};}
  if(action==='files.commit'||action==='files.replace'){
   await this.protectRoot(target);
   const source=await lstat(target);
   if(!source.isFile()||source.isSymbolicLink()||source.nlink>1)throw new LinkError('PATH_DENIED');
   if(action==='files.commit'&&!path.basename(target).startsWith('.agentlink-upload-'))throw new LinkError('INVALID_REQUEST');
   if(action==='files.replace'&&p.source_version!==`${source.ino}:${source.size}:${source.mtimeMs}:${source.ctimeMs}`)throw new LinkError('CONFLICT','Source changed before replacement');
   try{if((await lstat(str(p.destination))).isSymbolicLink())throw new LinkError('PATH_DENIED');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   const destination=await resolveAllowed(str(p.destination),this.roots,true);await this.protectRoot(destination);
   if(path.dirname(target)!==path.dirname(destination))throw new LinkError('PATH_DENIED');
   let current:string|null=null;try{const s=await lstat(destination);if(!s.isFile()||s.isSymbolicLink()||s.nlink>1)throw new LinkError('PATH_DENIED');current=`${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   if(p.version!==current)throw new LinkError('CONFLICT','Destination changed during upload');
   await rename(target,destination);return {committed:true};
  }
  if(action==='files.rename'){
   await this.protectRoot(target);const destination=await resolveAllowed(str(p.destination),this.roots,true);await this.protectRoot(destination);
   if(target===destination)return {renamed:true};
   // No overwrite in this protocol version. Existing destination is always an error.
   try{await lstat(destination);throw new LinkError('ALREADY_EXISTS');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   await rename(target,destination);return {renamed:true};
  }
  if(action==='files.trash'){
    // Recoverable delete: a non-empty folder that Finder deletes is moved aside, not removed.
    await this.protectRoot(target);
    const root=await this.rootFor(target);
    const relative=path.relative(root,target);
    if(!relative||relative.startsWith('..'))throw new LinkError('PATH_DENIED');
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const destination=path.join(root,trashFolderName,stamp,relative);
    try{
      await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
      await rename(target,destination);
    }catch(e){
      const code=(e as NodeJS.ErrnoException).code;
      if(code==='EXDEV')throw new LinkError('FORBIDDEN','Cannot move this entry into the trash across filesystems; delete it explicitly instead');
      throw e;
    }
    return {trashed:true,moved_to:destination,restore:'Rename it back to '+target};
  }
  if(action==='files.delete'){
   await this.protectRoot(target);const s=await lstat(target);
   if(s.isDirectory())await rmdir(target);else await unlink(target);
   return {deleted:true};
  }
  if(action==='files.read_chunk'){
   const offset=integer(p.offset),length=integer(p.length,MAX);
   const file=await open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
   try{const s=await file.stat();if(!s.isFile())throw new LinkError('INVALID_REQUEST');
    const version=`${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;if(p.version!==undefined&&p.version!==version)throw new LinkError('CONFLICT','File changed during read');
    const data=Buffer.alloc(length);let n=0;while(n<length){const r=await file.read(data,n,length-n,offset+n);if(!r.bytesRead)break;n+=r.bytesRead;}
    const after=await file.stat();if(`${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`!==version)throw new LinkError('CONFLICT','File changed during read');
    return {data:data.subarray(0,n).toString('base64'),bytes:n,eof:offset+n>=s.size,version};
   }finally{await file.close();}
  }
  const file=await open(target,constants.O_RDWR|(action==='files.write_chunk'?constants.O_CREAT:0)|(constants.O_NOFOLLOW||0),0o600);
  try{const s=await file.stat();if(!s.isFile()||s.nlink>1)throw new LinkError('PATH_DENIED');
   if(action==='files.truncate'){await file.truncate(integer(p.size));await file.sync();return {size:p.size};}
   const offset=integer(p.offset);if(typeof p.data!=='string'||p.data.length>Math.ceil(MAX/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.data))throw new LinkError('INVALID_REQUEST');
   const data=Buffer.from(p.data,'base64');if(data.length>MAX||!Number.isSafeInteger(offset+data.length))throw new LinkError('INVALID_REQUEST');
   let n=0;while(n<data.length){const r=await file.write(data,n,data.length-n,offset+n);if(!r.bytesWritten)throw new LinkError('INTERNAL_ERROR');n+=r.bytesWritten;}await file.sync();return {bytes:n};
  }finally{await file.close();}
 }
}
