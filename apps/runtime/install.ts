import {readFile,writeFile,mkdir,cp,readdir,stat,rename,copyFile,chmod,rm} from 'node:fs/promises';
import {existsSync,constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {resolvePaths,registryForRead,type Paths} from '../../packages/config/index.js';

// Convergence: one product, one install location. Historically the same runtime existed as a
// source tree, one or more "releases" copies and a plugin launcher, each pinned to different
// paths, so fixing code in one place changed nothing in daily use. This module discovers the
// divergence, proposes minimal actions and applies them with backups. It never deletes.

const exec = promisify(execFile);

export interface Release { path:string; version:string; modified:string }
// "managed" means this LaunchAgent actually runs the AgentLink supervisor. Other
// agentlink-named agents (for example a viewer helper) must never be rewritten by us.
export interface LaunchAgent { label:string; file:string; program:string|null; args:string[]; runtime_root:string|null; config:string|null; managed:boolean }
export interface PluginLink { file:string; runtime_root:string|null; config:string|null; canonical:boolean }
export interface Discovery {
  generated_at:string; runtime_root:string; version:string; home:string; node:string;
  releases:Release[];
  launch_agents:LaunchAgent[];
  plugins:PluginLink[];
  registry:{ file:string; exists:boolean; symlink_target:string|null; devices:number|null; error:string|null };
}

export interface InstallAction {
  id:string; kind:'create-release'|'update-launch-agent'|'update-plugin'|'build-mount-helper'|'none';
  description:string; file:string|null; will_change:boolean; detail?:Record<string,unknown>;
}

function mcpPath(root:string) { return path.join(root, 'dist', 'apps', 'runtime', 'mcp.js'); }

export function runtimeRootFromMcpPath(candidate:string):string|null {
  const normalized = candidate.replace(/\\/g, '/');
  const marker = '/dist/apps/runtime/mcp.js';
  return normalized.endsWith(marker) ? normalized.slice(0, -marker.length) : null;
}

export function parseLaunchAgentPlist(text:string, file:string):{ label:string; program:string|null; args:string[] } {
  // plutil (JSON) is preferred; this XML parser is the portable fallback and the test fixture.
  // Both must agree: program is the first ProgramArguments entry, args are the rest.
  const labelMatch = text.match(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/);
  const label = labelMatch ? labelMatch[1] : path.basename(file).replace(/\.plist$/, '');
  const arrayMatch = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  const strings = arrayMatch ? [...arrayMatch[1].matchAll(/<string>([^<]*)<\/string>/g)].map(match => match[1]) : [];
  return { label, program: strings[0] ?? null, args: strings.slice(1) };
}

export function parsePluginLauncher(text:string) {
  const mcp = [...text.matchAll(/"([^"]+)"/g)]
    .map(match => match[1]).find(candidate => runtimeRootFromMcpPath(candidate) !== null);
  const config = text.match(/AGENTLINK_CONFIG[:=]"?'?\$?\{?[A-Z_]*:?-?([^"\n' }]+)/);
  return { runtime_root: mcp ? runtimeRootFromMcpPath(mcp) : null,
    config: config && config[1].startsWith('/') ? config[1] : null };
}

export interface DiscoverySources { paths?:Paths; releasesDir?:string; launchAgentsDir?:string; pluginsDir?:string; pluginDirs?:string[]; now?:()=>Date }

export async function discover(sources:DiscoverySources = {}):Promise<Discovery> {
  const paths = sources.paths ?? resolvePaths();
  const releasesDir = sources.releasesDir ?? path.join(paths.home, 'releases');
  const launchAgentsDir = sources.launchAgentsDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents');
  const pluginsDir = sources.pluginsDir ?? path.join(os.homedir(), '.agents', 'plugins');
  const now = sources.now ?? (() => new Date());

  const releases:Release[] = [];
  try {
    for (const entry of await readdir(releasesDir)) {
      const full = path.join(releasesDir, entry);
      const info = await stat(full).catch(() => null);
      if (!info?.isDirectory() || !existsSync(mcpPath(full))) continue;
      releases.push({ path:full, version:entry, modified:info.mtime.toISOString() });
    }
    releases.sort((left, right) => right.modified.localeCompare(left.modified));
  } catch { /* no releases yet */ }

  const version = await readFile(path.join(paths.sourceRoot, 'package.json'), 'utf8')
    .then(text => (JSON.parse(text) as {version?:string}).version ?? '0.0.0').catch(() => '0.0.0');
  const node = process.execPath;

  const launch_agents:LaunchAgent[] = [];
  try {
    for (const entry of (await readdir(launchAgentsDir)).filter(name => name.toLowerCase().includes('agentlink') && name.endsWith('.plist')).sort()) {
      const file = path.join(launchAgentsDir, entry);
      const text = await readFile(file, 'utf8').catch(() => '');
      let parsed:ReturnType<typeof parseLaunchAgentPlist> | null = null;
      try {
        const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeout:5000 });
        const json = JSON.parse(stdout) as { Label?:string; ProgramArguments?:string[] };
        parsed = { label:json.Label ?? entry, program:json.ProgramArguments?.[0] ?? null, args:json.ProgramArguments?.slice(1) ?? [] };
      } catch { parsed = parseLaunchAgentPlist(text, file); }
      const supervisorArg = parsed.args.find(argument => argument.endsWith('mac-supervisor.mjs')) ?? null;
      // <release>/scripts/mac-supervisor.mjs -> <release>
      const runtime_root = supervisorArg ? path.dirname(path.dirname(supervisorArg)) : null;
      const config = parsed.args.find(argument => argument.endsWith('runtime.local.json')) ?? null;
      launch_agents.push({ label:parsed.label, file, program:parsed.program, args:parsed.args,
        runtime_root, config, managed:supervisorArg !== null });
    }
  } catch { /* no launch agents directory */ }

  const plugins:PluginLink[] = [];
  const seen = new Set<string>();
  // Agent clients keep their registrations in different places; scan the known ones instead
  // of assuming a single layout.
  for (const directory of sources.pluginDirs ?? [pluginsDir, path.join(os.homedir(), 'plugins')]) {
    try {
      for (const name of (await readdir(directory)).sort()) {
        const launcher = path.join(directory, name, 'scripts', 'launch-agentlink-mcp');
        if (!existsSync(launcher) || seen.has(launcher)) continue;
        seen.add(launcher);
        const parsed = parsePluginLauncher(await readFile(launcher, 'utf8').catch(() => ''));
        plugins.push({ file:launcher, runtime_root:parsed.runtime_root, config:parsed.config, canonical:false });
      }
    } catch { /* directory absent */ }
  }

  const registryFile = registryForRead(paths);
  let symlinkTarget:string|null = null;
  try {
    const info = await stat(registryFile);
    if (info.isSymbolicLink?.()) symlinkTarget = await readlinkSafe(registryFile);
  } catch { /* missing */ }
  let devices:number|null = null;
  let error:string|null = null;
  try {
    const parsed = JSON.parse(await readFile(registryFile, 'utf8')) as { devices?:unknown[] };
    devices = Array.isArray(parsed.devices) ? parsed.devices.length : 0;
  } catch (caught) { error = (caught as NodeJS.ErrnoException).code ?? 'UNREADABLE'; }

  return { generated_at:now().toISOString(), runtime_root:paths.sourceRoot, version, home:paths.home, node,
    releases, launch_agents, plugins,
    registry:{ file:registryFile, exists:devices !== null, symlink_target:symlinkTarget, devices, error } };
}

async function readlinkSafe(file:string):Promise<string|null> {
  try { const { readlink } = await import('node:fs/promises'); return await readlink(file); } catch { return null; }
}

export function canonicalReleasePath(discovery:Discovery, now:Date, suffix?:string) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 15);
  return path.join(discovery.home, 'releases', discovery.version + '-' + (suffix ?? 'converged-' + stamp));
}

export function buildInstallPlan(discovery:Discovery, options:{ release?:string; launchAgent?:boolean; plugin?:boolean } = {}):InstallAction[] {
  const actions:InstallAction[] = [];
  const release = options.release ?? null;
  const samePath = (left:string,right:string) => path.resolve(left).replaceAll('\\','/') === path.resolve(right).replaceAll('\\','/');
  if (release) {
    const exists = existsSync(mcpPath(release));
    actions.push({ id:'release', kind:'create-release', file:release, will_change:!exists,
      description: exists ? 'Release already present; files are left untouched' : 'Copy the current runtime into the canonical release directory',
      detail:{ runtime_root:discovery.runtime_root, version:discovery.version } });
  }
  if (options.launchAgent !== false) {
    for (const agent of discovery.launch_agents.filter(candidate => candidate.managed)) {
      const willChange = agent.runtime_root === null || release === null || !samePath(agent.runtime_root,release);
      actions.push({ id:'agent:' + agent.label, kind:'update-launch-agent', file:agent.file, will_change:willChange,
        description: willChange ? 'Point ' + agent.label + ' at the canonical release (current: ' + (agent.runtime_root ?? 'unknown') + ')' : agent.label + ' already points at the canonical release',
        detail:{ label:agent.label, current:agent.runtime_root, target:release,
          config:discovery.registry.file, previous_config:agent.config } });
    }
  }
  if (options.plugin !== false) {
    for (const plugin of discovery.plugins) {
      const name = path.basename(path.dirname(path.dirname(plugin.file)));
      const willChange = plugin.runtime_root === null || release === null || !samePath(plugin.runtime_root,release);
      actions.push({ id:'plugin:' + name, kind:'update-plugin', file:plugin.file, will_change:willChange,
        description: willChange ? 'Point the ' + name + ' agent registration at the canonical release (current: ' + (plugin.runtime_root ?? 'unknown') + ')' : 'Agent registration for ' + name + ' is already canonical',
        detail:{ current:plugin.runtime_root, target:release,
          config:discovery.registry.file, previous_config:plugin.config } });
    }
  }
  if (!actions.length) actions.push({ id:'none', kind:'none', file:null, will_change:false, description:'Nothing to do' });
  return actions;
}

async function backupFile(file:string):Promise<string> {
  const backup = file + '.agentlink-backup-' + new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(file, backup);
  return backup;
}

async function writeAtomic(file:string, content:string, mode?:number) {
  const staging = file + '.agentlink-next-' + randomBytes(6).toString('hex');
  await writeFile(staging, content, { mode: mode ?? 0o600, flag:'wx' });
  await rename(staging, file);
}

export function launchAgentPlist(input:{ label:string; node:string; release:string; config:string; bridge:string; state:string; mount:string }) {
  const escape = (value:string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const args = [input.node, path.join(input.release, 'scripts', 'mac-supervisor.mjs'), input.config, input.bridge, input.state, input.mount];
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0"><dict><key>Label</key><string>' + escape(input.label) + '</string>'
    + '<key>ProgramArguments</key><array>' + args.map(value => '<string>' + escape(value) + '</string>').join('') + '</array>'
    + '<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>'
    + '<key>WorkingDirectory</key><string>' + escape(input.release) + '</string>'
    + '<key>StandardOutPath</key><string>' + escape(path.join(input.state, 'launch.stdout.log')) + '</string>'
    + '<key>StandardErrorPath</key><string>' + escape(path.join(input.state, 'launch.stderr.log')) + '</string>'
    + '</dict></plist>\n';
}

const COPY_ITEMS = ['dist', 'scripts', 'node_modules', 'package.json', 'agents', 'native', 'bin', 'build/AgentLink Input Preview.app'];

export interface ApplyResult { applied:Array<{ id:string; file:string|null; backup:string|null; commands:string[][] }>; skipped:Array<{ id:string; reason:string }>; warnings:string[] }

export async function applyInstallPlan(discovery:Discovery, plan:InstallAction[], options:{ paths?:Paths; copyItems?:string[]; run?:boolean } = {}):Promise<ApplyResult> {
  const paths = options.paths ?? resolvePaths();
  const result:ApplyResult = { applied:[], skipped:[], warnings:[] };
  const runCommand = async (file:string, args:string[]) => {
    if (options.run === false) return;
    await exec(file, args, { timeout:30000 }).catch(error => { result.warnings.push(file + ' ' + args.join(' ') + ' failed: ' + (error as Error).message); });
  };
  for (const action of plan) {
    if (action.kind === 'none') continue;
    if (!action.will_change) { result.skipped.push({ id:action.id, reason:'already canonical' }); continue; }
    if (action.kind === 'create-release') {
      const release = action.file as string;
      await mkdir(release, { recursive:true, mode:0o700 });
      for (const item of options.copyItems ?? COPY_ITEMS) {
        const source = path.join(discovery.runtime_root, item);
        if (!existsSync(source)) { result.warnings.push('missing in source tree: ' + item); continue; }
        await cp(source, path.join(release, item), { recursive:true, errorOnExist:false, force:true });
      }
      // The mount helper is a small native binary; without it, mounting is unavailable but
      // file transfer over the bridge still works.
      const mountSource = path.join(discovery.runtime_root, 'native', 'Mount.swift');
      const mountTarget = path.join(release, 'native', 'agentlink-mount');
      if (!existsSync(mountTarget) && existsSync(mountSource)) {
        await mkdir(path.dirname(mountTarget), { recursive:true, mode:0o700 });
        await runCommand('swiftc', [mountSource, '-module-cache-path', path.join(paths.stateDir, 'swift-cache'), '-o', mountTarget, '-framework', 'NetFS']);
        if (existsSync(mountTarget)) await chmod(mountTarget, 0o755); else result.warnings.push('mount helper was not built; native mounting will be unavailable in this release');
      }
      result.applied.push({ id:action.id, file:release, backup:null, commands:[] });
      continue;
    }
    if (action.kind === 'update-launch-agent') {
      const detail = action.detail as { label:string; target:string; config:string };
      const file = action.file as string;
      const mount = path.join(discovery.home, 'mount', path.basename(discovery.registry.file).replace('.local.json', ''));
      const plist = launchAgentPlist({ label:detail.label, node:discovery.node, release:detail.target, config:detail.config,
        bridge:path.join(paths.configDir, 'bridge.local.json'), state:paths.stateDir, mount });
      const backup = existsSync(file) ? await backupFile(file) : null;
      await writeAtomic(file, plist, 0o600);
      const domain = 'gui/' + process.getuid?.();
      const commands:string[][] = [
        ['/bin/launchctl', 'bootout', domain, file],
        ['/bin/launchctl', 'bootstrap', domain, file],
      ];
      for (const command of commands) await runCommand(command[0], command.slice(1));
      result.applied.push({ id:action.id, file, backup, commands });
      continue;
    }
    if (action.kind === 'update-plugin') {
      const detail = action.detail as { target:string; config:string };
      const file = action.file as string;
      const original = await readFile(file, 'utf8');
      // Rewrite all three things the launcher pins: the runtime path, the registry it reads
      // (it must not point inside a release copy) and the interpreter.
      let updated = original
        .replace(/\$\{AGENTLINK_CONFIG:-[^}]*\}/g, '${AGENTLINK_CONFIG:-' + detail.config + '}')
        .replace(/AGENTLINK_CONFIG="(?!\$\{)[^"]*"/g, 'AGENTLINK_CONFIG="' + detail.config + '"')
        .replace(/"[^"]*[\\/]dist[\\/]apps[\\/]runtime[\\/]mcp\.js"/g, '"' + mcpPath(detail.target) + '"')
        .replace(/(exec\s+)\S*node\S*/m, '$1' + discovery.node);
      if (updated === original) { result.skipped.push({ id:action.id, reason:'launcher did not reference the expected runtime path' }); continue; }
      const info = await stat(file);
      const backup = await backupFile(file);
      await writeAtomic(file, updated, info.mode & 0o777);
      result.applied.push({ id:action.id, file, backup, commands:[] });
      continue;
    }
  }
  return result;
}

export async function verifyRelease(release:string, node = process.execPath, config?:string) {
  const cli = path.join(release, 'dist', 'apps', 'runtime', 'cli.js');
  if (!existsSync(cli)) return { ok:false, reason:'cli.js missing in ' + release };
  try {
    const environment = { ...process.env };
    if (config) environment.AGENTLINK_CONFIG = config;
    const { stdout } = await exec(node, [cli, 'paths'], { timeout:20000, env:environment });
    const parsed = JSON.parse(stdout) as { home?:string; source_root?:string };
    // macOS /tmp is a symlink to /private/tmp, so a raw string comparison reports a false
    // negative for a release that runs perfectly well. Compare canonical paths.
    const canonical = async (value:string|undefined) => {
      if (!value) return '';
      const { realpath } = await import('node:fs/promises');
      return (await realpath(value).catch(() => value)).replace(/\/+$/, '');
    };
    const expected = await canonical(release);
    const reported = await canonical(parsed.source_root);
    // source_root is the canonical path that was actually verified; release is the path as given.
    return { ok: expected !== '' && expected === reported, home:parsed.home, source_root:reported || parsed.source_root, release:expected, cli };
  } catch (error) { return { ok:false, reason:(error as Error).message, cli }; }
}

export function summarizeDiscovery(discovery:Discovery) {
  const lines:string[] = [];
  lines.push('运行中的代码树: ' + discovery.runtime_root + '  (版本 ' + discovery.version + ')');
  lines.push('安装副本: ' + (discovery.releases.length ? discovery.releases.map(release => release.version).join(', ') : '无'));
  const agents = discovery.launch_agents.map(agent => agent.label + ' → ' + (agent.managed ? (agent.runtime_root ?? '未知') : '不由本工具管理'));
  lines.push('登录自启: ' + (agents.length ? agents.join(' | ') : '无'));
  lines.push('Agent 注册: ' + (discovery.plugins.length
    ? discovery.plugins.map(plugin => path.basename(path.dirname(path.dirname(plugin.file))) + ' → ' + (plugin.runtime_root ?? '未知')).join(' | ') : '无'));
  lines.push('配对信息: ' + discovery.registry.file + (discovery.registry.error ? '（' + discovery.registry.error + '）' : '，' + String(discovery.registry.devices) + ' 台电脑'));
  return lines.join('\n');
}
