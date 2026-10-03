import {mkdir, writeFile, readFile, stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Builds the menu bar app. The app is a thin client: it calls the same runtime the CLI and
// every AI agent use. No protocol, trust or policy logic is duplicated in Swift.
if (process.platform !== 'darwin') throw Error('macOS with the Swift compiler is required');
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.resolve(process.argv[2] ?? 'build/AgentLink.app');
try { await stat(out); throw Error('Output exists; choose a new path to preserve it: ' + out); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const macos = path.join(out, 'Contents', 'MacOS');
const resources = path.join(out, 'Contents', 'Resources');
await mkdir(macos, { recursive: true });
await mkdir(resources, { recursive: true });
const cache = path.join(root, '.build', 'swift-cache');
await mkdir(cache, { recursive: true });

execFileSync('swiftc', [path.join(root, 'mac', 'AgentLinkMenu', 'main.swift'), '-module-cache-path', cache,
  '-O', '-o', path.join(macos, 'AgentLinkMenu'), '-framework', 'AppKit', '-framework', 'WebKit'], { stdio: 'inherit' });

const version = JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const info = {
  CFBundleName: 'AgentLink', CFBundleDisplayName: 'AgentLink', CFBundleIdentifier: 'local.agentlink.menu',
  CFBundleExecutable: 'AgentLinkMenu', CFBundlePackageType: 'APPL', CFBundleShortVersionString: version.split('-')[0],
  CFBundleVersion: '3', LSUIElement: true, LSMinimumSystemVersion: '12.0', NSHighResolutionCapable: true,
  NSLocalNetworkUsageDescription: 'AgentLink connects to the computers you paired, on your local network.',
};
const plist = path.join(out, 'Contents', 'Info.plist');
await writeFile(plist, JSON.stringify(info, null, 2));
execFileSync('plutil', ['-convert', 'xml1', plist]);
await writeFile(path.join(resources, 'runtime.json'),
  JSON.stringify({ runtime_root: root, node: process.execPath, session: 'agentlink-menu' }, null, 2) + '\n');
execFileSync('codesign', ['--force', '--sign', '-', out], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', out], { stdio: 'inherit' });
console.log(out);
