import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const commit = '1'.repeat(40);
async function fixture(change = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'agentlink-release-check-'));
  for (const [folder, platform, architecture, artifact] of [
    ['mac', 'darwin', 'arm64', `AgentLink-${version}-mac-arm64.dmg`],
    ['windows', 'win32', 'x64', `AgentLink-Setup-${version}-windows-x64.exe`],
  ]) {
    const dir = path.join(base, folder);
    await mkdir(dir);
    const data = Buffer.from(`test fixture ${platform}`);
    await writeFile(path.join(dir, artifact), data);
    await writeFile(path.join(dir, 'RELEASE.json'), JSON.stringify({ version, platform, architecture,
      artifact, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'),
      source_commit: commit, source_dirty: false, ...(folder === 'windows' ? change : {}) }));
  }
  return base;
}
function prepare(base, tag = `v${version}`) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/prepare-release-assets.mjs'),
    path.join(base, 'mac'), path.join(base, 'windows'), path.join(base, 'out'), tag],
  { encoding: 'utf8', env: { ...process.env, GITHUB_SHA: commit } });
}

test('release copies verified installers and refuses overwriting an existing output', async () => {
  const base = await fixture();
  assert.equal(prepare(base).status, 0);
  const before = await readFile(path.join(base, 'out', 'SHA256SUMS.txt'), 'utf8');
  assert.match(before, /windows-x64\.exe/);
  assert.match(before, /mac-arm64\.dmg/);
  assert.notEqual(prepare(base).status, 0);
  assert.equal(await readFile(path.join(base, 'out', 'SHA256SUMS.txt'), 'utf8'), before);
});

test('release rejects corrupted, mismatched or untraceable installers', async () => {
  for (const change of [{ sha256: '0'.repeat(64) }, { bytes: 0 }, { architecture: 'arm64' },
    { version: 'old' }, { source_commit: '2'.repeat(40) }, { source_dirty: true },
    { artifact: '../outside.exe' }]) {
    const result = prepare(await fixture(change));
    assert.notEqual(result.status, 0, JSON.stringify(change));
  }
  assert.notEqual(prepare(await fixture(), 'v-wrong').status, 0);
});
// Keep fixtures for inspection; no cleanup touches user files.
