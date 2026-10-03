import {mkdir, readdir, stat, cp, rename, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

// Report failures as a message, not a stack trace: this is a user-facing command.
process.on('uncaughtException', error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });

// Installs the packaged app. Nothing is ever deleted: an existing app is renamed aside,
// and uninstalling moves the app to a dated folder instead of removing it.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const flag = (key, fallback) => { const index = args.indexOf(key); return index >= 0 ? args[index + 1] : fallback; };

async function newestApp() {
  const directory = path.join(root, 'build');
  const entries = await readdir(directory).catch(() => []);
  const candidates = [];
  for (const name of entries) {
    if (!name.startsWith('AgentLink') || !name.endsWith('.app')) continue;
    const info = await stat(path.join(directory, name));
    candidates.push({ path: path.join(directory, name), modified: info.mtimeMs });
  }
  candidates.sort((left, right) => right.modified - left.modified);
  return candidates[0]?.path ?? null;
}

const targetDirectory = path.resolve(flag('--to', path.join(os.homedir(), 'Applications')));
const target = path.join(targetDirectory, 'AgentLink.app');
const installed = existsSync(path.join(target, 'Contents', 'Resources', 'runtime', 'dist', 'apps', 'runtime', 'cli.js'));

if (args.includes('--uninstall')) {
  if (!existsSync(target)) { console.log('未安装到 ' + target + '，无需卸载。'); process.exit(0); }
  const removed = path.join(os.homedir(), 'Library', 'Application Support', 'AgentLink', 'removed');
  await mkdir(removed, { recursive: true, mode: 0o700 });
  const destination = path.join(removed, 'AgentLink-' + new Date().toISOString().replace(/[:.]/g, '-') + '.app');
  await rename(target, destination);
  console.log(JSON.stringify({ uninstalled: true, moved_to: destination,
    note: '应用已被移到上面的目录，没有删除。后台服务与配对信息保持不变，需要时请手动停止 LaunchAgent。' }, null, 2));
  process.exit(0);
}

const source = path.resolve(flag('--source', await newestApp() ?? ''));
if (!source || !existsSync(source)) throw Error('找不到已打包的 App。先运行：node scripts/package-mac-app.mjs "build/AgentLink 0.2.0.app"');
const runtime = path.join(source, 'Contents', 'Resources', 'runtime', 'dist', 'apps', 'runtime', 'cli.js');
if (!existsSync(runtime)) throw Error('这个 App 不是自包含包（缺少内嵌运行时）。请用 scripts/package-mac-app.mjs 打包。');

await mkdir(targetDirectory, { recursive: true });
let backup = null;
if (existsSync(target)) {
  if (!args.includes('--upgrade')) throw Error('目标已存在，已保留：' + target + '（加 --upgrade 会在保留备份后替换）');
  backup = target + '.before-upgrade-' + new Date().toISOString().replace(/[:.]/g, '-');
  await rename(target, backup);
}
await cp(source, target, { recursive: true });
console.log(JSON.stringify({ installed: target, replaced_backup: backup, source,
  next_steps: ['打开 ' + target, '在 App 里点「修复并启动后台服务」安装/启动登录自启', '需要卸载时运行本脚本加 --uninstall（只会移动，不会删除）'] }, null, 2));
