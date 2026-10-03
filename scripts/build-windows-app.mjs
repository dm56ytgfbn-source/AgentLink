import {mkdir, writeFile, stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Builds the Windows tray app. Like the Mac app it is a thin client of the shared runtime:
// it runs "agentlink status" and renders it. No protocol or trust logic lives here.
if (process.platform !== 'win32') throw Error('Windows with the .NET Framework compiler is required');
const root = fileURLToPath(new URL('../', import.meta.url));
const consoleBuild = process.argv.includes('--console');
const portable = process.argv.includes('--portable');
const out = path.resolve(process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? path.join('build', consoleBuild ? 'AgentLink-selftest.exe' : 'AgentLink.exe'));
try { await stat(out); throw Error('Output exists; choose a new path to preserve it: ' + out); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(path.dirname(out), { recursive: true });

const frameworkRoot = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET');
const compiler = [path.join(frameworkRoot, 'Framework64', 'v4.0.30319', 'csc.exe'),
                  path.join(frameworkRoot, 'Framework', 'v4.0.30319', 'csc.exe')].find(candidate => existsSync(candidate));
if (!compiler) throw Error('csc.exe was not found; install the .NET Framework 4.x developer pack');

const source = path.join(root, 'windows', 'AgentLinkTray', 'Program.cs');
execFileSync(compiler, ['/nologo', consoleBuild ? '/target:exe' : '/target:winexe', '/platform:x64', '/optimize+',
  '/r:System.Web.Extensions.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  '/out:' + out, source], { stdio: 'inherit' });

// The app finds its runtime through this file (or AGENTLINK_RUNTIME_ROOT), so a source
// checkout works without touching the user's environment.
if (!portable) await writeFile(path.join(path.dirname(out), 'runtime-root.txt'), root + '\r\n');
console.log(out);
