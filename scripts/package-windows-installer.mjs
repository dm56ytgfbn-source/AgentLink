import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

if (process.platform !== 'win32') throw Error('Build the Windows installer on Windows');
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const out = path.resolve(process.argv[2] ?? path.join(root, 'build', 'installers'));
const filename = `AgentLink-Setup-${version}-windows-x64.exe`;
if (existsSync(path.join(out, filename))) throw Error('Installer already exists; preserved: ' + path.join(out, filename));

const compilerCandidates = [process.env.AGENTLINK_ISCC,
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Inno Setup 7', 'ISCC.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe')].filter(Boolean);
const compiler = compilerCandidates.find(candidate => existsSync(candidate));
if (!compiler) throw Error('Inno Setup ISCC.exe is required (or set AGENTLINK_ISCC to its path)');

const staging = await mkdtemp(path.join(os.tmpdir(), 'agentlink-installer-'));
const payload = path.join(staging, 'AgentLink-Windows');
execFileSync(process.execPath, [path.join(root, 'scripts', 'package-windows.mjs'), '--payload-dir', payload],
  {cwd: root, stdio: 'inherit'});
for (const required of ['AgentLink.exe', 'runtime/node/node.exe', 'runtime/dist/apps/node/main.js',
  'runtime/scripts/windows-launch.mjs', '使用说明.txt']) {
  if (!existsSync(path.join(payload, required))) throw Error('Incomplete Windows payload: ' + required);
}
await mkdir(out, {recursive: true});
execFileSync(compiler, [`-dMyAppVersion=${version}`, `-dPayloadDir=${payload}`, `-o${out}`,
  path.join(root, 'packaging', 'windows', 'AgentLink.iss')], {cwd: root, stdio: 'inherit'});
const installer = path.join(out, filename);
if (!existsSync(installer)) throw Error('Inno Setup did not create the expected installer: ' + installer);
console.log(JSON.stringify({installer, version, bytes: (await stat(installer)).size,
  signed: false, retained_payload: payload}, null, 2));
