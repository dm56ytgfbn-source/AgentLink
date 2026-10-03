import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolvePaths,registryForRead} from '../packages/config/index.js';
import {applyPlan,buildEntry,entrySnippet,installContext,installGuide,guidePath,planInstall,installedSummary,renderTomlBlock,targets} from '../apps/runtime/agent-install.js';

const repositoryRoot=fileURLToPath(new URL('../../',import.meta.url));

// A release layout copies the bundled guide next to dist/, exactly like the installer does.
async function releaseFixture(){
 const source=await mkdtemp(path.join(os.tmpdir(),'agentlink-release-'));
 await mkdir(path.join(source,'agents'),{recursive:true});
 await copyFile(path.join(repositoryRoot,'agents','AGENT-GUIDE.md'),path.join(source,'agents','AGENT-GUIDE.md'));
 return source;
}

async function fixture(){
 const home=await mkdtemp(path.join(os.tmpdir(),'agentlink-agent-home-'));
 const workdir=await mkdtemp(path.join(os.tmpdir(),'agentlink-agent-work-'));
 const paths=resolvePaths({home,sourceRoot:await releaseFixture()});
 return {home,workdir,paths,context:installContext({paths,workdir,session:'agentlink-test',nodeExecutable:'/usr/bin/node'})};
}

test('an MCP entry is portable: it names the resolver and the registry, never a vendor',async()=>{
 const f=await fixture();
 const entry=buildEntry({registry:'/tmp/registry.json',session:'s1',name:'agentlink'},'/usr/bin/node');
 assert.equal(entry.command,'/usr/bin/node');
 assert.equal(entry.env.AGENTLINK_CONFIG,'/tmp/registry.json');
 assert.equal(entry.env.AGENTLINK_SESSION,'s1');
 assert.ok(entry.args[0].endsWith('mcp.js'));
 assert.ok(!JSON.stringify(entry).toLowerCase().includes('codex'),'the entry must not mention any single agent vendor');
 assert.deepEqual(entrySnippet(entry),{mcpServers:{agentlink:entry}});
 assert.equal(f.context.entry.env.AGENTLINK_CONFIG,registryForRead(f.paths));
});

test('JSON registration merges, preserves unrelated settings and is idempotent',async()=>{
 const f=await fixture();
 const target=path.join(f.workdir,'.mcp.json');
 await writeFile(target,JSON.stringify({mcpServers:{existing:{command:'other'}},theme:'dark'},null,2)+'\n');
 const first=await planInstall('claude-code',f.context);
 assert.equal(first.action,'merge');
 const applied=await applyPlan(first);
 assert.equal(applied.action,'merge');
 assert.ok(applied.backup&&existsSync(applied.backup),'an existing file must be backed up before writing');
 const saved=JSON.parse(await readFile(target,'utf8'));
 assert.equal(saved.theme,'dark');
 assert.deepEqual(saved.mcpServers.existing,{command:'other'});
 assert.equal(saved.mcpServers.agentlink.command,'/usr/bin/node');
 const second=await planInstall('claude-code',f.context);
 assert.equal(second.action,'unchanged');
 assert.equal((await applyPlan(second)).backup,null);
});

test('a fresh file is created, and a non-object configuration is refused instead of overwritten',async()=>{
 const f=await fixture();
 const created=await planInstall('vscode',f.context);
 assert.equal(created.action,'create');
 assert.ok(created.file.endsWith(path.join('.vscode','mcp.json')));
 await applyPlan(created);
 const saved=JSON.parse(await readFile(created.file,'utf8'));
 assert.ok(saved.servers.agentlink);
 await writeFile(created.file,'[]\n');
 await assert.rejects(planInstall('vscode',f.context),/not a JSON object/);
 await writeFile(created.file,JSON.stringify({servers:'nope'})+'\n');
 await assert.rejects(planInstall('vscode',f.context),/refusing to overwrite/);
});

test('TOML registration appends our table, replaces only ours, and leaves other settings alone',async()=>{
 const f=await fixture();
 const original=['model = "gpt-5"','','[mcp_servers.other]','command = "other"','','[history]','persistence = "save-all"',''].join('\n');
 const previousHome=process.env.HOME;
 process.env.HOME=f.home;
 try{
  const target=path.join(f.home,'.codex','config.toml');
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,original);
  const plan=await planInstall('codex',f.context);
  assert.equal(plan.action,'merge');
  assert.equal(plan.format,'toml');
  await applyPlan(plan);
  const after=await readFile(target,'utf8');
  assert.ok(after.includes('[mcp_servers.agentlink]'));
  assert.ok(after.includes('[mcp_servers.agentlink.env]'));
  assert.ok(after.includes('model = "gpt-5"'));
  assert.ok(after.includes('[mcp_servers.other]'));
  assert.ok(after.includes('[history]'));
  assert.ok(after.indexOf('[mcp_servers.agentlink.env]')>after.indexOf('[mcp_servers.agentlink]'),'the env sub-table must follow its parent table');
  assert.ok(after.indexOf('[history]')<after.indexOf('[mcp_servers.agentlink]'),'a new table is appended, leaving earlier tables intact');
  assert.equal(after.match(/^\[mcp_servers\.agentlink\]$/gm)?.length,1);
  assert.equal((await planInstall('codex',f.context)).action,'unchanged');
  // A changed command must replace our table only.
  const changed={...f.context,entry:{...f.context.entry,command:'/opt/node'}};
  const again=await planInstall('codex',changed);
  assert.equal(again.action,'merge');
  await applyPlan(again);
  const final=await readFile(target,'utf8');
  assert.ok(final.includes('/opt/node'));
  assert.ok(final.includes('command = "other"'));
  assert.equal(final.match(/\[mcp_servers\.agentlink\]/g)?.length,1);
 } finally {
  if(previousHome===undefined) delete process.env.HOME; else process.env.HOME=previousHome;
 }
});

test('the bundled agent guide installs into the home and is printable by any client',async()=>{
 const f=await fixture();
 const source=guidePath(f.paths);
 assert.ok(existsSync(source),'the guide must ship with the product');
 const installed=await installGuide(f.paths);
 assert.equal(installed.file,f.paths.guide);
 assert.ok(installed.bytes>500);
 const text=await readFile(f.paths.guide,'utf8');
 assert.ok(text.includes('computer_use'));
 assert.ok(!/codex/i.test(text.split('\n')[0]),'the guide title must not be vendor specific');
});

test('every advertised target is resolvable and reported by the summary',async()=>{
 const f=await fixture();
 assert.deepEqual(targets.map(t=>t.id),['codex','claude-desktop','cursor','claude-code','vscode','generic']);
 const rows=await installedSummary(f.context);
 assert.equal(rows.length,6);
 assert.ok(rows.every(row=>typeof row.file==='string'&&typeof row.registered==='boolean'));
 assert.ok(renderTomlBlock('agentlink',f.context.entry).startsWith('[mcp_servers.agentlink]'));
 const files=await readdir(f.workdir);
 assert.equal(files.length,0,'planning must not write anything');
});
