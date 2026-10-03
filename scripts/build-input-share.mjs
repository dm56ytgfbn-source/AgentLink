import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.resolve(process.argv[2]??'build/AgentLink Input.app');
try{await stat(out);throw Error('Output exists; choose a new output path to preserve it');}catch(e){if(e.code!=='ENOENT')throw e;}
if(process.platform==='darwin'){
 await mkdir(path.join(out,'Contents/MacOS'),{recursive:true});
 const moduleCache=await mkdtemp(path.join(os.tmpdir(),'agentlink-input-swift-cache-'));
 execFileSync('swiftc',[path.join(root,'native/InputShareMac.swift'),'-module-cache-path',moduleCache,'-O','-o',path.join(out,'Contents/MacOS/AgentLinkInput'),'-framework','AppKit'],{stdio:'inherit'});
 await writeFile(path.join(out,'Contents/Info.plist'),JSON.stringify({CFBundleName:'AgentLink Input',CFBundleIdentifier:'local.agentlink.input',CFBundleExecutable:'AgentLinkInput',CFBundlePackageType:'APPL',CFBundleVersion:'1',CFBundleShortVersionString:'0.1.0',LSUIElement:true,NSInputMonitoringUsageDescription:'Share keyboard and mouse with your paired computer.'}));
 execFileSync('plutil',['-convert','xml1',path.join(out,'Contents/Info.plist')]);
 execFileSync('codesign',['--sign','-',out],{stdio:'inherit'});
}else if(process.platform==='win32'){
 await mkdir(path.dirname(out),{recursive:true});
 // 64-bit first, then the 32-bit compiler: a machine may have only one of them.
 const frameworkRoot=path.join(process.env.WINDIR??'C:\\Windows','Microsoft.NET');
 const compiler=[path.join(frameworkRoot,'Framework64','v4.0.30319','csc.exe'),path.join(frameworkRoot,'Framework','v4.0.30319','csc.exe')].find(candidate=>existsSync(candidate));
 if(!compiler)throw Error('找不到 csc.exe，需要 .NET Framework 4.x（Windows 10/11 自带）');
 execFileSync(compiler,['/nologo','/target:exe','/platform:x64','/optimize+','/r:System.Web.Extensions.dll','/r:System.Windows.Forms.dll','/r:System.Drawing.dll',`/out:${out}`,path.join(root,'native/InputShareWindows.cs')],{stdio:'inherit'});
}else throw Error('Only Windows and macOS are supported');
console.log(out);
