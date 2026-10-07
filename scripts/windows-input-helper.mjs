import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile,mkdir,mkdtemp,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Versioned, per-user binaries work with read-only Program Files and preserve old builds.
export async function ensureWindowsInputHelper(){
 if(process.platform!=='win32')throw Error('Windows input helper requires Windows');
 const root=fileURLToPath(new URL('../',import.meta.url));
 const source=await readFile(path.join(root,'native/InputShareWindows.cs'));
 const hash=createHash('sha256').update(source).digest('hex').slice(0,20);
 const directory=path.join(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData/Local'),'AgentLink','helpers',hash);
 const helper=path.join(directory,'AgentLinkInput.exe');
 if(existsSync(helper))return helper;
 await mkdir(directory,{recursive:true});
 const stage=await mkdtemp(path.join(os.tmpdir(),'agentlink-native-build-'));
 const built=path.join(stage,'AgentLinkInput.exe');
 execFileSync(process.execPath,[path.join(root,'scripts/build-input-share.mjs'),built],{stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:60000});
 // Never replace a binary that another process might have loaded.
 await copyFile(built,helper,1).catch(error=>{if(error.code!=='EEXIST')throw error;});
 return helper;
}
