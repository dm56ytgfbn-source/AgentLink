import os from 'node:os';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Central path resolution. No module may hardcode a user name, a drive letter or a
// repository location: everything derives from AGENTLINK_HOME (or the platform default)
// plus an optional source/distribution root used only for read-only bundled resources.
export const product = {name:'AgentLink', bundleId:'local.agentlink', protocolVersion:3} as const;

export interface ConfigSources { env?:NodeJS.ProcessEnv; home?:string; sourceRoot?:string }

export interface Paths {
  home:string; configDir:string; stateDir:string; logDir:string; certDir:string; tasksDir:string;
  registry:string; bridge:string; httpToken:string; guide:string;
  sourceRoot:string; legacyRegistries:string[];
}

export function defaultHome(env:NodeJS.ProcessEnv = process.env):string {
  const explicit = env.AGENTLINK_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  if (process.platform === 'win32') {
    const base = env.APPDATA?.trim() || env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'AgentLink');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'AgentLink');
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(base, 'agentlink');
}

function defaultSourceRoot():string {
  // dist/packages/config/index.js -> repository or installed release root
  return fileURLToPath(new URL('../../../', import.meta.url));
}

export function resolvePaths(sources:ConfigSources = {}):Paths {
  const env = sources.env ?? process.env;
  const home = path.resolve(sources.home ?? defaultHome(env));
  const sourceRoot = path.resolve(sources.sourceRoot ?? defaultSourceRoot());
  const configDir = path.join(home, 'config');
  return {
    home, configDir,
    stateDir: path.join(home, 'state'),
    logDir: path.join(home, 'logs'),
    certDir: path.join(configDir, 'certificates'),
    tasksDir: path.join(home, 'tasks'),
    registry: path.join(configDir, 'runtime.local.json'),
    bridge: path.join(configDir, 'bridge.local.json'),
    httpToken: path.join(configDir, 'agent-http.local.json'),
    guide: path.join(home, 'AGENT-GUIDE.md'),
    sourceRoot,
    legacyRegistries: [path.join(sourceRoot, 'runtime.local.json')],
  };
}

// Reading prefers an explicit path, then AGENTLINK_CONFIG, then the canonical installed
// registry, then a development-tree registry. Writing never targets the development tree.
export function registryForRead(paths:Paths, explicit?:string, env:NodeJS.ProcessEnv = process.env):string {
  if (explicit) return path.resolve(explicit);
  const fromEnv = env.AGENTLINK_CONFIG?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  if (existsSync(paths.registry)) return paths.registry;
  for (const candidate of paths.legacyRegistries) if (existsSync(candidate)) return path.resolve(candidate);
  return paths.registry;
}

export function registryForWrite(paths:Paths, explicit?:string, env:NodeJS.ProcessEnv = process.env):string {
  if (explicit) return path.resolve(explicit);
  const fromEnv = env.AGENTLINK_CONFIG?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return paths.registry;
}

export function bridgeForRead(paths:Paths, explicit?:string, env:NodeJS.ProcessEnv = process.env):string {
  if (explicit) return path.resolve(explicit);
  const fromEnv = env.AGENTLINK_BRIDGE_CONFIG?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  if (existsSync(paths.bridge)) return paths.bridge;
  const legacy = path.join(paths.sourceRoot, 'bridge.local.json');
  return existsSync(legacy) ? legacy : paths.bridge;
}

// Per-session agent context lives in the state directory, never beside credentials.
export function contextStateFile(paths:Paths, session:string):string {
  return path.join(paths.stateDir, 'context', session + '.json');
}

export function describePaths(paths:Paths) {
  return {home:paths.home, config:paths.configDir, state:paths.stateDir, registry:paths.registry,
    registry_in_use:registryForRead(paths), source_root:paths.sourceRoot};
}
