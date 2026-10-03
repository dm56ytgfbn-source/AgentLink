import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// cmd.exe misparses batch files that contain non-ASCII bytes once the code page is switched to
// UTF-8, and then silently skips the lines after the bad one — which once produced a service
// that looked started but never ran. Every message therefore lives in Node, and this keeps the
// batch files ASCII so that cannot come back.
const templates = fileURLToPath(new URL('../../scripts/windows-package/', import.meta.url));

test('Windows 批处理全是纯 ASCII，且都使用包内自带的 node', async () => {
  const names = (await readdir(templates)).filter(name => name.endsWith('.cmd'));
  assert.ok(names.length >= 5, '批处理数量不对: ' + names.length);
  for (const name of names) {
    const text = await readFile(path.join(templates, name), 'utf8');
    const offending = [...text].filter(character => character.charCodeAt(0) > 127);
    assert.equal(offending.length, 0, name + ' 含非 ASCII 字符: ' + offending.slice(0, 5).join(''));
    assert.match(text, /node\.exe/, name + ' 没有优先使用包内自带的 node');
  }
});

test('安装说明不再要求对方安装 Node.js', async () => {
  const text = await readFile(path.join(templates, '安装说明.txt'), 'utf8');
  assert.match(text, /不需要装任何东西|自带 Node/);
});
