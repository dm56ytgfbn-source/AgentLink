import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { collectStatus } from './status.js';
import { discoverComputers, describeHost, pairWith } from './pair-auto.js';
import { resolvePaths } from '../../packages/config/index.js';
import type { IncomingMessage } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { inspectNative } from '../input-share/native-process.js';
import { LocalNodeControl } from './local-node.js';

// The settings surface is a local page served by the runtime rather than a native view written
// twice: one interface for macOS and Windows, nothing extra to ship, and native shells that
// only have to host a web view. It binds to loopback only — this is a control surface for the
// person sitting at this computer, not a network service.

export interface UiOptions { port?: number; open?: boolean; parentPid?: number; sessionToken?: string; nodeDirectory?: string; nodeShareRoot?: string }
export interface UiHandle { url: string; port: number; close(): void }

export const PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>AgentLink</title><style>',
  ':root{color-scheme:light;--fg:#172435;--dim:#65758a;--bg:#edf2f5;--card:#fff;--line:#dce5ea;--ok:#147d68;--bad:#bb4d50;--accent:#145e70;--soft:#e8f4f2}',
  '@media(prefers-color-scheme:dark){:root{color-scheme:dark;--fg:#edf5f5;--dim:#a5b6c0;--bg:#101c23;--card:#1b2a31;--line:#334650;--ok:#68d6b5;--bad:#ff9b9f;--accent:#7ad5d2;--soft:#23423f}}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}',
  'main{max-width:760px;margin:0 auto;padding:20px 24px 28px}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}h1{font-size:21px;letter-spacing:-.04em;margin:0}.sub{display:none}',
  'section{background:var(--card);border:1px solid var(--line);border-radius:17px;padding:18px;margin-bottom:12px;box-shadow:0 12px 36px rgba(12,45,55,.025)}',
  'h2{font-size:18px;letter-spacing:-.02em;margin:0 0 4px}.section-sub{color:var(--dim);margin:0;font-size:12px}',
  '.row{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--line)}.row:first-of-type{border-top:0}.name{flex:1;font-weight:600}',
  '.dot{width:9px;height:9px;border-radius:50%;background:var(--dim);flex:0 0 auto}.dot.on{background:var(--ok)}.dot.off{background:var(--bad)}',
  '.meta{color:var(--dim);font-size:12px}.err{color:var(--bad)}button{font:inherit;padding:9px 15px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;transition:background .15s,border-color .15s,transform .15s}button:hover{border-color:var(--accent);transform:translateY(-1px)}button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}button:disabled{opacity:.5;cursor:default}',
  '.hero{padding:15px 18px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 12px;align-items:center}.hero.connected{border-color:var(--ok)}.hero.problem{border-color:var(--bad)}.eyebrow{display:none}',
  '.headline{font-size:18px;font-weight:700;line-height:1.3;letter-spacing:-.02em}.next{margin:3px 0 0;color:var(--dim);font-size:12px}.actions{display:flex;gap:8px}.actions button{padding:6px 10px;font-size:12px}.primary{background:var(--accent);color:white;border-color:var(--accent)}#addmsg{grid-column:1/-1;text-align:left;margin:5px 0 0}#addmsg:empty{display:none}',
  '.hint{margin:16px 0 0;padding:11px 14px;border-radius:11px;background:var(--soft);word-break:break-word;color:var(--fg)}',
  '.layout-wrap{display:grid;grid-template-columns:minmax(280px,1fr) minmax(170px,.65fr);gap:18px;align-items:center;margin-top:12px}.layout-map{display:grid;grid-template-columns:1fr 1.25fr 1fr;grid-template-rows:38px 62px 38px;gap:6px;align-items:stretch;background:var(--bg);padding:13px;border-radius:14px}.layout-map .screen{border:1px solid var(--line);border-radius:9px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:11px;font-weight:600;background:var(--card);padding:3px}.layout-map .target{border-style:dashed;color:var(--dim);background:transparent}.layout-map .target.selected{border:2px solid var(--accent);background:var(--soft);color:var(--fg)}.layout-map .target:hover{background:var(--soft)}.layout-map .center{grid-column:2;grid-row:2;background:var(--fg);color:var(--card);border-color:var(--fg);font-size:12px}.layout-map [data-pos=top]{grid-column:2;grid-row:1}.layout-map [data-pos=left]{grid-column:1;grid-row:2}.layout-map [data-pos=right]{grid-column:3;grid-row:2}.layout-map [data-pos=bottom]{grid-column:2;grid-row:3}.layout-copy{color:var(--dim);font-size:12px}.layout-copy strong{color:var(--fg);font-size:13px}.layout-copy p{margin:5px 0}.position-preview{display:flex;align-items:center;gap:5px}.position-preview.top{flex-direction:column}.position-preview.bottom{flex-direction:column-reverse}.position-preview.right{flex-direction:row-reverse}.position-preview span{padding:3px 7px;border-radius:5px;border:1px solid var(--line);font-size:10px;color:var(--fg);background:var(--card)}.position-preview span:first-child{background:var(--soft);border-color:var(--accent)}.layout-details>summary{display:flex;align-items:center;gap:10px}.layout-details>summary #layout-caption{margin-left:auto;font-size:12px}.layout-details>summary .adjust{font-size:12px;color:var(--accent)}',
  '.share-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.share-head .primary{white-space:nowrap}.share-state{margin:9px 0 0;color:var(--dim);font-size:12px}.share-state #share{display:inline}.share-state #sharemsg{margin-left:8px}details{border-top:1px solid var(--line);margin-top:12px;padding-top:9px}details>summary{cursor:pointer;color:var(--dim);padding:4px 0;list-style:none}details>summary:before{content:"⌄";display:inline-block;width:20px;color:var(--accent)}details[open]>summary:before{content:"⌃"}details>section{margin:12px 0 8px;box-shadow:none;background:var(--bg)}',
  '@media(max-width:610px){main{padding:18px 14px}.layout-wrap{grid-template-columns:1fr}.layout-copy{order:-1}.share-head{align-items:flex-start}.share-head .primary{white-space:normal}section{padding:16px}}',
  '</style></head><body><main>',
  '<header><h1>AgentLink</h1><span class="meta" id="platform">这台电脑</span></header>',
  '<section class="hero"><div><p class="eyebrow">连接状态</p><div class="headline" id="summary">正在检查…</div><p class="next" id="next">正在查找已配对电脑。</p></div>',
  '<div class="actions"><button id="add" style="display:none">连接电脑</button><button id="refresh">刷新</button></div></section>',
  '<section><div class="share-head"><div><h2>键鼠共享</h2><p class="section-sub">鼠标跨过屏幕边缘，键盘自动跟随。</p></div><button id="sharetoggle" class="primary">开启共享</button></div>',
  '<p class="share-state"><span id="share">正在查找电脑…</span><span id="sharemsg"></span></p>',
  '<details class="layout-details" id="layout-detail"><summary>屏幕位置 <span class="position-preview" id="layout-preview"><span>Mac</span><span>Windows</span></span><span id="layout-caption">读取中…</span><span class="adjust">调整</span></summary>',
  '<div class="layout-wrap"><div class="layout-map" role="group" aria-label="Mac 相对 Windows 的屏幕位置">',
  '<button class="screen target" data-pos="top" aria-label="Mac 在 Windows 上方">Mac</button><button class="screen target" data-pos="left" aria-label="Mac 在 Windows 左侧">Mac</button>',
  '<div class="screen center" id="layout-device">Windows</div><button class="screen target" data-pos="right" aria-label="Mac 在 Windows 右侧">Mac</button><button class="screen target" data-pos="bottom" aria-label="Mac 在 Windows 下方">Mac</button></div>',
  '<div class="layout-copy"><strong>Mac 在哪一边？</strong><p>点一下对应的屏幕位置。</p></div></div></details>',
  '<details id="permissions-detail"><summary>无法共享？检查权限</summary>',
  '<div class="hint" id="permissions">正在检查 Mac 键鼠权限…</div>',
  '<p><button id="requestaccess">允许辅助功能</button> <button id="requestinput">允许输入监控</button> <button id="checkpermissions">重新检查权限</button></p>',
  '<p class="meta">只有使用键鼠共享才需要这两项。确认后点“重新检查权限”；预览版更新后可能需要重新授权。</p>',
  '<details><summary>没有看到系统授权提示？</summary><p>请在系统设置中允许 AgentLink Input Preview，然后返回这里重新检查。</p>',
  '<p><button id="openaccess">打开辅助功能设置</button> <button id="openinput">打开输入监控设置</button> <button id="revealhelper">在访达中显示授权程序</button></p></details></details>',
  '<pre id="shareout" style="display:none;background:#111114;color:#eee;border-radius:8px;padding:10px;font-size:11px;line-height:1.5;max-height:150px;overflow:auto;white-space:pre-wrap;margin:8px 0 0"></pre></section>',
  '<details id="advanced"><summary>设备与更多设置</summary><p><button id="addmore">连接新电脑</button></p><p class="meta" id="addmsg"></p>',
  '<p class="hint" id="agenthint" style="display:none"></p>',
  '<section><h2>已配对电脑</h2><p class="err" id="registryerror" style="display:none"></p><div id="devices"></div>',
  '<p><button id="manual">手动输入电脑地址</button></p></section>',
  '<section><h2>文件桥</h2><div id="bridge"></div>',
  '<p><button id="repair">修复并启动后台服务</button> <span class="meta" id="repairmsg"></span></p></section>',
  '<section><h2>这台电脑</h2><div id="self"></div><p class="meta" id="host">读取中…</p>',
  '<div id="localnode" style="display:none"><p class="meta" id="localnodestatus">接收服务未开启</p><p><button id="localnodetoggle">允许其他设备使用这台电脑</button> <button id="localnodepair" style="display:none">允许连接新设备</button></p><div id="localnodepending"></div><p class="meta">只有开启后，其他已获授权的设备才能连接这台电脑。新设备配对仍需在此确认。</p></div></section>',
  '</details>',
  '</main><script>',
  'var sessionToken=location.hash.slice(1);',
  'var nativeFetch=window.fetch.bind(window);var fetch=function(url,options){options=options||{};options.headers=Object.assign({},options.headers,{"x-agentlink-session":sessionToken});if(options.method==="POST"){options.headers["content-type"]="application/json";if(!options.body)options.body="{}"}return nativeFetch(url,options).then(function(r){if(!r.ok)return r.json().then(function(j){throw new Error(j.error||("HTTP "+r.status))});return r})}',
  'var q=String.fromCharCode(34);',
  'var esc=function(v){return String(v==null?"":v).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split(String.fromCharCode(34)).join("&quot;")};',
  'function row(html){return "<div class="+q+"row"+q+">"+html+"</div>"}',
  'function render(s){',
  ' document.getElementById("platform").textContent=s.host.platform==="darwin"?"Mac":s.host.platform==="win32"?"Windows":"这台电脑";',
  ' document.getElementById("localnode").style.display=s.host.platform==="darwin"?"block":"none";',
  ' document.getElementById("host").textContent=s.host.hostname+" · "+s.host.platform+" "+s.host.architecture+(s.age_ms>8000?"（数据 "+Math.round(s.age_ms/1000)+" 秒前）":"");',
  ' document.getElementById("self").innerHTML=row("<span class="+q+"name"+q+">当前电脑</span><span class="+q+"meta"+q+">"+esc(s.current.name)+"</span>");',
  ' var d=s.devices||[];',
  ' var online=d.filter(function(x){return x.online===true});',
  ' var hero=document.querySelector(".hero");hero.classList.toggle("connected",online.length>0&&!s.registry?.error);hero.classList.toggle("problem",!!s.registry?.error);',
  ' var registryError=document.getElementById("registryerror");registryError.textContent=s.registry?.error||"";registryError.style.display=s.registry?.error?"block":"none";',
  ' var summary=document.getElementById("summary"),next=document.getElementById("next"),hint=document.getElementById("agenthint");',
  ' document.getElementById("add").style.display=online.length?"none":"inline-block";',
  ' if(s.registry&&s.registry.error){summary.textContent="连接需要检查";next.textContent="展开下方设置查看原因。";hint.style.display="none"}',
  ' else if(online.length){summary.textContent=online.length===1?("已连接 · "+online[0].name):("已连接 · "+online.length+" 台电脑");',
  '  next.textContent="可以直接使用，无需重新配对。";',
  '  hint.textContent="对 Agent 说：请通过 AgentLink 在 "+online[0].name+" 上完成任务。";hint.style.display="block"}',
  ' else if(d.length){summary.textContent="等待电脑上线";next.textContent="请打开对方电脑的 AgentLink。";hint.style.display="none"}',
  ' else{summary.textContent="还没有连接电脑";next.textContent="先在另一台电脑打开 AgentLink。";hint.style.display="none"}',
  ' document.getElementById("devices").innerHTML=d.length?d.map(function(x){',
  '  var on=x.online===true;',
  '  return row("<span class="+q+"dot "+(on?"on":"off")+""+q+"></span><span class="+q+"name"+q+">"+esc(x.name)+"</span><span class="+q+"meta"+q+">"+(on?"在线 "+(x.elapsed_ms||0)+"ms":esc(x.summary||x.status||"离线"))+"</span>")',
  ' }).join(""):row("<span class="+q+"meta"+q+">还没有配对任何电脑</span>");',
  ' var b=s.bridge||{};',
  ' document.getElementById("bridge").innerHTML=',
  '  row("<span class="+q+"dot "+(b.running?"on":"off")+""+q+"></span><span class="+q+"name"+q+">后台服务</span><span class="+q+"meta"+q+">"+(b.running?"运行中":"未运行")+"</span>")+',
  '  row("<span class="+q+"name"+q+">挂载</span><span class="+q+"meta"+q+">"+esc(b.mount||"unmounted")+"</span>");',
  '}',
  'var busy=false;',
  'function load(){if(busy)return;busy=true;fetch("/api/status").then(function(r){return r.json()}).then(function(s){busy=false;if(s.error)throw new Error(s.error);render(s);loadpos();loadshare();if(s.host.platform==="darwin")loadnode()})',
  ' .catch(function(e){busy=false;document.querySelector(".hero").classList.remove("connected");document.querySelector(".hero").classList.add("problem");document.getElementById("summary").textContent="暂时无法检查连接";document.getElementById("next").textContent="请稍后刷新；如果仍失败，展开高级设置查看状态。";document.getElementById("agenthint").style.display="none";document.getElementById("host").innerHTML="<span class="+q+"err"+q+">读取失败："+esc(e.message)+"</span>"})}',
  'function note(t,bad){var el=document.getElementById("addmsg");el.textContent=t;el.className=bad?"meta err":"meta"}',
  'function pair(host,port){note("请在对方电脑点「允许连接」："+host+" …");fetch("/api/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({host:host,port:port})})',
  ' .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j})})',
  ' .then(function(j){note("已连接："+j.name);load()}).catch(function(e){note("连接失败："+e.message,true)})}',
  'document.getElementById("manual").onclick=function(){var h=prompt("输入对方电脑显示的局域网地址：");if(h)pair(h.replace("https://","").replace("http://","").split(":")[0],7443)};',
  'document.getElementById("add").onclick=function(){var advanced=document.getElementById("advanced");advanced.open=true;advanced.scrollIntoView({behavior:"smooth",block:"start"});note("正在搜索局域网…");fetch("/api/discover").then(function(r){return r.json()}).then(function(peers){',
  ' if(!peers.length){note("没有发现电脑。确认对方已启动 AgentLink；也可在高级设置里手动输入地址。",true);return}',
  ' var el=document.getElementById("devices");',
  ' el.innerHTML=peers.map(function(p){return row("<span class="+q+"dot "+(p.pairing_open?"on":"off")+""+q+"></span><span class="+q+"name"+q+">"+esc(p.name)+"</span><span class="+q+"meta"+q+">"+esc(p.host)+" · "+(p.pairing_open?"可配对":"未开放配对")+"</span>")}).join("");',
  ' peers.forEach(function(p){if(!p.pairing_open)return;var b=document.createElement("button");b.textContent="配对 "+p.name;b.style.marginTop="8px";b.onclick=function(){pair(p.host,p.port)};el.appendChild(b)});',
  ' note("发现 "+peers.length+" 台"+(peers.some(function(p){return p.pairing_open})?"":"，但都不允许配对：请在对方电脑上双击「3-允许新电脑配对」"))',
  '}).catch(function(e){note("搜索失败："+e.message,true)})};',
  'document.getElementById("addmore").onclick=function(){document.getElementById("add").click()};',
  'function loadnode(){fetch("/api/local-node").then(function(r){return r.json()}).then(function(j){',
  ' var toggle=document.getElementById("localnodetoggle"),pair=document.getElementById("localnodepair");',
  ' toggle.textContent=j.running?"停止允许其他设备使用":"允许其他设备使用这台电脑";pair.style.display=j.running?"inline-block":"none";',
  ' document.getElementById("localnodestatus").textContent=j.running?("接收服务运行中 · "+j.name+" · 端口 "+j.port):"接收服务未开启";',
  ' var pending=document.getElementById("localnodepending");pending.textContent="";',
  ' (j.pending||[]).forEach(function(p){var line=document.createElement("div");line.className="row";',
  ' var label=document.createElement("span");label.className="name";label.textContent=p.name+" 请求连接";',
  ' var button=document.createElement("button");button.textContent="允许";button.onclick=function(){',
  '  button.disabled=true;fetch("/api/local-node/approve",{method:"POST",body:JSON.stringify({pending_id:p.pending_id})}).then(loadnode).catch(function(e){button.disabled=false;document.getElementById("localnodestatus").textContent=e.message})};',
  ' line.appendChild(label);line.appendChild(button);pending.appendChild(line)})',
  '}).catch(function(e){document.getElementById("localnodestatus").textContent="接收服务状态读取失败："+e.message})}',
  'document.getElementById("localnodetoggle").onclick=function(){var b=this;b.disabled=true;',
  ' fetch(b.textContent.indexOf("停止")===0?"/api/local-node/stop":"/api/local-node/start",{method:"POST"})',
  ' .then(loadnode).catch(function(e){document.getElementById("localnodestatus").textContent=e.message}).finally(function(){b.disabled=false})};',
  'document.getElementById("localnodepair").onclick=function(){var b=this;b.disabled=true;',
  ' fetch("/api/local-node/open-pairing",{method:"POST"}).then(function(){document.getElementById("localnodestatus").textContent="已开放新设备配对 10 分钟"}).catch(function(e){document.getElementById("localnodestatus").textContent=e.message}).finally(function(){b.disabled=false})};',
  'function say(id,t,bad){var el=document.getElementById(id);el.textContent=t;el.className=bad?"meta err":"meta"}',
  'document.getElementById("repair").onclick=function(){',
  ' say("repairmsg","正在修复并启动…");this.disabled=true;var self=this;',
  ' fetch("/api/repair",{method:"POST"}).then(function(r){return r.json()}).then(function(j){',
  '  self.disabled=false;say("repairmsg",j.code===0?"完成":"失败（退出码 "+j.code+"）",j.code!==0);load()',
  ' }).catch(function(e){self.disabled=false;say("repairmsg","失败："+e.message,true)})};',
  'function loadpos(){fetch("/api/layout").then(function(r){return r.json()}).then(function(j){',
  ' var el=document.getElementById("share");',
  ' var caption=document.getElementById("layout-caption"),center=document.getElementById("layout-device"),preview=document.getElementById("layout-preview");',
  ' if(!j.device){el.textContent="先连接一台电脑";center.textContent="另一台电脑";caption.textContent="待连接";preview.className="position-preview left";document.querySelectorAll("[data-pos]").forEach(function(b){b.disabled=true;b.classList.remove("selected");b.setAttribute("aria-pressed","false")});return}',
  ' el.textContent="共享目标："+j.device;center.textContent=j.device;',
  ' var labels={left:"左侧",right:"右侧",top:"上方",bottom:"下方"};caption.textContent=labels[j.position]||"右侧";preview.className="position-preview "+j.position;',
  ' document.querySelectorAll("[data-pos]").forEach(function(b){var on=b.getAttribute("data-pos")===j.position;',
  '  b.disabled=false;b.classList.toggle("selected",on);b.setAttribute("aria-pressed",on?"true":"false");',
  '  b.onclick=function(){savepos(j.device,b.getAttribute("data-pos"))}});',
  '}).catch(function(){})}',
  'function savepos(device,p){say("sharemsg","正在保存…");',
  ' fetch("/api/layout",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({device:device,position:p})})',
  '  .then(function(r){return r.json()}).then(function(){say("sharemsg","位置已保存");document.getElementById("layout-detail").open=false;loadpos()})',
  '  .catch(function(e){say("sharemsg","保存失败："+e.message,true)})}',
  'function loadpermissions(){fetch("/api/permissions").then(function(r){return r.json()}).then(function(j){',
  ' var a=j.accessibility===true&&j.post_events===true,i=j.input_monitoring===true;',
  ' document.getElementById("permissions").textContent="辅助功能："+(a?"已允许":"待允许")+"　｜　输入监控："+(i?"已允许":"待允许")+(a&&i?"。现在可以开启键鼠共享。":"。按下面按钮，让 Mac 显示授权提示。");',
  ' document.getElementById("requestaccess").disabled=a;document.getElementById("requestinput").disabled=i;',
  '}).catch(function(e){document.getElementById("permissions").textContent="权限检查失败："+e.message})}',
  'function permissionAction(kind,action){var target=document.getElementById("permissions");target.textContent="正在打开 Mac 授权…";',
  ' fetch("/api/permissions/"+action,{method:"POST",body:JSON.stringify({kind:kind})}).then(function(){',
  '  target.textContent=action==="request"?"请在 Mac 弹窗中确认，然后点「重新检查权限」。":action==="reveal"?"已在访达中定位授权程序。请把它加入系统设置中的授权列表。":"请在系统设置中允许 AgentLink Input Preview，然后点「重新检查权限」。";',
  ' }).catch(function(e){target.textContent="打开失败："+e.message})}',
  'document.getElementById("requestaccess").onclick=function(){permissionAction("accessibility","request")};',
  'document.getElementById("requestinput").onclick=function(){permissionAction("input_monitoring","request")};',
  'document.getElementById("checkpermissions").onclick=loadpermissions;',
  'document.getElementById("openaccess").onclick=function(){permissionAction("accessibility","open")};',
  'document.getElementById("openinput").onclick=function(){permissionAction("input_monitoring","open")};',
  'document.getElementById("revealhelper").onclick=function(){permissionAction("helper","reveal")};',
  'document.getElementById("permissions-detail").addEventListener("toggle",function(){if(this.open)loadpermissions()});',
  'function loadshare(){fetch("/api/share").then(function(r){return r.json()}).then(function(j){',
  ' var b=document.getElementById("sharetoggle");if(!b)return;',
  ' b.textContent=!j.device?"先连接电脑":j.running?"停止共享":"开启共享";b.disabled=!j.device;',
  ' if(j.running)say("sharemsg","键鼠共享运行中");else if(j.stopped)say("sharemsg",j.exit_code===0?"共享已停止":"连接未成功，请查看下面的日志",j.exit_code!==0);',
  ' b.onclick=function(){b.disabled=true;',
  '  fetch(j.running?"/api/share/stop":"/api/share/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({device:j.device})})',
  '   .then(function(r){return r.json()}).then(function(x){b.disabled=false;if(x.error){say("sharemsg",x.error,true);if(/权限|授权|输入监控|辅助功能|permission/i.test(x.error))document.getElementById("permissions-detail").open=true}else{say("sharemsg",j.running?"已停止":"正在启动…")}setTimeout(loadshare,1500)})',
  '   .catch(function(e){b.disabled=false;say("sharemsg","失败："+e.message,true);if(/权限|授权|输入监控|辅助功能|permission/i.test(e.message))document.getElementById("permissions-detail").open=true})};',
  ' var o=document.getElementById("shareout");',
  ' if(j.output){o.style.display="block";o.textContent=j.output}else{o.style.display="none"}',
  '}).catch(function(){})}',
  'document.getElementById("refresh").onclick=load;load();setInterval(load,5000);',
  '</script></body></html>',
].join('\n');

// Shelling out to the same command the menu bar app runs, so every surface repairs the
// installation through one code path instead of three drifting copies of the logic.
function runCli(args: string[]): Promise<{ code: number; output: string }> {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: process.cwd() });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', error => resolve({ code: -1, output: String(error.message) }));
    child.on('close', code => resolve({ code: code ?? -1, output }));
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', chunk => { size += chunk.length; if (size > 16384) reject(Object.assign(new Error('请求内容过大'), { status: 413 })); else chunks.push(chunk as Buffer); });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function openInBrowser(url: string) {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}

// Probing every device on every request is what froze the page: an unreachable computer costs
// a full five second timeout, so a three second poll queued requests faster than they retired
// and the browser ran out of connections. The page now reads a cached snapshot while exactly
// one refresh runs in the background, no matter how many times the page asks.
let snapshot: { at: number; value: Record<string, unknown> } | null = null;
let refreshing: Promise<void> | null = null;

export function currentSnapshot() {
  return snapshot ? { ...snapshot.value, age_ms: Date.now() - snapshot.at, refreshing: refreshing !== null } : null;
}

function refreshStatus(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = collectStatus()
    .then(value => { snapshot = { at: Date.now(), value: value as unknown as Record<string, unknown> }; })
    .catch(error => { if (!snapshot) snapshot = { at: Date.now(), value: { error: (error as Error).message } }; })
    .then(() => { refreshing = null; });
  return refreshing;
}

// Where the Mac sits is a property of the pair, not of the computer, so it is stored here and
// travels to the other side as a direction. Turning that direction into display edges needs both
// display lists, which only the machine being used has.
const POSITIONS = ['left', 'right', 'top', 'bottom'];

function preferenceFile() { return path.join(resolvePaths().configDir, 'input-share.local.json'); }

function inputHelperApp() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  return path.join(root, 'build', 'AgentLink Input Preview.app');
}

function openMac(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('macOS 无法打开授权窗口')));
  });
}

async function readPreferences(): Promise<Record<string, { position?: string }>> {
  try { return JSON.parse(await readFile(preferenceFile(), 'utf8')) as Record<string, { position?: string }>; }
  catch { return {}; }
}

// Sharing captures the whole keyboard and mouse, so exactly one process may run: starting a
// second one would have two consumers fighting over the same events. The launcher script is
// reused rather than reimplemented, so the permission check and the direction it resolves are
// identical whether sharing was started here or from the terminal.
let sharing: { device: string; child: ChildProcess; log: string[] } | null = null;
let lastSharing: { device: string; log: string[]; exitCode: number | null } | null = null;

function startSharing(device: string) {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'start-input-share-mac.mjs'), device], { cwd: root });
  const entry = { device, child, log: [] as string[] };
  lastSharing = null;
  const collect = (chunk: Buffer) => { entry.log.push(chunk.toString()); if (entry.log.length > 300) entry.log.shift(); };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  child.on('error', error => collect(Buffer.from(error.message)));
  child.on('close', code => { lastSharing = { device, log: [...entry.log], exitCode: code }; if (sharing === entry) sharing = null; });
  return entry;
}

export async function startUi(options: UiOptions = {}): Promise<UiHandle> {
  const token = options.sessionToken ?? process.env.AGENTLINK_UI_TOKEN ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid UI session token');
  const localNode = new LocalNodeControl(options.nodeDirectory, options.nodeShareRoot);
  const server = createServer(async (request, response) => {
    try {
      const expectedHost = '127.0.0.1:' + (server.address() as { port: number }).port;
      if (request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== 'http://' + expectedHost)) {
        response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: '请求来源未获允许' })); return;
      }
      response.setHeader('x-frame-options', 'DENY');
      response.setHeader('x-content-type-options', 'nosniff');
      response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('cache-control', 'no-store');
      if (request.url?.startsWith('/api/')) {
        if (request.headers['x-agentlink-session'] !== token) {
          response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: '设置会话已失效，请重新打开窗口' })); return;
        }
        if (request.method === 'POST' && request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
          response.writeHead(415, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: '仅接受 JSON 请求' })); return;
        }
      }
      if (request.url === '/' || request.url === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(PAGE);
        return;
      }
      if (request.url === '/api/status') {
        if (!snapshot) await refreshStatus(); else void refreshStatus();
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(currentSnapshot()));
        return;
      }
      if (request.url === '/api/discover') {
        // Broadcast based, so this takes as long as the listening window it opens.
        const peers = await discoverComputers({ timeoutMs: 4500 });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(peers.map(peer => ({ name: peer.name, host: peer.host, port: peer.port,
          os: peer.os, pairing_open: peer.pairing_open }))));
        return;
      }
      if (request.url === '/api/pair' && request.method === 'POST') {
        // A typed address is the fallback for when discovery cannot work: a computer announcing
        // through a virtual adapter, or a network that drops broadcast entirely.
        const body = JSON.parse(await readBody(request)) as { host?: string; port?: number };
        if (!body.host) throw new Error('缺少对方电脑的地址');
        const peer = await describeHost(body.host, body.port ?? 7443);
        const result = await pairWith(peer, { paths: resolvePaths() });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ name: peer.name, device_id: result.device_id,
          fingerprint: result.fingerprint, devices: result.devices }));
        return;
      }
      if (request.url === '/api/local-node' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(await localNode.status()));
        return;
      }
      if (request.url === '/api/local-node/start' && request.method === 'POST') {
        if (process.platform !== 'darwin') throw Object.assign(new Error('接收服务界面目前仅在 Mac 开放'), { status: 501 });
        const status = await localNode.start();
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(status));
        return;
      }
      if (request.url === '/api/local-node/stop' && request.method === 'POST') {
        await localNode.stop();
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(await localNode.status()));
        return;
      }
      if (request.url === '/api/local-node/open-pairing' && request.method === 'POST') {
        await localNode.openPairing();
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url === '/api/local-node/approve' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request)) as { pending_id?: string };
        await localNode.approve(body.pending_id ?? '');
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url === '/api/share' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        const paired = ((currentSnapshot() ?? {}) as { devices?: { name: string; online?: boolean }[] }).devices ?? [];
        const suggestion = sharing?.device ?? lastSharing?.device ?? (paired.find(entry => entry.online) ?? paired[0])?.name ?? '';
        response.end(JSON.stringify({ running: sharing !== null, device: suggestion,
          supported: process.platform === 'darwin', stopped: lastSharing !== null, exit_code: lastSharing?.exitCode ?? null,
          output: (sharing?.log ?? lastSharing?.log ?? []).slice(-14).join('') }));
        return;
      }
      if (request.url === '/api/permissions' && request.method === 'GET') {
        if (process.platform !== 'darwin') throw Object.assign(new Error('仅 Mac 需要此授权'), { status: 501 });
        const helper = path.join(inputHelperApp(), 'Contents', 'MacOS', 'AgentLinkInput');
        if (!existsSync(helper)) throw Object.assign(new Error('键鼠辅助程序不在应用包内'), { status: 404 });
        const state = await inspectNative(helper, 'app') as Record<string, unknown>;
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ accessibility: state.accessibility === true,
          input_monitoring: state.input_monitoring === true, post_events: state.post_events === true }));
        return;
      }
      if ((request.url === '/api/permissions/request' || request.url === '/api/permissions/open' || request.url === '/api/permissions/reveal') && request.method === 'POST') {
        if (process.platform !== 'darwin') throw Object.assign(new Error('仅 Mac 需要此授权'), { status: 501 });
        const body = JSON.parse(await readBody(request)) as { kind?: string };
        const helperApp = inputHelperApp();
        if (!existsSync(helperApp)) throw Object.assign(new Error('键鼠辅助程序不在应用包内'), { status: 404 });
        if (request.url === '/api/permissions/reveal' && body.kind === 'helper') await openMac(['-R', helperApp]);
        else if (request.url === '/api/permissions/request' && body.kind === 'accessibility') await openMac(['-n', '-a', helperApp, '--args', '--request-accessibility']);
        else if (request.url === '/api/permissions/request' && body.kind === 'input_monitoring') await openMac(['-n', '-a', helperApp, '--args', '--request-input-monitoring']);
        else if (request.url === '/api/permissions/open' && body.kind === 'accessibility') await openMac(['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility']);
        else if (request.url === '/api/permissions/open' && body.kind === 'input_monitoring') await openMac(['x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent']);
        else throw Object.assign(new Error('未知的授权操作'), { status: 400 });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url === '/api/share/start' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request)) as { device?: string };
        if (!body.device) throw new Error('先选一台电脑');
        if (process.platform !== 'darwin') throw new Error('从界面启动键鼠共享目前只支持 Mac');
        if (sharing) throw new Error('已经在共享中：' + sharing.device);
        sharing = startSharing(body.device);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url === '/api/share/stop' && request.method === 'POST') {
        if (sharing) { sharing.child.kill('SIGINT'); sharing = null; }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url === '/api/layout' && request.method === 'GET') {
        const preferences = await readPreferences();
        const devices = ((currentSnapshot() ?? {}) as { devices?: { name: string; online?: boolean }[] }).devices ?? [];
        const target = devices.find(entry => entry.online) ?? devices[0];
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ device: target?.name ?? '',
          position: preferences[target?.name ?? '']?.position ?? 'right' }));
        return;
      }
      if (request.url === '/api/layout' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request)) as { device?: string; position?: string };
        if (!body.device || !POSITIONS.includes(String(body.position))) throw new Error('设备和方向都要给');
        const preferences = await readPreferences();
        preferences[body.device] = { position: body.position };
        await writeFile(preferenceFile(), JSON.stringify(preferences, null, 2) + '\n', { mode: 0o600 });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, device: body.device, position: body.position }));
        return;
      }
      if (request.url === '/api/repair' && request.method === 'POST') {
        const result = await runCli(['install', '--apply']);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(result));
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
    } catch (error) {
      response.writeHead((error as { status?: number }).status ?? 500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const url = 'http://127.0.0.1:' + port + '/#' + token;
  // A window that owns this server cannot be relied on to clean up: AppKit does not run its
  // termination callback for every way a process can die. Watching the parent instead means the
  // server can never outlive the window and leave a port open that nothing can reach.
  if (options.parentPid) {
    const parent = options.parentPid;
    const watch = setInterval(() => {
      try { process.kill(parent, 0); }
      catch { clearInterval(watch); void localNode.stop().finally(() => { server.close(); process.exit(0); }); }
    }, 2000);
    watch.unref?.();
  }
  // Warm the cache before anyone asks, so the first page render is not the one that waits.
  void refreshStatus();
  if (options.open !== false) openInBrowser(url);
  return { url, port, close: () => { void localNode.stop(); server.close(); } };
}
