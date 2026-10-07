import {ensureWindowsInputHelper} from './windows-input-helper.mjs';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile, writeFile, readdir, mkdir} from 'node:fs/promises';
import {connect} from 'node:net';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setupNode} from '../dist/apps/node/setup.js';
import {localAddresses} from '../dist/packages/discovery/index.js';
const scriptDir=path.dirname(fileURLToPath(import.meta.url));
const runtime=path.dirname(scriptDir);
const version=JSON.parse(await readFile(path.join(runtime,'package.json'),'utf8')).version;
const ensureOnly=process.argv.includes('--ensure');
const dir=path.join(os.homedir(),'.agentlink-node');
const configFile=path.join(dir,'node.local.json');
const share=[];
for(let index=2;index<process.argv.length;index++)if(process.argv[index]==='--share'&&process.argv[index+1])share.push(process.argv[++index]);
const line=()=>console.log('='.repeat(50));
function serviceInfo(port){return new Promise(resolve=>{
  const request=https.request({hostname:'127.0.0.1',port,path:'/pair/info',method:'GET',rejectUnauthorized:false,timeout:2500},response=>{
    let body='';response.on('data',part=>{body+=part;if(body.length>4096)request.destroy()});
    response.on('end',()=>{try{resolve(JSON.parse(body))}catch{resolve(null)}});
  });request.on('error',()=>resolve(null));request.on('timeout',()=>request.destroy());request.end();
});}
function waitForPort(port, timeoutMs){const deadline=Date.now()+timeoutMs;return new Promise(resolve=>{
  const attempt=()=>{const socket=connect(port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(true)});
    socket.once('error',()=>{socket.destroy();if(Date.now()>deadline)resolve(false);else setTimeout(attempt,500)});};attempt();
});}
function showPairingRequests(config){
  const requestDir=path.join(path.dirname(config.audit),'pairing-requests');
  const approvalDir=path.join(path.dirname(config.audit),'pairing-approvals');
  const seen=new Set();const started=Date.now();let busy=false;
  const timer=setInterval(async()=>{
    if(Date.now()-started>10*60_000){clearInterval(timer);return}
    if(busy)return;busy=true;
    try{
      for(const file of await readdir(requestDir).catch(()=>[])){
        if(!/^[a-f0-9]{48}\.json$/.test(file)||seen.has(file))continue;
        seen.add(file);
        const data=JSON.parse(await readFile(path.join(requestDir,file),'utf8'));
        if(data.pending_id!==file.slice(0,-5)||data.expires<=Date.now())continue;
        const message='电脑「'+String(data.name).slice(0,200)+'」申请连接这台电脑。\n\n这是你要连接的电脑吗？点击「是」才会允许。';
        const command="Add-Type -AssemblyName System.Windows.Forms; $r=[System.Windows.Forms.MessageBox]::Show($env:AGENTLINK_PAIRING_MESSAGE,'AgentLink 连接确认',[System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Question); if($r -eq [System.Windows.Forms.DialogResult]::Yes){exit 0}else{exit 1}";
        const decision=spawnSync('powershell.exe',['-NoProfile','-Command',command],{env:{...process.env,AGENTLINK_PAIRING_MESSAGE:message},timeout:120000,windowsHide:false});
        if(decision.status===0&&Date.now()<data.expires){
          await mkdir(approvalDir,{recursive:true});
          await writeFile(path.join(approvalDir,data.pending_id+'.approved'),'',{flag:'wx',mode:0o600});
          console.log('已允许「'+String(data.name)+'」连接。以后使用这台电脑无需再次确认。');
        }else console.log('本次连接未获允许。');
      }
    }catch(error){console.log('连接确认未完成：'+error.message)}finally{busy=false}
  },500);
}
if(process.argv.includes('--open-pairing')){
  if(!existsSync(configFile)){console.log('请先双击「00-启动 AgentLink.cmd」。');process.exitCode=1}
  else{
    const config=JSON.parse(await readFile(configFile,'utf8'));
    const info=await serviceInfo(config.port);
    if(info?.version!==version){console.log('Windows 当前运行的不是这个新版服务。请先关闭旧 AgentLink 服务，再运行「00-启动 AgentLink.cmd」。');process.exitCode=1}
    else{
      await writeFile(path.join(dir,'PAIRING_OPEN'),'');
      console.log('已开放 10 分钟。请在另一台电脑点「添加电脑」。');
      console.log('收到请求后，这台 Windows 会弹出确认窗口；只对认识的电脑点「是」。');
      showPairingRequests(config);
    }
  }
}else{
  line();console.log('AgentLink '+version+' — Windows');line();
  console.log('正在准备并启动这台电脑…');
  const setup=await setupNode({directory:dir,shareRoot:share[0],roots:share.length?share.slice(1):undefined});
  const config=JSON.parse(await readFile(setup.config,'utf8'));
  const current=await serviceInfo(config.port);
  if(current&&current.version!==version){
    console.log('发现旧版 AgentLink 正占用 '+config.port+' 端口。');
    console.log('请先停止旧版服务，再双击这个文件。原有配对和文件不会被删除。');
    process.exitCode=1;
  }else if(current){
    console.log('AgentLink '+version+' 已在运行。地址：https://'+(localAddresses()[0]??'127.0.0.1')+':'+config.port);
    if(!ensureOnly)showPairingRequests(config);
  }else{
    if(config.input_share?.enabled){
      config.input_share.helper=await ensureWindowsInputHelper();
      await writeFile(setup.config,JSON.stringify(config,null,2)+'\n');
    }
    const supervisor=fileURLToPath(new URL('../dist/apps/node/supervisor.js',import.meta.url));
    const child=spawn(process.execPath,[supervisor,setup.config],{stdio:ensureOnly?'ignore':'inherit',detached:ensureOnly,windowsHide:ensureOnly});
    if(ensureOnly)child.unref();
    else child.on('exit',code=>{console.log('服务进程已退出（'+code+'）。');process.exitCode=code??1});
    if(await waitForPort(config.port,20000)){
      const info=await serviceInfo(config.port);
      if(info?.version!==version){console.log('端口上的服务版本与安装包不一致，请关闭旧版后重试。');process.exitCode=1;child.kill('SIGTERM')}
      else{
        console.log('已启动。局域网地址：https://'+(localAddresses()[0]??'127.0.0.1')+':'+config.port);
        console.log('已有配对直接使用；新电脑申请连接时，这里会弹出确认窗口。');
        if(!ensureOnly)showPairingRequests(config);
      }
    }else{console.log('启动失败：20 秒内没有监听端口 '+config.port);process.exitCode=1;child.kill('SIGTERM')}
  }
}
