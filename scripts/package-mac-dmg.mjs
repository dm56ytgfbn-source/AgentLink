import {mkdir, writeFile, stat, symlink, readdir} from 'node:fs/promises';
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
const metadataFile = flag('--metadata', null);
if (existsSync(out)) throw Error('Output exists; choose a new path to preserve it: ' + out);
if (metadataFile && existsSync(metadataFile)) throw Error('Metadata output exists; preserved: ' + metadataFile);

const staging = path.join(os.tmpdir(), 'agentlink-dmg-' + Date.now());
try {
  await mkdir(staging, { recursive: true });
  execFileSync('/bin/cp', ['-R', source, path.join(staging, 'AgentLink.app')], { stdio: 'inherit' });
  await symlink('/Applications', path.join(staging, 'Applications'));
  await writeFile(path.join(staging, '安装说明.txt'), [
    'AgentLink ' + version,
    '',
    '1. 把左边的 AgentLink.app 拖到右边的 Applications。',
    '2. 打开 AgentLink，日常操作都在应用窗口内完成。',
    '3. 在要被使用的电脑上点「允许其他设备使用这台电脑」。',
    '4. 在另一台电脑点「添加电脑」，然后在被使用的电脑上确认配对。',
    '5. 需要跨屏键鼠时，按应用指引开启 macOS 辅助功能和输入监控。',
    '',
    '应用自带运行时，不需要另装 Node.js，也不需要运行命令脚本。',
    '配对身份保存在用户目录，不会随安装包上传或被应用升级覆盖。',
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
  const result = { format, artifact, source, version, bytes: (await stat(artifact)).size, retained_staging: staging };
  if (metadataFile) await writeFile(metadataFile, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('Staging preserved for inspection: ' + staging);
  throw error;
}
