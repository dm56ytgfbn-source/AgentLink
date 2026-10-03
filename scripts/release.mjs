import {mkdir,mkdtemp,writeFile,readFile,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const releases=path.join(root,'build','releases');await mkdir(releases,{recursive:true});
const out=process.argv[2] ? path.resolve(process.argv[2]) : await mkdtemp(path.join(releases,'AgentLink-'+version+'-'));
if (process.argv[2]) {
  if (existsSync(out)) throw Error('Release output exists; preserved: '+out);
  await mkdir(out,{recursive:true});
}
const run=(script,args=[])=>execFileSync(process.execPath,[path.join(root,'scripts',script),...args],{cwd:root,stdio:'inherit'});
let artifact;
if(process.platform==='darwin'){
  const app=path.join(out,'AgentLink.app');
  const dmg=path.join(out,`AgentLink-${version}-mac-${process.arch}.dmg`);
  const metadata=path.join(out,'mac-package.json');
  run('package-mac-app.mjs',[app]);
  run('verify-release.mjs',[app]);
  run('package-mac-dmg.mjs',['--source',app,'--out',dmg,'--metadata',metadata]);
  artifact=JSON.parse(await readFile(metadata,'utf8')).artifact;
}else if(process.platform==='win32'){
  run('package-windows-installer.mjs',[out]);
  artifact=path.join(out,`AgentLink-Setup-${version}-windows-x64.exe`);
}else throw Error('Installer builds require macOS or Windows');
const data=await readFile(artifact);
await writeFile(path.join(out,'RELEASE.json'),JSON.stringify({version,platform:process.platform,
  architecture:process.arch,created_at:new Date().toISOString(),artifact:path.basename(artifact),
  bytes:(await stat(artifact)).size,sha256:createHash('sha256').update(data).digest('hex'),
  public_release_ready:false,
  pending:['code signing','macOS notarization where applicable','clean-machine install and upgrade tests']},null,2)+'\n');
console.log('RELEASE_DIRECTORY='+out);
