import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [macRoot, windowsRoot, output, tag] = process.argv.slice(2);
if (!macRoot || !windowsRoot || !output || !tag) {
  throw new Error('Usage: node scripts/prepare-release-assets.mjs MAC_ARTIFACT_DIR WINDOWS_ARTIFACT_DIR OUTPUT_DIR TAG');
}
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
if (tag !== `v${version}`) throw new Error(`Tag ${tag} does not match package version ${version}`);

async function manifests(directory) {
  const found = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, item.name);
    if (item.isDirectory()) found.push(...await manifests(child));
    else if (item.isFile() && item.name === 'RELEASE.json') found.push(child);
  }
  return found;
}

async function checkedArtifact(root, platform, architecture, expectedName) {
  const files = await manifests(root);
  if (files.length !== 1) throw new Error(`Expected one ${platform} RELEASE.json, found ${files.length}`);
  const metadata = JSON.parse(await readFile(files[0], 'utf8'));
  if (metadata.version !== version || metadata.platform !== platform || metadata.architecture !== architecture) {
    throw new Error(`${platform} version/platform/architecture mismatch`);
  }
  if (process.env.GITHUB_SHA && (metadata.source_commit !== process.env.GITHUB_SHA || metadata.source_dirty !== false)) {
    throw new Error(`${platform} installer does not match the clean workflow commit`);
  }
  const name = path.basename(metadata.artifact ?? '');
  if (name !== expectedName || name !== metadata.artifact) throw new Error(`${platform} artifact name is invalid`);
  const file = path.join(path.dirname(files[0]), name);
  const data = await readFile(file);
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (data.length !== metadata.bytes || sha256 !== metadata.sha256) throw new Error(`${platform} artifact digest mismatch`);
  return { name, file, sha256 };
}

const items = [
  await checkedArtifact(macRoot, 'darwin', 'arm64', `AgentLink-${version}-mac-arm64.dmg`),
  await checkedArtifact(windowsRoot, 'win32', 'x64', `AgentLink-Setup-${version}-windows-x64.exe`),
];
if (new Set(items.map(item => item.name)).size !== items.length) throw new Error('Duplicate release asset name');
await mkdir(output, { recursive: true });
for (const item of items) await copyFile(item.file, path.join(output, item.name), constants.COPYFILE_EXCL);
await writeFile(path.join(output, 'SHA256SUMS.txt'), items.map(item => `${item.sha256}  ${item.name}`).join('\n') + '\n', { flag: 'wx' });
console.log(JSON.stringify({ version, assets: items.map(({ name, sha256 }) => ({ name, sha256 })) }, null, 2));
