import { cp, mkdir, readFile, readdir, mkdtemp, stat } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

// Builds the package for a Windows machine that will BE USED. It carries an already compiled
// runtime and its dependencies, so the other side needs no Node.js installation, npm install,
// C# compiler, or openssl. The archive is written here rather than by the system "zip",
// because that one does not set the UTF-8 name flag and Windows would show mojibake.

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const payloadIndex = args.indexOf('--payload-dir');
const payloadOutput = payloadIndex < 0 ? null : path.resolve(args[payloadIndex + 1] ?? '');
if (payloadIndex >= 0 && !args[payloadIndex + 1]) throw Error('--payload-dir requires a new directory path');
const positional = payloadIndex < 0 ? args : args.filter((_, index) => index !== payloadIndex && index !== payloadIndex + 1);
const out = path.resolve(positional[0] ?? path.join(root, 'build', '给Windows电脑.zip'));
const prebuilt = positional[1] ? path.resolve(positional[1]) : null;
if (existsSync(payloadOutput ?? out)) throw Error('Output exists; choose a new path: ' + (payloadOutput ?? out));
const staging = await mkdtemp(path.join(os.tmpdir(), 'agentlink-windows-package-'));
const folder = 'AgentLink-Windows';
const payload = path.join(staging, folder);
const SKIP = /(^|\/)(\.bin|__pycache__|tests)$/;

// ---- a minimal ZIP writer: local headers, deflate payloads, one central directory ----
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosStamp(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function collect(directory, prefix, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.test(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(full, prefix + entry.name + '/', files);
    else if (entry.isFile()) files.push({ full, name: prefix + entry.name });
  }
  return files;
}

async function writeZip(target, files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const raw = await readFile(file.full);
    const data = deflateRawSync(raw, { level: 6 });
    const nameBytes = Buffer.from(file.name, 'utf8');
    const flag = Buffer.byteLength(file.name, 'utf8') === file.name.length ? 0 : 0x0800;
    const stamp = dosStamp((await stat(file.full)).mtime);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flag, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x031e, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flag, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(stamp.time, 12);
    header.writeUInt16LE(stamp.day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(target);
    stream.on('error', reject);
    stream.on('close', resolve);
    stream.end(Buffer.concat([...parts, directory, end]));
  });
}

// ---- assemble the payload ----
// Retain isolated staging and all existing releases.
await mkdir(path.join(payload, 'runtime'), { recursive: true });
const copy = (from, to) => cp(path.join(root, from), path.join(payload, to), { recursive: true, filter: source => !SKIP.test(source) });
execFileSync(process.execPath, [path.join(root,'node_modules/typescript/bin/tsc'),'--project',path.join(root,'tsconfig.json'),'--outDir',path.join(payload,'runtime/dist')], {stdio:'inherit'});
// Only ship production packages. The TypeScript compiler and test tooling are build-time only.
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const packages = Object.keys(lock.packages ?? {}).filter(key => key.startsWith('node_modules/') && lock.packages[key].dev !== true);
for (const key of packages) {
  const source = path.join(root, key);
  if (!existsSync(source)) throw Error('Required production dependency missing: ' + key);
  const destination = path.join(payload, 'runtime', key);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: true });
}
await copy('agents', 'runtime/agents');
await copy('package.json', 'runtime/package.json');
// The other side must install nothing: extracting the archive is the entire setup step, so the
// Windows build of Node travels inside the package. Without it a fresh machine stops at a
// "Node.js was not found" message that most people will not act on.
await mkdir(path.join(payload, 'runtime', 'node'), { recursive: true });
const nodeZip = path.join(root, 'build', 'node-win-x64.zip');
if (process.platform === 'win32') {
  await cp(process.execPath, path.join(payload, 'runtime', 'node', 'node.exe'));
} else if (existsSync(nodeZip)) {
  execFileSync('unzip', ['-j', '-o', nodeZip, '*/node.exe', '-d', path.join(payload, 'runtime', 'node')], { stdio: 'inherit' });
} else {
  throw Error('build/node-win-x64.zip is required for a self-contained Windows package');
}
await copy('scripts/windows-install-startup.ps1', 'runtime/scripts/windows-install-startup.ps1');
await copy('scripts/windows-configure-firewall.ps1', 'runtime/scripts/windows-configure-firewall.ps1');
await copy('scripts/windows-launch.mjs', 'runtime/scripts/windows-launch.mjs');
// Keyboard/mouse sharing is the one feature whose native half must be compiled ON Windows,
// so both the source and the build script have to travel with the package.
await copy('scripts/windows-input-share.mjs', 'runtime/scripts/windows-input-share.mjs');
await copy('scripts/build-input-share.mjs', 'runtime/scripts/build-input-share.mjs');
await copy('native/InputShareWindows.cs', 'runtime/native/InputShareWindows.cs');
const exe = path.join(payload, 'AgentLink.exe');
if (process.platform === 'win32' && !prebuilt) {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-windows-app.mjs'), exe, '--portable'], {stdio:'inherit'});
} else {
  if (!prebuilt || !existsSync(prebuilt)) throw Error('Pass a Windows-built AgentLink.exe as the second argument when packaging on macOS.');
  const sourceHash = createHash('sha256').update(await readFile(path.join(root, 'windows/AgentLinkTray/Program.cs'))).digest('hex');
  const builtFrom = (await readFile(prebuilt + '.source-sha256', 'utf8')).trim().toLowerCase();
  if (builtFrom !== sourceHash) throw Error('Windows app is stale: its source hash does not match Program.cs');
  await cp(prebuilt, exe);
}
await cp(path.join(root, 'scripts/windows-package/安装说明.txt'), path.join(payload, '使用说明.txt'));

if (payloadOutput) {
  await mkdir(path.dirname(payloadOutput), { recursive: true });
  await cp(payload, payloadOutput, { recursive: true, errorOnExist: true, force: false });
  console.log(JSON.stringify({ payload: payloadOutput, production_packages: packages.length, retained_staging: staging }));
} else {
  await mkdir(path.dirname(out), { recursive: true });
  await writeZip(out, await collect(staging, '', []));
  console.log(out + '  ' + (await stat(out)).size + ' bytes');
}
