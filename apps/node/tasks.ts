import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LinkError } from '../../packages/protocol/index.js';

export interface TaskInput { key: string; command: string; cwd: string; timeout: number }
export interface TaskResult { exit_code: number; stdout: string; stderr: string; duration: number }
type Event = { type: string; at: string; [key: string]: unknown };
type Runner = (input: TaskInput, signal: AbortSignal, output: (stream: string, text: string) => void) => Promise<TaskResult>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

// Append-only journal: no automatic retry, pruning or deletion of task records.
// One Node owns this directory. Port binding/supervision prevents concurrent owners.
export class TaskStore {
  // Parsed journals are cached per task and extended from the byte offset already consumed.
  // Without this, every status poll re-read and re-parsed the whole journal (O(n) per poll).
  static readonly CACHE_LIMIT = 4 * 1024 * 1024;
  private active = new Map<string, AbortController>();
  private cache = new Map<string, { consumed: number; events: Event[] }>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private degraded: string | null = null;
  readonly stats = { full_reads: 0, incremental_reads: 0, cached_reads: 0 };
  constructor(private directory: string, private runner: Runner) {}
  get health() {
    return { closed: this.closed, degraded: this.degraded, active: this.active.size,
      cached_tasks: this.cache.size, stats: { ...this.stats } };
  }
  private file(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new LinkError('INVALID_REQUEST');
    return path.join(this.directory, id + '.jsonl');
  }
  private async events(id: string): Promise<Event[]> {
    const file = this.file(id);
    const info = await stat(file);
    if (info.size > 32 * 1024 * 1024) throw new LinkError('INVALID_REQUEST', 'Task journal exceeds read limit');
    const cached = this.cache.get(id);
    if (cached && info.size === cached.consumed) { this.stats.cached_reads++; return cached.events; }
    if (cached && info.size > cached.consumed && info.size <= TaskStore.CACHE_LIMIT) {
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(info.size - cached.consumed);
        await handle.read(buffer, 0, buffer.length, cached.consumed);
        const text = buffer.toString('utf8');
        // Only complete lines are consumed; a half-written line is picked up next time.
        const complete = text.slice(0, text.lastIndexOf('\n') + 1);
        if (complete) {
          const added = complete.split('\n').filter(Boolean).map(line => JSON.parse(line) as Event);
          const events = [...cached.events, ...added];
          this.cache.set(id, { consumed: cached.consumed + Buffer.byteLength(complete), events });
          this.stats.incremental_reads++;
          return events;
        }
      } finally { await handle.close(); }
    }
    let text = await readFile(file, 'utf8');
    if (!text.endsWith('\n') && this.active.has(id)) text = text.slice(0, text.lastIndexOf('\n') + 1);
    const events = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Event);
    this.stats.full_reads++;
    if (info.size <= TaskStore.CACHE_LIMIT) this.cache.set(id, { consumed: Buffer.byteLength(text), events });
    else this.cache.delete(id);
    return events;
  }
  private async append(id: string, event: Omit<Event, 'at'>) {
    const file = await open(this.file(id), 'a', 0o600);
    try { await file.writeFile(JSON.stringify({ ...event, at: new Date().toISOString() }) + '\n'); await file.sync(); }
    finally { await file.close(); }
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const filename of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.jsonl$/.test(filename)) continue;
      const id = filename.slice(0, -6);
      // Corrupt journals fail closed. They are retained for operator diagnosis.
      const events = await this.events(id);
      const last = events.at(-1)?.type;
      if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(last ?? ''))
        await this.append(id, { type: 'interrupted', reason: 'Node restarted; prior execution outcome is unknown. Do not resubmit automatically.' });
    }
  }
  submit(input: TaskInput) {
    const operation = this.tail.then(() => this.accept(input));
    this.tail = operation.catch(() => {});
    return operation;
  }
  private async accept(input: TaskInput) {
    if (this.closed) throw new LinkError('FORBIDDEN');
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.key) || !input.command || input.command.length > 65536 ||
        input.command.includes('\0') || !Number.isInteger(input.timeout) || input.timeout < 1 || input.timeout > 86400000)
      throw new LinkError('INVALID_REQUEST');
    const id = hash(input.key), fingerprint = hash(JSON.stringify([input.command, input.cwd, input.timeout]));
    try {
      const events = await this.events(id);
      if (events[0]?.fingerprint !== fingerprint) throw new LinkError('CONFLICT', 'Idempotency key already belongs to a different task');
      return { ...await this.get(id), duplicate: true };
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (this.active.size >= 4) throw new LinkError('BUSY', 'Four tasks are already active');
    const file = await open(this.file(id), 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ type: 'accepted', at: new Date().toISOString(), fingerprint, input }) + '\n');
      await file.sync();
    } finally { await file.close(); }
    this.degraded = null;
    const abort = new AbortController();
    this.active.set(id, abort);
    void this.execute(id, input, abort).catch((error: unknown) => {
      // Preserve the journal, but do not silently take the whole task service down for good:
      // record the degradation, stop the running work, and let later submissions try again
      // (they fail loudly if storage is really gone).
      this.degraded = error instanceof Error ? error.message : String(error);
      this.abortAll();
    });
    return { id, status: 'accepted', duplicate: false };
  }
  private async execute(id: string, input: TaskInput, abort: AbortController) {
    let writes: Promise<unknown> = Promise.resolve();
    let storageFailed = false;
    try {
      await this.append(id, { type: 'running' });
      if (abort.signal.aborted) throw new LinkError('PROCESS_FAILED', 'Cancelled before start');
      const result = await this.runner(input, abort.signal, (stream, text) => {
        writes = writes.then(() => this.append(id, { type: 'output', stream, text })).catch(() => {
          storageFailed = true; abort.abort();
        });
      });
      await writes;
      if (storageFailed) throw new Error('Journal write failed');
      await this.append(id, { type: abort.signal.aborted ? 'cancelled' : result.exit_code === 0 ? 'succeeded' : 'failed', exit_code: result.exit_code, duration: result.duration });
    } catch (e) {
      await writes;
      await this.append(id, { type: abort.signal.aborted ? 'cancelled' : 'failed', error_code: (e as LinkError).code ?? 'INTERNAL_ERROR' });
      if (storageFailed) throw new Error('Journal unavailable');
    } finally { this.active.delete(id); }
  }
  async get(id: string) {
    const events = await this.events(id);
    const last = [...events].reverse().find(e => e.type !== 'output');
    const input = events[0]?.input as TaskInput | undefined;
    return { id, status: last?.type ?? 'unknown', created_at: events[0]?.at, updated_at: events.at(-1)?.at,
      cwd: input?.cwd, exit_code: last?.exit_code, error_code: last?.error_code, reason: last?.reason,
      active: this.active.has(id), event_count: events.length };
  }
  async logs(id: string, cursor = 0) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new LinkError('INVALID_REQUEST');
    const events = await this.events(id);
    if (cursor > events.length) throw new LinkError('INVALID_REQUEST', 'Cursor is beyond task log');
    const page: Event[] = []; let size = 0, next = cursor;
    for (; next < events.length; next++) {
      const event = events[next];
      if (event.type !== 'output') continue;
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (page.length && size + bytes > 128 * 1024) break;
      page.push(event); size += bytes;
    }
    return { id, events: page, next_cursor: next, caught_up: next === events.length };
  }
  async cancel(id: string) {
    await this.events(id);
    const abort = this.active.get(id);
    if (abort) abort.abort();
    return { id, cancellation_requested: !!abort };
  }
  private abortAll() { for (const abort of this.active.values()) abort.abort(); }
  stopAll() { this.closed = true; this.abortAll(); }
}
