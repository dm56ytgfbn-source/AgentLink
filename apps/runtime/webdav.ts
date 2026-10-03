import { v2 as dav, Errors } from 'webdav-server';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {call,type Device} from './client.js';
import type {Action} from '../../packages/protocol/index.js';
const error=(e:any)=>e?.code==='NOT_FOUND'?Errors.ResourceNotFound:e?.code==='ALREADY_EXISTS'?Errors.ResourceAlreadyExists:e?.code==='PATH_DENIED'||e?.code==='FORBIDDEN'?Errors.Forbidden:e;
export type Roots = string | Record<string,string>;

// webdav-server keeps its lock table on the file-system object, which is not a documented
// API. Relying on it silently is dangerous: after a library upgrade the loop below could
// simply find nothing and write locks would stop being enforced without any error. The shape
// is therefore verified, and a request is failed rather than executed unprotected.
export function lockStoreStatus(fs:unknown):{ok:boolean;reason?:string} {
  const resources = (fs as {resources?:unknown} | null)?.resources;
  if (!resources || typeof resources !== 'object') return {ok:false,reason:'the library no longer exposes a resource map'};
  const values = Object.values(resources as Record<string,unknown>);
  if (!values.length) return {ok:true};
  const sample = values[0] as {locks?:{getLocks?:unknown}} | null;
  if (!sample || typeof sample !== 'object' || !sample.locks || typeof sample.locks.getLocks !== 'function')
    return {ok:false,reason:'a cached resource has no usable lock store'};
  return {ok:true};
}
export class RemoteFileSystem extends dav.PhysicalFileSystem {
 private paths:typeof path;
 private roots:Record<string,string>;
 private multi:boolean;
 constructor(private device:Device, roots:Roots, style:'windows'|'native'='windows', private resolveDevice?:()=>Promise<Device>){
  super('/');
  this.paths=style==='windows'?path.win32:path;
  if(typeof roots==='string'){this.roots={'':roots};this.multi=false;}
  else{const keys=Object.keys(roots);if(keys.length===1&&keys[0]===''){this.roots=roots;this.multi=false;}else{this.roots=roots;this.multi=true;}}
 }
 private isVirtualRoot(p:dav.Path){return (p.toString().replace(/\/+$/,'')||'/')==='/';}
 private remote(p:dav.Path){
  const raw=p.toString();const bits=raw.split('/').filter(Boolean);
  if(bits.some(b=>b==='..'||b==='.'||b.includes('\\')||b.includes(':')||b.includes('\0')||/[. ]$/.test(b))){console.error('[agentlink] denied path:',JSON.stringify(raw));throw Errors.Forbidden;}
  if(!this.multi)return this.paths.join(this.roots[''],...bits);
  const keys=Object.keys(this.roots);
  if(bits.length===0)throw Errors.Forbidden;
  const key=keys.find(k=>k.toLowerCase()===bits[0].toLowerCase());
  if(!key)throw Errors.Forbidden;
  return this.paths.join(this.roots[key],...bits.slice(1));
 }
 private async request(action:Action,payload:Record<string,unknown>){return await call(this.resolveDevice?await this.resolveDevice():this.device,action,payload) as any;}
 private done(promise:Promise<any>,cb:any){promise.then(v=>cb(null,v),e=>cb(error(e)));}
 private guard(cb:any,fn:()=>void){try{fn();}catch(e:any){if(!(e&&e.constructor&&e.constructor.name==='ForbiddenError'))console.error('[agentlink] fs error:',e?.message??e);cb(error(e));}}
 private statInfo(p:dav.Path){return this.request('files.stat',{path:this.remote(p)});}
 protected _type(p:dav.Path,c:any,cb:any){this.guard(cb,()=>{if(this.multi&&this.isVirtualRoot(p)){cb(null,dav.ResourceType.Directory);return;}this.done(this.statInfo(p).then(s=>s.type==='directory'?dav.ResourceType.Directory:dav.ResourceType.File),cb);});}
 protected _size(p:dav.Path,c:any,cb:any){this.guard(cb,()=>{if(this.multi&&this.isVirtualRoot(p)){cb(null,0);return;}this.done(this.statInfo(p).then(s=>s.size),cb);});}
 protected _creationDate(p:dav.Path,c:any,cb:any){this.guard(cb,()=>{if(this.multi&&this.isVirtualRoot(p)){cb(null,Date.now());return;}this.done(this.statInfo(p).then(s=>s.ctime_ms),cb);});}
 protected _lastModifiedDate(p:dav.Path,c:any,cb:any){this.guard(cb,()=>{if(this.multi&&this.isVirtualRoot(p)){cb(null,Date.now());return;}this.done(this.statInfo(p).then(s=>s.mtime_ms),cb);});}
 protected _readDir(p:dav.Path,c:any,cb:any){this.guard(cb,()=>{if(this.multi&&this.isVirtualRoot(p)){cb(null,Object.keys(this.roots));return;}const target=this.remote(p);this.done(this.request('files.list',{path:target}).then(a=>{const names=a.filter((e:any)=>e.type!=='symlink'&&!e.name.startsWith('.agentlink-upload-')&&e.name!=='.agentlink-trash'&&!e.name.startsWith('._')).map((e:any)=>e.name);console.error('[agentlink] readDir',JSON.stringify(p.toString()),'->',target,'count='+names.length,JSON.stringify(names));return names;}),cb);});}
 protected _create(p:dav.Path,c:any,cb:any){this.guard(cb,()=>{if(this.multi&&this.isVirtualRoot(p))throw Errors.Forbidden;this.done(this.request(c.type.isDirectory?'files.mkdir':'files.write_chunk',c.type.isDirectory?{path:this.remote(p)}:{path:this.remote(p),offset:0,data:''}).then(()=>undefined),cb);});}
 protected _delete(p:dav.Path,c:any,cb:any){this.guard(cb,()=>{if(this.multi&&this.isVirtualRoot(p))throw Errors.Forbidden;const target=this.remote(p);this.done((async()=>{try{await this.request('files.trash',{path:target});}catch(e:any){const code=e?.code;if(code==='EXDEV'||code==='FORBIDDEN'||code==='NOT_FOUND')await this.request('files.delete',{path:target});else throw e;}})(),cb);});}
 protected _move(from:dav.Path,to:dav.Path,c:any,cb:any){this.guard(cb,()=>{const source=this.remote(from),destination=this.remote(to);this.done((async()=>{try{await this.request('files.rename',{path:source,destination});}catch(e:any){if(e?.code!=='ALREADY_EXISTS')throw e;const before=await this.request('files.stat',{path:destination});const input=await this.request('files.stat',{path:source});await this.request('files.replace',{path:source,destination,version:before.version,source_version:input.version});}return false;})(),cb);});}
 protected _openReadStream(p:dav.Path,c:any,cb:any){
  this.guard(cb,()=>{if(this.multi&&this.isVirtualRoot(p))throw Errors.Forbidden;const target=this.remote(p),request=this.request.bind(this);
  const stream=Readable.from((async function*(){let offset=0,version:string|undefined;while(true){const r=await request('files.read_chunk',{path:target,offset,length:512*1024,version});version=r.version;const data=Buffer.from(r.data,'base64');if(data.length)yield data;offset+=data.length;if(r.eof)break;if(!data.length)throw Error('Read made no progress');}})());cb(null,stream);});
 }
 protected _openWriteStream(p:dav.Path,c:any,cb:any){
  this.guard(cb,()=>{if(this.multi&&this.isVirtualRoot(p))throw Errors.Forbidden;const target=this.remote(p),temp=this.paths.join(this.paths.dirname(target),'.agentlink-upload-'+randomUUID()),request=this.request.bind(this);let version:string|null=null,offset=0,committed=false;
  const initialize=async()=>{try{version=(await request('files.stat',{path:target})).version;}catch(e:any){if(e.code!=='NOT_FOUND')throw e;}await request('files.write_chunk',{path:temp,offset:0,data:''});
   return new Writable({write(chunk,encoding,done){(async()=>{const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,encoding);for(let i=0;i<b.length;i+=512*1024){const part=b.subarray(i,i+512*1024);await request('files.write_chunk',{path:temp,offset,data:part.toString('base64')});offset+=part.length;}})().then(()=>done(),done);},final(done){request('files.commit',{path:temp,destination:target,version}).then(()=>{committed=true;done();},done);},destroy(e,done){if(!committed)console.error('[agentlink] retained incomplete upload for recovery');done(e);}});
  };this.done(initialize(),cb);});
 }
}
export async function createBridge(device:Device, root:Roots, password:string, port=7480, style:'windows'|'native'='windows', resolveDevice?:()=>Promise<Device>){
 if(password.length<32)throw Error('Strong local bridge password required');
 await call(device);
 const roots=typeof root==='string'?{'':root}:root;
 for(const value of Object.values(roots))await call(device,'files.stat',{path:value});
 const users=new dav.SimpleUserManager();const user=users.addUser('agentlink',password,false);const privileges=new dav.SimplePathPrivilegeManager();privileges.setRights(user,'/',['all']);
 const fs=new RemoteFileSystem(device,root,style,resolveDevice);
 const locks=lockStoreStatus(fs);
 if(!locks.ok)console.error('[agentlink] lock enforcement could not be verified ('+locks.reason+'); write requests will be refused until the library is compatible again');
 const server=new dav.WebDAVServer({hostname:'127.0.0.1',port,httpAuthentication:new dav.HTTPDigestAuthentication(users,'AgentLink'),privilegeManager:privileges,requireAuthentification:true,rootFileSystem:fs,maxRequestDepth:1,lockTimeout:300,headers:{'Cache-Control':'no-store'}});
 server.beforeRequest((ctx,next)=>{
  const response=ctx.response;const original=response.setHeader.bind(response);
  response.setHeader=((name:string,value:any)=>original(name,name.toLowerCase()==='lock-token'&&!String(value).startsWith('<')?'<'+value+'>':value)) as typeof response.setHeader;
  const method=ctx.request.method??'';
  const condition=String(ctx.request.headers.if??'');
  delete ctx.request.headers.if;
  if(!['PUT','DELETE','MOVE','COPY','MKCOL','PROPPATCH'].includes(method)){next();return;}
  void (async()=>{
   const locks=lockStoreStatus(fs);
   if(!locks.ok){console.error('[agentlink] refusing a write: '+locks.reason);response.statusCode=500;response.end();return;}
   const paths=[decodeURIComponent(new URL(ctx.request.url??'/','http://127.0.0.1').pathname).replace(/\/$/,'').toLowerCase()||'/'];
   if(ctx.request.headers.destination)paths.push(decodeURIComponent(new URL(String(ctx.request.headers.destination)).pathname).replace(/\/$/,'').toLowerCase()||'/');
   for(const [key,resource] of Object.entries(fs.resources)){
    const locked=key.replace(/\/$/,'').toLowerCase()||'/';
    if(!paths.some(p=>p===locked||p.startsWith(locked==='/'?'/':locked+'/')||(['MOVE','DELETE'].includes(method)&&locked.startsWith(p+'/'))))continue;
    const locks=await new Promise<dav.Lock[]>((resolve,reject)=>resource.locks.getLocks((e,v)=>e?reject(e):resolve(v??[])));
    for(const lock of locks)if(!condition.includes('<'+lock.uuid+'>')||/\bNot\b/i.test(condition)){response.statusCode=423;response.end();return;}
   }
   next();
  })().catch(()=>{response.statusCode=400;response.end();});
 });
 return server;
}
