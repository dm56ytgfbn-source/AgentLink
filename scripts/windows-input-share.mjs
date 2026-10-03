import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Input sharing rides on the already paired HTTPS port as an HTTP upgrade, so it needs no
// second listener and no extra firewall rule. The node only attaches that handler when its
// configuration names a native helper, which is what this script prepares. The alternative
// path — a separate listener on 7444 — is deliberately not used: the Mac side dials the
// paired port, and a second port would need its own firewall exception.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.dirname(scriptDir);
const dir = path.join(os.homedir(), '.agentlink-node');
const configPath = path.join(dir, 'node.local.json');
const helper = path.join(runtime, 'build', 'AgentLinkInput.exe');

if (!existsSync(configPath)) {
  console.log('这台电脑还没准备好。请先双击「1-让这台电脑可被使用.cmd」。');
  process.exit(1);
}

if (process.argv.includes('--off')) {
  const current = JSON.parse(await readFile(configPath, 'utf8'));
  delete current.input_share;
  await writeFile(configPath, JSON.stringify(current, null, 2) + '\n');
  console.log('已把键鼠共享关掉。重新双击「1-让这台电脑可被使用.cmd」后生效。');
  process.exit(0);
}

if (!existsSync(helper)) {
  console.log('[1/2] 编译键鼠共享程序（只需一次，约十秒）...');
  const built = spawnSync(process.execPath, [path.join(scriptDir, 'build-input-share.mjs'), helper], { stdio: 'inherit' });
  if (built.status !== 0 || !existsSync(helper)) {
    console.log('');
    console.log('[X] 编译失败。请把上面的报错原文发出来。');
    console.log('    需要 .NET Framework 4.x（Windows 10/11 自带）。');
    process.exit(1);
  }
} else {
  console.log('[1/2] 键鼠共享程序已经编译好了，直接复用。');
}

const config = JSON.parse(await readFile(configPath, 'utf8'));
config.input_share = { enabled: true, helper };
await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

console.log('[2/2] 已经在本机打开键鼠共享。');
console.log('');
console.log('现在要重启服务才能加载这个设置：');
console.log('  1) 关掉「让这台电脑可被使用」那个窗口');
console.log('  2) 重新双击它');
console.log('');
console.log('然后回到 Mac，双击「Mac-启动键鼠共享.command」。');
console.log('');
console.log('默认布局：Mac 在 Windows 右边。鼠标推到屏幕右边缘就进入 Mac，');
console.log('在 Mac 上推到左边缘就回来。停止：Windows 按 Ctrl+Alt+Esc。');
console.log('');
console.log('想关掉共享：把本文件拖进命令行再加 --off，或直接说一声。');
