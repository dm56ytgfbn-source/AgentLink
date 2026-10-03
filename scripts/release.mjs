import {mkdir,mkdtemp,writeFile,readFile,cp,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
const releases=path.resolve(root,'../Releases');await mkdir(releases,{recursive:true});
const out=await mkdtemp(path.join(releases,'AgentLink-'+version+'-'));
const mac=path.join(out,'Mac');await mkdir(mac);
const app=path.join(mac,'AgentLink.app');
const run=(script,args=[])=>execFileSync(process.execPath,[path.join(root,'scripts',script),...args],{cwd:root,stdio:'inherit'});
run('package-mac-app.mjs',[app]);
run('verify-release.mjs',[app]);
for(const name of ['1-让这台电脑可被使用.command','2-查找并连接电脑.command','导入配对.command']){
 let text=await readFile(path.resolve(root,'..',name),'utf8');
 text=text.replace('for candidate in "/Applications/AgentLink.app"', 'for candidate in "$PWD/AgentLink.app" "/Applications/AgentLink.app"');
 const file=path.join(mac,name);await writeFile(file,text);await chmod(file,0o755);
}
const settings=path.join(mac,'打开设置.command');
await writeFile(settings,'#!/bin/zsh\nopen "${0:A:h}/AgentLink.app/Contents/Resources/AgentLink Settings.app"\n');await chmod(settings,0o755);
await writeFile(path.join(mac,'使用说明.txt'),[
 'AgentLink '+version+'（待双机验收）',
 '双击「打开设置.command」进入设置，也可以打开 AgentLink.app，在主窗口点「设置」。',
 '应用自带 Node 和 Mac 原生输入程序，可整包移动；不要单独挪出内部组件。',
 '首次连接：被控电脑启动服务，连接方点添加电脑；Windows 弹窗点「是」即完成配对，不用输入验证码。',
 '旧配对配置继续保留。新设备只在被控电脑点「是」后加入。',
 '键鼠共享仍需 macOS 辅助功能和输入监控授权，签名变化可能需要重新授权。',
 '此包为本机 ad-hoc 签名，尚未完成 Developer ID 公证或异机安装验证。',
 '不要删除旧版本；建议完成双机验收后再决定是否替换。',
].join('\n'));
run('package-windows.mjs',[path.join(out,'AgentLink-Windows-'+version+'.zip')]);
execFileSync('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',mac,path.join(out,'AgentLink-Mac-'+version+'.zip')],{stdio:'inherit'});
await writeFile(path.join(out,'RELEASE.json'),JSON.stringify({version,created_at:new Date().toISOString(),mac_app:app,verified:'local-package-checks',pending:['Windows runtime','physical two-device input','clean-machine install','Developer ID signing/notarization']},null,2)+'\n');
console.log('RELEASE_DIRECTORY='+out);
