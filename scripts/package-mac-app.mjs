import {mkdir, writeFile, readFile, stat, cp, chmod, mkdtemp} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
if (process.platform !== 'darwin') throw Error('macOS with the Swift compiler is required');
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join('build', 'AgentLink.app'));
if (existsSync(out)) throw Error('Output exists; choose a new path to preserve it: ' + out);
// Retain staging for diagnostics. Never remove or overwrite an existing release.
const staging = await mkdtemp(path.join(os.tmpdir(), 'agentlink-package-'));
const app = path.join(staging, 'AgentLink.app');
execFileSync(process.execPath, [path.join(root, 'scripts/build-mac-app.mjs'), app], {stdio:'inherit'});
const resources = path.join(app, 'Contents/Resources');
const runtime = path.join(resources, 'runtime');
await mkdir(path.join(runtime, 'bin'), {recursive:true});
// Compile into the package itself, so stale checkout dist files cannot enter a release.
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--project', path.join(root,'tsconfig.json'), '--outDir', path.join(runtime,'dist')], {stdio:'inherit'});
for (const item of ['agents','scripts','package.json']) await cp(path.join(root,item),path.join(runtime,item),{recursive:true});
await cp(process.execPath,path.join(runtime,'bin/node')); await chmod(path.join(runtime,'bin/node'),0o755);
const lock = JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
const packages = Object.keys(lock.packages ?? {}).filter(key => key.startsWith('node_modules/') && lock.packages[key].dev !== true);
for (const key of packages) {
  const source = path.join(root,key);
  if (!existsSync(source)) throw Error('Required production dependency missing: '+key);
  await cp(source,path.join(runtime,key),{recursive:true,dereference:true});
}
await mkdir(path.join(runtime,'native'),{recursive:true});
for (const name of ['Mount.swift','InputShareMac.swift','InputShareWindows.cs']) await cp(path.join(root,'native',name),path.join(runtime,'native',name));
execFileSync('swiftc',[path.join(root,'native/Mount.swift'),'-module-cache-path',path.join(staging,'swift-cache'),'-o',path.join(runtime,'native/agentlink-mount'),'-framework','NetFS'],{stdio:'inherit'});
execFileSync(process.execPath,[path.join(root,'scripts/build-input-share.mjs'),path.join(runtime,'build/AgentLink Input Preview.app')],{stdio:'inherit'});
const settings = path.join(resources,'AgentLink Settings.app');
await mkdir(path.join(settings,'Contents/MacOS'),{recursive:true});
execFileSync('swiftc',[path.join(root,'mac/AgentLinkSettings/main.swift'),'-module-cache-path',path.join(staging,'swift-cache'),'-O','-o',path.join(settings,'Contents/MacOS/AgentLinkSettings'),'-framework','AppKit','-framework','WebKit'],{stdio:'inherit'});
const plist=path.join(settings,'Contents/Info.plist');
await writeFile(plist,JSON.stringify({CFBundleName:'AgentLink 设置',CFBundleIdentifier:'local.agentlink.settings',CFBundleExecutable:'AgentLinkSettings',CFBundlePackageType:'APPL',CFBundleVersion:'3',CFBundleShortVersionString:'0.1.0',NSHighResolutionCapable:true,NSLocalNetworkUsageDescription:'Find and pair with your computers on the local network.'}));
execFileSync('plutil',['-convert','xml1',plist]);
execFileSync('codesign',['--force','--sign','-',settings],{stdio:'inherit'});
await writeFile(path.join(resources,'runtime.json'),JSON.stringify({runtime_root:'runtime',node:'runtime/bin/node',session:'agentlink-menu'},null,2)+'\n');
const manifest = {version:JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version,built_at:new Date().toISOString(),architecture:process.arch,files:{}};
for (const name of ['dist/apps/runtime/cli.js','dist/apps/runtime/ui.js','dist/apps/node/pairing.js','dist/packages/input-share/engine.js','native/agentlink-mount','build/AgentLink Input Preview.app/Contents/MacOS/AgentLinkInput']) {
 manifest.files[name]=createHash('sha256').update(await readFile(path.join(runtime,name))).digest('hex');
}
await writeFile(path.join(runtime,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await mkdir(path.dirname(out),{recursive:true}); await cp(app,out,{recursive:true,errorOnExist:true,force:false});
execFileSync('codesign',['--force','--deep','--sign','-',out],{stdio:'inherit'});
execFileSync('codesign',['--verify','--deep','--strict',out],{stdio:'inherit'});
console.log(JSON.stringify({app:out,version:manifest.version,staging,production_packages:packages.length},null,2));
