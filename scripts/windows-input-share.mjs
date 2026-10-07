import {ensureWindowsInputHelper} from './windows-input-helper.mjs';
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

const helper=await ensureWindowsInputHelper();

const config = JSON.parse(await readFile(configPath, 'utf8'));
config.input_share = { enabled: true, helper };
await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

console.log('接收键鼠共享已配置。rc.7 及以后运行中的服务会自动加载；旧版服务需先升级。');
console.log('在任意一端选择已配对电脑，点击开始共享。只需一端发起，两边键鼠都可跨屏。');
