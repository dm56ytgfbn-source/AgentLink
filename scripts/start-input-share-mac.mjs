import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {resolveLaunchMode} from '../dist/apps/input-share/native-process.js';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='darwin')throw Error('Run this entry point on your Mac');
const registry=process.env.AGENTLINK_CONFIG??path.join(os.homedir(),'Library/Application Support/AgentLink/config/runtime.local.json');
const devices=JSON.parse(await readFile(registry,'utf8')).devices;
const name=process.argv[2]??(devices.length===1?devices[0].name:undefined);
if(!name)throw Error('这台 Mac 配对了 ' + devices.length + ' 台电脑，请指定共享给哪一台：'
 + devices.map(device=>device.name).join('、')
 + '\n用法：node scripts/start-input-share-mac.mjs 电脑名');
if(!devices.some(device=>device.name===name))throw Error('没有配对这个名字的电脑，已配对的是：' + devices.map(device=>device.name).join('、'));
const app=process.env.AGENTLINK_INPUT_APP?path.resolve(process.env.AGENTLINK_INPUT_APP):path.join(root,'build/AgentLink Input Preview.app'),helper=path.join(app,'Contents/MacOS/AgentLinkInput');
if(!existsSync(helper))execFileSync(process.execPath,[path.join(root,'scripts/build-input-share.mjs'),app],{stdio:'inherit'});
const decision=await resolveLaunchMode(helper);
if(!decision.permissions||!decision.displays){
 console.error('尚未启动共享：缺「辅助功能」和「输入监控」权限。');
 console.error('');
 console.error('在 Mac「系统设置 → 隐私与安全性」里，给下面任意一个授权都可以：');
 console.error('  a) 辅助程序本身（推荐，范围最小）：');
 console.error('     '+app);
 console.error('  b) 启动它的终端（Terminal），然后在终端里重新运行本脚本');
 console.error('');
 console.error('授权后**必须重新运行**本脚本，正在跑的进程不会拿到新权限。');
 process.exitCode=2;
}else{
 if(decision.mode==='direct')console.log('（权限来自当前终端，没有单独给 App 授权，效果相同。）');
 console.log('正在连接对方电脑的 AgentLink 服务。Control+Option+Esc 或菜单栏可停止。');
 const args=[path.join(root,'dist/apps/input-share/main.js'),'connect','--registry',registry,'--device',name,'--helper',helper,'--enable'];
 if(process.env.AGENTLINK_INPUT_TEST_SECONDS)args.push('--duration-seconds',process.env.AGENTLINK_INPUT_TEST_SECONDS);
 if(process.env.AGENTLINK_INPUT_STATUS)args.push('--status-file',process.env.AGENTLINK_INPUT_STATUS);
 if(process.env.AGENTLINK_INPUT_DIAGNOSTICS==='1')args.push('--diagnostics');
 // Where the Mac sits is a preference of the person pairing, stored next to the credentials.
 try{
  const preferences=JSON.parse(await readFile(path.join(path.dirname(registry),'input-share.local.json'),'utf8'));
  const position=preferences[name]?.position;
  if(['left','right','top','bottom'].includes(position)){args.push('--mac-position',position);console.log('屏幕位置：Mac 在 '+name+' 的'+({left:'左',right:'右',top:'上',bottom:'下'}[position])+'边');}
 }catch{ /* no preference stored yet: the default (right) applies */ }
 args.push('--launch-mode',decision.mode);
 const child=spawn(process.execPath,args,{stdio:'inherit'});
 process.on('SIGINT',()=>child.kill('SIGINT'));process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',code=>{process.exitCode=code??1;});
}
