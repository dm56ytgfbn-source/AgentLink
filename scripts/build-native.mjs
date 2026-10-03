import { mkdir, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.platform !== 'darwin') throw Error('macOS with Swift compiler required');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.argv[2] ?? 'build/AgentLink Windows.app');
try { await stat(output); throw Error('Output already exists; use a new path to preserve it'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
await mkdir(path.join(output, 'Contents/MacOS'), { recursive: true });
execFileSync('swiftc', [path.join(root, 'native/AgentLinkWindowApp.swift'), '-o', path.join(output, 'Contents/MacOS/AgentLinkWindows'), '-framework', 'AppKit', '-framework', 'Security'], { stdio: 'inherit' });
const info = { CFBundleName: 'AgentLink Windows', CFBundleIdentifier: 'local.agentlink.windows', CFBundleExecutable: 'AgentLinkWindows', CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1', NSHighResolutionCapable: true, NSLocalNetworkUsageDescription: 'AgentLink connects to your paired Windows computer to show and operate its application windows.' };
const file = path.join(output, 'Contents/Info.plist');
await writeFile(file, JSON.stringify(info));
execFileSync('plutil', ['-convert', 'xml1', file]);
execFileSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', output], { stdio: 'inherit' });
console.log(output);
