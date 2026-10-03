import {cp, mkdir, rm, writeFile, stat, symlink, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

// Builds a disk image people can actually install from: open it, drag AgentLink to
// Applications. The app inside must be a packaged (self-contained) build; a development build
// that points at a source tree is refused, because it would break as soon as it is moved.
if (process.platform !== 'darwin') throw Error('macOS is required');

process.on('uncaughtException', error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const flag = (key, fallback) => { const index = args.indexOf(key); return index >= 0 ? args[index + 1] : fallback; };

async function newestPackagedApp() {
  const directory = path.join(root, 'build');
  const entries = await readdir(directory).catch(() => []);
  const candidates = [];
  for (const name of entries) {
    if (!name.startsWith('AgentLink') || !name.endsWith('.app')) continue;
    const app = path.join(directory, name);
    if (!existsSync(path.join(app, 'Contents', 'Resources', 'runtime', 'dist', 'apps', 'runtime', 'cli.js'))) continue;
    candidates.push({ app, modified: (await stat(app)).mtimeMs });
  }
  candidates.sort((left, right) => right.modified - left.modified);
  return candidates[0]?.app ?? null;
}

const source = path.resolve(flag('--source', (await newestPackagedApp()) ?? ''));
if (!source || !existsSync(source)) throw Error('No packaged app found. Run: node scripts/package-mac-app.mjs "build/AgentLink 0.2.0.app"');
const runtimeCli = path.join(source, 'Contents', 'Resources', 'runtime', 'dist', 'apps', 'runtime', 'cli.js');
if (!existsSync(runtimeCli)) throw Error('That app is not self-contained (no embedded runtime); package it first.');

const version = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(path.join(root, 'package.json'), 'utf8'))).version;
const out = path.resolve(flag('--out', path.join(root, 'build', 'AgentLink-' + version + '.dmg')));
if (existsSync(out)) throw Error('Output exists; choose a new path to preserve it: ' + out);

const staging = path.join(os.tmpdir(), 'agentlink-dmg-' + Date.now());
try {
  await mkdir(staging, { recursive: true });
  execFileSync('/bin/cp', ['-R', source, path.join(staging, 'AgentLink.app')], { stdio: 'inherit' });
  await symlink('/Applications', path.join(staging, 'Applications'));
  // The new machine needs a way to import the pairing without typing commands.
  // Launcher names are identical here and inside the image: a file the user is told to
  // double-click must exist under the same name in both places.
  const launchers = ['1-让这台电脑可被使用.command', '2-查找并连接电脑.command', '导入配对.command'];
  for (const name of launchers) {
    const launcher = path.join(root, '..', name);
    if (existsSync(launcher)) await cp(launcher, path.join(staging, name), { recursive: true });
  }
  await writeFile(path.join(staging, '安装说明.txt'), [
    'AgentLink ' + version,
    '',
    '1. 把左边的 AgentLink.app 拖到右边的 Applications。',
    '2. 打开 App：菜单栏会出现图标，点它可以看状态。',
    '3. 首次使用点「修复并启动后台服务」，它会安装/启动登录自启并统一安装位置。',
        '4. 需要给别的电脑使用时，用「复制接入命令」把 Agent 配置粘到对方的 Agent 里。',
    '5. 如果你要在“另一台电脑”上用：先在旧电脑执行 pair export 导出配对文件，',
    '   再在新电脑上双击旁边的「导入配对.command」导入。',
    '',
    '',
    '两台电脑互相连接（不需要拷贝任何文件）：',
    '  A 电脑双击「1-让这台电脑可被使用.command」，保持窗口开着；',
    '  B 电脑双击「2-查找并连接电脑.command」，按回车即可连上。',
    '',
    '这个 App 自带运行时，不需要预装 Node.js，也可以放在任意位置运行。',
    '卸载：把 App 拖到废纸篓；后台服务用 launchctl bootout gui/$(id -u) 加上 plist 路径停止。',
    '',
  ].join('\n'));

  let artifact = out;
  let format = 'dmg';
  try {
    execFileSync('/usr/bin/hdiutil', ['create', '-volname', 'AgentLink ' + version, '-srcfolder', staging,
      '-ov', '-format', 'UDZO', '-fs', 'HFS+', out], { stdio: 'inherit' });
  } catch (error) {
    // Creating a disk image needs system privileges that a restricted session may not have.
    // A zip of the same staging folder installs identically (unzip, drag to Applications),
    // so the release is still shippable instead of failing outright.
    format = 'zip';
    artifact = out.replace(/\.dmg$/, '') + '.zip';
    if (existsSync(artifact)) throw Error('Output exists; choose a new path to preserve it: ' + artifact);
    console.error('hdiutil could not create a disk image (' + (error instanceof Error ? error.message.split('\n')[0] : String(error)) + '); producing a zip instead.');
    // Without --keepParent the archive root is the staging folder's contents (app + link + notes).
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', staging, artifact], { stdio: 'inherit' });
  }
  console.log(JSON.stringify({ format, artifact, source, version, bytes: (await stat(artifact)).size }, null, 2));
} finally {
  await rm(staging, { recursive: true, force: true });
}
