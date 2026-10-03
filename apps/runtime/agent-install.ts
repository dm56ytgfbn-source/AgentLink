import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolvePaths, registryForRead, type Paths } from '../../packages/config/index.js';

// Agent-neutral registration. AgentLink is the product; Codex is only one possible client.
// Every adapter is additive and idempotent: it never removes other servers, never rewrites
// unrelated settings, and always takes a timestamped backup before touching a real file.

export interface McpEntry { command:string; args:string[]; env:Record<string,string> }
export interface InstallContext { paths:Paths; name:string; session:string; workdir:string; entry:McpEntry }
export interface Plan { target:string; label:string; scope:'user'|'project'; format:'json'|'toml'; file:string;
  action:'create'|'merge'|'unchanged'; before:string; after:string; snippet:string }

export function mcpServerPath():string {
  return fileURLToPath(new URL('./mcp.js', import.meta.url));
}

export function buildEntry(context:{registry:string; session:string; name:string}, nodeExecutable = process.execPath):McpEntry {
  return {
    command: nodeExecutable,
    args: [mcpServerPath()],
    env: { AGENTLINK_CONFIG: context.registry, AGENTLINK_SESSION: context.session },
  };
}

export function entrySnippet(entry:McpEntry) {
  return { mcpServers: { agentlink: entry } };
}

interface Target {
  id:string; label:string; scope:'user'|'project'; format:'json'|'toml'; containers:string[];
  resolve(context:InstallContext):string;
}

function home(...parts:string[]) { return path.join(os.homedir(), ...parts); }

export const targets:Target[] = [
  { id:'codex', label:'Codex CLI (~/.codex/config.toml)', scope:'user', format:'toml', containers:[],
    resolve:() => home('.codex', 'config.toml') },
  { id:'claude-desktop', label:'Claude Desktop', scope:'user', format:'json', containers:['mcpServers'],
    resolve:() => process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? home('AppData','Roaming'), 'Claude', 'claude_desktop_config.json')
      : home('Library', 'Application Support', 'Claude', 'claude_desktop_config.json') },
  { id:'cursor', label:'Cursor (~/.cursor/mcp.json)', scope:'user', format:'json', containers:['mcpServers'],
    resolve:() => home('.cursor', 'mcp.json') },
  { id:'claude-code', label:'Claude Code (project .mcp.json)', scope:'project', format:'json', containers:['mcpServers'],
    resolve:(context) => path.join(context.workdir, '.mcp.json') },
  { id:'vscode', label:'VS Code (project .vscode/mcp.json)', scope:'project', format:'json', containers:['servers'],
    resolve:(context) => path.join(context.workdir, '.vscode', 'mcp.json') },
  { id:'generic', label:'Any other MCP client (prints a snippet)', scope:'user', format:'json', containers:['mcpServers'],
    resolve:(context) => path.join(context.paths.home, 'agents', 'agentlink-mcp.json') },
];

export function findTarget(id:string):Target {
  const target = targets.find(candidate => candidate.id === id);
  if (!target) throw new Error('Unknown agent target: ' + id + ' (try: ' + targets.map(t => t.id).join(', ') + ')');
  return target;
}

function mergeJsonObject(before:string, context:InstallContext, target:Target, name:string, entry:McpEntry):{action:Plan['action']; after:string} {
  let root:Record<string, unknown> = {};
  if (before.trim()) {
    const parsed:unknown = JSON.parse(before);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Existing configuration is not a JSON object: ' + target.id);
    root = parsed as Record<string, unknown>;
  }
  const containerKey = target.containers[0];
  const container = root[containerKey];
  if (container !== undefined && (!container || typeof container !== 'object' || Array.isArray(container))) throw new Error('Existing "' + containerKey + '" is not an object; refusing to overwrite: ' + target.id);
  const servers = (container ?? {}) as Record<string, unknown>;
  const existing = servers[name];
  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) return { action:'unchanged', after: before.trim() ? before : JSON.stringify(root, null, 2) + '\n' };
  servers[name] = entry;
  root[containerKey] = servers;
  return { action: before.trim() ? 'merge' : 'create', after: JSON.stringify(root, null, 2) + '\n' };
}

function escapeToml(value:string) { return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'; }

export function renderTomlBlock(name:string, entry:McpEntry):string {
  const lines = ['[mcp_servers.' + name + ']', 'command = ' + escapeToml(entry.command), 'args = [' + entry.args.map(escapeToml).join(', ') + ']'];
  const envKeys = Object.keys(entry.env);
  if (envKeys.length) {
    lines.push('', '[mcp_servers.' + name + '.env]');
    for (const key of envKeys) lines.push(key + ' = ' + escapeToml(entry.env[key]));
  }
  return lines.join('\n') + '\n';
}

function mergeToml(before:string, name:string, entry:McpEntry):{action:Plan['action']; after:string} {
  const block = renderTomlBlock(name, entry);
  const header = '[mcp_servers.' + name + ']';
  const lines = before.split('\n');
  const start = lines.findIndex(line => line.trim() === header);
  if (start < 0) {
    if (before.trim() && !before.endsWith('\n')) before += '\n';
    const separator = before.trim() ? '\n' : '';
    return { action: before.trim() ? 'merge' : 'create', after: before + separator + block };
  }
  // Replace exactly our own tables ([mcp_servers.<name>] and [mcp_servers.<name>.env]),
  // stopping at the next unrelated table header so other settings stay untouched.
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('[') && !trimmed.startsWith('[mcp_servers.' + name)) { end = index; break; }
  }
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  const replacement = block.trimEnd().split('\n');
  const merged = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
  const after = merged.join('\n');
  const normalized = after.endsWith('\n') ? after : after + '\n';
  return { action: normalized === before ? 'unchanged' : 'merge', after: normalized };
}

export async function planInstall(targetId:string, context:InstallContext):Promise<Plan> {
  const target = findTarget(targetId);
  const file = target.resolve(context);
  let before = '';
  try { before = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const result = target.format === 'json'
    ? mergeJsonObject(before, context, target, context.name, context.entry)
    : mergeToml(before, context.name, context.entry);
  const snippet = target.format === 'json'
    ? JSON.stringify({ [target.containers[0]]: { [context.name]: context.entry } }, null, 2)
    : renderTomlBlock(context.name, context.entry).trimEnd();
  return { target:target.id, label:target.label, scope:target.scope, format:target.format, file,
    action: result.action, before, after: result.after, snippet };
}

export async function applyPlan(plan:Plan):Promise<{file:string; action:Plan['action']; backup:string|null}> {
  if (plan.action === 'unchanged') return { file:plan.file, action:plan.action, backup:null };
  await mkdir(path.dirname(plan.file), { recursive:true, mode:0o700 });
  let backup:string|null = null;
  if (existsSync(plan.file)) {
    backup = plan.file + '.agentlink-backup-' + new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(plan.file, backup);
  }
  const staging = plan.file + '.agentlink-next-' + randomBytes(6).toString('hex');
  await writeFile(staging, plan.after, { mode:0o600, flag:'wx' });
  const { rename } = await import('node:fs/promises');
  await rename(staging, plan.file);
  return { file:plan.file, action:plan.action, backup };
}

export function guidePath(paths:Paths):string {
  if (existsSync(paths.guide)) return paths.guide;
  const bundled = path.join(paths.sourceRoot, 'agents', 'AGENT-GUIDE.md');
  return existsSync(bundled) ? bundled : paths.guide;
}

export async function installGuide(paths:Paths):Promise<{file:string; bytes:number}> {
  const source = guidePath(paths);
  const text = await readFile(source, 'utf8');
  await mkdir(paths.home, { recursive:true, mode:0o700 });
  if (path.resolve(source) !== path.resolve(paths.guide)) await writeFile(paths.guide, text, { mode:0o600 });
  return { file: paths.guide, bytes: Buffer.byteLength(text) };
}

export function installContext(options:{paths?:Paths; name?:string; session?:string; workdir?:string; nodeExecutable?:string} = {}):InstallContext {
  const paths = options.paths ?? resolvePaths();
  const registry = registryForRead(paths);
  const name = options.name ?? 'agentlink';
  const session = options.session ?? 'agentlink-' + name;
  return { paths, name, session, workdir: path.resolve(options.workdir ?? process.cwd()),
    entry: buildEntry({ registry, session, name }, options.nodeExecutable ?? process.execPath) };
}

export async function installedSummary(context:InstallContext) {
  const rows = [];
  for (const target of targets) {
    const file = target.resolve(context);
    let present = false;
    let ours = false;
    try {
      const text = await stat(file);
      present = text.isFile();
      if (present && target.format === 'json') ours = text.isFile() && (await readFile(file, 'utf8')).includes('agentlink');
      if (present && target.format === 'toml') ours = (await readFile(file, 'utf8')).includes('[mcp_servers.' + context.name + ']');
    } catch { present = false; }
    rows.push({ target:target.id, label:target.label, file, exists:present, registered:ours });
  }
  return rows;
}
