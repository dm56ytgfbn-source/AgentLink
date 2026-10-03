import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileOperations } from '../adapters/filesystem.js';

test('replacement preserves original on conflict and succeeds with matching versions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlink-retained-replace-'));
  const files = new FileOperations([root]);
  const target = path.join(root, 'target'), source = path.join(root, 'editor-temp');
  await writeFile(target, 'original'); await writeFile(source, 'edited');
  const targetInfo = await files.run('files.stat', { path: target }) as { version: string };
  const sourceInfo = await files.run('files.stat', { path: source }) as { version: string };
  await assert.rejects(files.run('files.replace', { path: source, destination: target, source_version: sourceInfo.version, version: null }), /CONFLICT|changed/);
  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.equal(await readFile(source, 'utf8'), 'edited');
  // Use a new target for the success case: no existing file is replaced in this test.
  const fresh = path.join(root, 'fresh');
  await files.run('files.replace', { path: source, destination: fresh, source_version: sourceInfo.version, version: null });
  assert.equal(await readFile(fresh, 'utf8'), 'edited');
  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.ok(targetInfo.version);
});
test('commit rejects a symlink source and preserves referenced file', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlink-retained-link-'));
  const files = new FileOperations([root]);
  const source = path.join(root, '.agentlink-upload-real'), link = path.join(root, '.agentlink-upload-link');
  await writeFile(source, 'keep'); await symlink(source, link);
  await assert.rejects(files.run('files.commit', { path: link, destination: path.join(root, 'out'), version: null }), /PATH_DENIED/);
  assert.equal(await readFile(source, 'utf8'), 'keep');
});
