import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { TaskStore, type TaskInput } from '../apps/node/tasks.js';
import { setTimeout as wait } from 'node:timers/promises';

const input: TaskInput = { key: 'fixture', command: 'echo fixture', cwd: os.tmpdir(), timeout: 2000 };
const terminal = async (store: TaskStore, id: string) => {
  for (let i = 0; i < 200; i++) { const value = await store.get(id); if (['succeeded', 'failed', 'cancelled'].includes(value.status)) return value; await wait(10); }
  assert.fail('Task never finished');
};
test('durable tasks deduplicate concurrent submits, retain logs and survive reopening', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-retained-jobs-'));
  let runs = 0;
  const store = new TaskStore(dir, async (_input, _signal, output) => { runs++; output('stdout', '你好 test'); await wait(30); return { exit_code: 0, stdout: '', stderr: '', duration: 30 }; });
  await store.initialize();
  const results = await Promise.all(Array.from({ length: 8 }, () => store.submit(input)));
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  assert.equal((await terminal(store, results[0].id)).status, 'succeeded');
  assert.equal(runs, 1);
  const logs = await store.logs(results[0].id);
  assert.equal(logs.events[0].text, '你好 test');
  assert.equal((await store.logs(results[0].id, logs.next_cursor)).events.length, 0);
  const reopened = new TaskStore(dir, async () => { assert.fail('Must not execute persisted task'); });
  await reopened.initialize();
  assert.equal((await reopened.submit(input)).duplicate, true);
  await assert.rejects(reopened.submit({ ...input, command: 'different' }), /different task/);
});
test('unfinished journal becomes interrupted, and cancellation never becomes success', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-retained-recovery-'));
  const id = createHash('sha256').update('interrupted').digest('hex');
  const journal = path.join(dir, id + '.jsonl');
  await writeFile(journal, JSON.stringify({ type: 'running', at: new Date().toISOString() }) + '\n', { flag: 'wx' });
  const store = new TaskStore(dir, async (_input, signal) => { while (!signal.aborted) await wait(5); throw new Error('cancelled'); });
  await store.initialize();
  assert.equal((await store.get(id)).status, 'interrupted');
  assert.match(await readFile(journal, 'utf8'), /running/);
  const task = await store.submit(input);
  await store.cancel(task.id);
  assert.equal((await terminal(store, task.id)).status, 'cancelled');
  await assert.rejects(store.get('../escape'));
  await assert.rejects(store.logs(task.id, -1));
});
test('four active task limit and stopped store reject new execution', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlink-retained-limit-'));
  const store = new TaskStore(dir, async (_input, signal) => { while (!signal.aborted) await wait(5); throw Error('cancelled'); });
  await store.initialize();
  const tasks = [];
  for (let i = 0; i < 4; i++) tasks.push(await store.submit({ ...input, key: String(i) }));
  await assert.rejects(store.submit({ ...input, key: 'fifth' }), /Four tasks/);
  store.stopAll();
  for (const t of tasks) assert.equal((await terminal(store, t.id)).status, 'cancelled');
  await assert.rejects(store.submit({ ...input, key: 'later' }), /FORBIDDEN/);
});
