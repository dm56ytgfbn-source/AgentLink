import {appendFile, mkdir, rename, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

// Audit records are evidence, not a debugging log:
//  - read-only health probes are NOT recorded by default (the supervisor probes every few
//    seconds; recording them produced tens of thousands of useless lines per day),
//  - command text is stored as a masked preview plus a hash, not verbatim,
//  - the file is sealed into a segment when it grows, and NOTHING is ever deleted.

export interface AuditOptions {
  file:string;
  maxBytes?:number;
  includeHealth?:boolean;
  fullCommand?:boolean;
  now?:() => Date;
}

const SECRET_KEY = /(token|password|passwd|secret|apikey|api_key|credential|bearer)/i;
const OPAQUE = /[A-Za-z0-9+/=_-]{32,}/g;

export function maskSecrets(text:string):string {
  return text
    .replace(/([A-Za-z0-9_.-]*(?:token|password|passwd|secret|apikey|api_key|credential)[A-Za-z0-9_.-]*\s*[=:]\s*)("?)([^\s"']+)\2/gi,
      (_match, prefix:string) => prefix + '"<masked>"')
    .replace(/(-p|--password|-Password)\s+("?)([^\s"']+)\2/gi, (_match, flag:string) => flag + ' <masked>')
    .replace(OPAQUE, match => '<masked:' + match.length + '>');
}

export function redactCommand(command:unknown, fullCommand:boolean) {
  if (typeof command !== 'string') return command;
  const digest = createHash('sha256').update(command).digest('hex');
  if (fullCommand) return { value:command, length:command.length, sha256:digest };
  return { preview:maskSecrets(command).slice(0, 160), length:command.length, sha256:digest, masked:true };
}

export function redactDetail(detail:unknown, fullCommand:boolean):unknown {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return detail;
  const source = detail as Record<string, unknown>;
  const output:Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key === 'command') { output.command = redactCommand(value, fullCommand); continue; }
    if (typeof value === 'string' && SECRET_KEY.test(key)) { output[key] = '<masked>'; continue; }
    output[key] = value;
  }
  return output;
}

export class AuditLog {
  private file:string;
  private maxBytes:number;
  private includeHealth:boolean;
  private fullCommand:boolean;
  private now:() => Date;
  private tail:Promise<unknown> = Promise.resolve();

  constructor(options:AuditOptions) {
    this.file = options.file;
    this.maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : 8 * 1024 * 1024;
    this.includeHealth = options.includeHealth === true;
    this.fullCommand = options.fullCommand === true;
    this.now = options.now ?? (() => new Date());
  }

  get options(){ return { file:this.file, maxBytes:this.maxBytes, includeHealth:this.includeHealth, fullCommand:this.fullCommand }; }

  async initialize(){ await mkdir(path.dirname(this.file), { recursive:true, mode:0o700 }); await appendFile(this.file, '', { mode:0o600 }); }

  record(entry:{ source?:string; target?:string; id?:string; operation:string; detail?:unknown; result:string; duration?:number }) {
    if (!this.includeHealth && (entry.operation === '/info' || entry.operation === 'health')) return Promise.resolve(false);
    const line = JSON.stringify({
      timestamp:this.now().toISOString(),
      source:entry.source, target:entry.target, id:entry.id,
      operation:entry.operation,
      detail:redactDetail(entry.detail, this.fullCommand),
      result:entry.result, duration:entry.duration,
    }) + '\n';
    const operation = this.tail.then(() => this.append(line));
    this.tail = operation.catch(() => {});
    return operation.then(() => true, () => { throw new Error('AUDIT_WRITE_FAILED'); });
  }

  private async append(line:string) {
    await this.sealIfNeeded();
    await appendFile(this.file, line, { mode:0o600 });
  }

  // Sealing renames the active file; segments accumulate and are never pruned automatically.
  private async sealIfNeeded() {
    const info = await stat(this.file).catch(() => null);
    if (!info || info.size < this.maxBytes) return null;
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const sealed = path.join(path.dirname(this.file), 'audit-' + stamp + '.jsonl');
    await rename(this.file, sealed);
    await appendFile(this.file, '', { mode:0o600 });
    return sealed;
  }

  async flush(){ await this.tail.catch(() => {}); }
}
