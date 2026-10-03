import { open, readFile, writeFile } from "node:fs/promises";
import path from 'node:path';
import { call, type Device } from "./client.js";
import { ComputerContext } from "./context.js";
import { inspectDevice } from "./health.js";
import { reconnectDevice } from './reconnect.js';
import { resolvePaths, registryForRead, describePaths } from '../../packages/config/index.js';
import { applyPlan, guidePath, installContext, installGuide, installedSummary, planInstall } from './agent-install.js';
// Path resolution is centralised: no entry point may hardcode a user name or a repository path.
const paths = resolvePaths();
const configPath = registryForRead(paths);
let [command, name, ...args] = process.argv.slice(2);
if(command==='computer') { command='computer.'+name; [name,...args]=args; }
const context=new ComputerContext(configPath,process.env.AGENTLINK_SESSION ?? 'default');
try {
  // The first positional after the command is consumed into NAME, so flags may arrive in
  // either slot ("install --apply" vs "status --human"). Look at both.
  const allArgs=[name,...args].filter((value):value is string=>typeof value==='string');
  const hasFlag=(flag:string)=>allArgs.includes(flag);
  const flagValue=(flag:string)=>{const index=allArgs.indexOf(flag);return index>=0?allArgs[index+1]:undefined;};
  if (command === 'computer.reconnect' || command === 'reconnect') {
    // With an address: verify that address, then save it. Without one: probe the addresses this
    // computer used before and save the first that identifies itself as the paired device.
    const positional = allArgs.filter((value, index) => !value.startsWith('--') && !(index > 0 && allArgs[index - 1].startsWith('--')));
    const target = positional[0];
    const address = positional[1];
    if (address) {
      if (!target) throw new Error('Usage: agentlink reconnect NAME https://CURRENT-ADDRESS:7443');
      console.log(JSON.stringify(await reconnectDevice(configPath, target, address), null, 2));
    } else {
      const { reconnectAuto } = await import('./reconnect.js');
      const devices = await context.devices();
      const selected = target ? devices.filter(device => device.name === target || device.device_id === target) : devices;
      if (!selected.length) throw new Error('Unknown or ambiguous computer');
      const reports = [];
      for (const device of selected) reports.push(await reconnectAuto(configPath, device.name));
      console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
      if (reports.every(report => !report.changed)) process.exitCode = 1;
    }
  } else if (command === 'doctor' || command === 'computer.health') {
    const devices = await context.devices();
    const selected = name ? devices.filter(d => d.name === name || d.device_id === name) : devices;
    if (name && selected.length !== 1) throw new Error('Unknown or ambiguous computer');
    const results = await Promise.all(selected.map(d => inspectDevice(d, { attempts: 3 })));
    console.log(JSON.stringify(results, null, 2));
    if (!results.length || results.some(r => !r.online)) process.exitCode = 1;
  } else if (command === 'paths') {
    console.log(JSON.stringify(describePaths(paths), null, 2));
  } else if (command === 'install') {
    // Convergence: report (and with --apply, fix) any divergence between the tree you are
    // running, the installed releases, the login agent and the agent registrations.
    const { discover, buildInstallPlan, canonicalReleasePath, applyInstallPlan, verifyRelease, summarizeDiscovery } = await import('./install.js');
    // Directory overrides exist so the whole convergence can be exercised on fixtures
    // (and by power users with non-standard layouts) without touching the live system.
    const launchAgentsDir = flagValue('--launch-agents-dir');
    const pluginDir = flagValue('--plugin-dir');
    const discovery = await discover({ launchAgentsDir, pluginDirs: pluginDir ? [pluginDir] : undefined });
    const release = flagValue('--release') ?? canonicalReleasePath(discovery, new Date());
    const plan = buildInstallPlan(discovery, { release,
      launchAgent: !hasFlag('--no-launch-agent'), plugin: !hasFlag('--no-plugin') });
    const pending = plan.filter(action => action.will_change);
    if (!hasFlag('--apply')) {
      console.log(JSON.stringify({ mode:'check', environment:discovery, plan,
        pending:pending.map(action => action.id),
        note:'Nothing was changed. Re-run with --apply to converge (timestamped backups are created first).' }, null, 2));
    } else if (!pending.length) {
      console.log(JSON.stringify({ mode:'apply', applied:[], skipped:plan.map(action => action.id), note:'Already converged; nothing to do.' }, null, 2));
    } else {
      const result = await applyInstallPlan(discovery, plan);
      const verification = await verifyRelease(release, discovery.node, discovery.registry.file);
      const next_steps:string[] = [];
      if (result.warnings.some(warning => warning.includes('launchctl'))) {
        const domain = 'gui/' + (process.getuid ? process.getuid() : 0);
        const plist = result.applied.find(item => item.id.startsWith('agent:'))?.file;
        next_steps.push('The login agent could not be reloaded automatically. Run: launchctl bootout ' + domain + ' ' + (plist ?? '<plist>') + ' ; launchctl bootstrap ' + domain + ' ' + (plist ?? '<plist>'));
      }
      if (!verification.ok) next_steps.push('The new release did not report itself correctly; the previous installation was preserved. Review the warnings before relying on it.');
      console.log(JSON.stringify({ mode:'apply', ...result, verification, next_steps }, null, 2));
    }
  } else if (command === 'secrets') {
    // Pairing credentials belong in the system keychain, not in a JSON file that gets copied
    // around. Migration is explicit, verified after writing, and always keeps a backup.
    const { planSecretMigration, applySecretMigration, secretStatus } = await import('./secrets.js');
    const { defaultSecretStore } = await import('../../packages/secrets/index.js');
    const sub = name ?? 'status';
    const store = await defaultSecretStore();
    if (sub === 'status') console.log(JSON.stringify(await secretStatus(configPath, store), null, 2));
    else if (sub === 'migrate') {
      const plan = await planSecretMigration(configPath, store);
      if (plan.nothing_to_do) console.log(JSON.stringify({ mode:'check', ...plan, note:'Every paired computer already uses the keychain.' }, null, 2));
      else if (!store) console.log(JSON.stringify({ mode:'check', ...plan, note:'No system keychain is available on this machine, so nothing was moved.' }, null, 2));
      else if (!hasFlag('--apply')) console.log(JSON.stringify({ mode:'check', ...plan, note:'Nothing was changed. Re-run with --apply (a backup of the registry is written first).' }, null, 2));
      else console.log(JSON.stringify({ mode:'apply', ...(await applySecretMigration(plan, store)) }, null, 2));
    } else throw new Error('Unknown secrets subcommand: ' + sub + ' (status, migrate)');
  } else if (command === 'trust') {
    // Signed requests prove possession of a key that never leaves the keychain. Setup keeps
    // the private key in the keychain and prints the configuration the other node needs.
    const { planTrustInit, applyTrustInit, trustStatus } = await import('./secrets.js');
    const { defaultSecretStore } = await import('../../packages/secrets/index.js');
    const sub = name ?? 'status';
    const store = await defaultSecretStore();
    if (sub === 'status') console.log(JSON.stringify(await trustStatus(configPath, store), null, 2));
    else if (sub === 'init') {
      const { plan, privateKey } = await planTrustInit(configPath, store, { clientId: flagValue('--client-id'), device: flagValue('--device') });
      if (!hasFlag('--apply')) console.log(JSON.stringify({ mode:'check', ...plan, note:'Nothing was changed. Re-run with --apply to store the key and update the registry.' }, null, 2));
      else console.log(JSON.stringify({ mode:'apply', ...(await applyTrustInit(plan, privateKey, store)),
        note:'Add the printed trusted_clients entry to the node config on the other computer and restart it; until then that node keeps using the token flow.' }, null, 2));
    } else throw new Error('Unknown trust subcommand: ' + sub + ' (status, init)');
  } else if (command === 'pair') {
    // Moving a pairing to another computer: the bundle carries the certificate itself, so the
    // new machine writes its own absolute paths instead of inheriting someone else's home dir.
    const { exportPairing, importPairing, describeBundle } = await import('./pairing.js');
    const sub = name ?? 'export';
    const positional = allArgs.filter((value, index) => !value.startsWith('--') && !(index > 0 && allArgs[index - 1].startsWith('--')));
    // The subcommand is itself the first positional; drop it so arguments line up.
    const rest = positional[0] === sub ? positional.slice(1) : positional;
    if (sub === 'export') {
      const target = rest[0];
      const out = flagValue('--out') ?? path.join(process.cwd(), 'agentlink-pairing-' + new Date().toISOString().slice(0, 10) + '.json');
      const bundle = await exportPairing(registryForRead(paths), target ? { device: target } : {});
      await writeFile(out, JSON.stringify(bundle, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ exported: out, devices: bundle.devices.map(device => device.name), note: bundle.warning }, null, 2));
    } else if (sub === 'import') {
      const file = rest[0];
      if (!file) throw new Error('Usage: agentlink pair import FILE [--apply] [--replace]');
      const { normalizeLegacyPairing } = await import('./pairing.js');
      const bundle = normalizeLegacyPairing(JSON.parse(await readFile(path.resolve(file), 'utf8')));
      if (!hasFlag('--apply')) console.log(JSON.stringify({ mode:'check', file: path.resolve(file), devices: await describeBundle(bundle),
        note:'Nothing was written. Add --apply to import; an existing configuration is backed up first.' }, null, 2));
      else console.log(JSON.stringify({ mode:'apply', ...(await importPairing(bundle, { paths, replace: hasFlag('--replace') })) }, null, 2));
    } else if (sub === 'discover') {
      const { discoverComputers } = await import('./pair-auto.js');
      const { describePeers } = await import('../../packages/discovery/index.js');
      const peers = await discoverComputers({ timeoutMs: flagValue('--timeout') ? Number(flagValue('--timeout')) : 2000 });
      console.log(JSON.stringify(peers.length ? describePeers(peers) : { peers: [], note: '没有发现其他电脑（确认两台在同一局域网、且对方的 AgentLink 已启动）' }, null, 2));
    } else if (sub === 'auto') {
      const { discoverComputers, describeHost, pairWith } = await import('./pair-auto.js');
      const explicit = flagValue('--host');
      let target;
      if (explicit) {
        // Discovery is a convenience, never a requirement: on a network that drops broadcast,
        // or a computer whose announcement leaves through a virtual adapter, the address the
        // other screen printed is the only thing that works.
        target = await describeHost(explicit, flagValue('--port') ? Number(flagValue('--port')) : 7443);
        if (!target.pairing_open) throw new Error('对方当前不允许配对：请在' + target.name + '上重新运行「让这台电脑可被使用」，' +
          '10 分钟内完成配对');
      } else {
        const peers = await discoverComputers({ timeoutMs: flagValue('--timeout') ? Number(flagValue('--timeout')) : 2000 });
        const open = peers.filter(peer => peer.pairing_open);
        if (!open.length) throw new Error(peers.length
          ? '发现 ' + peers.length + ' 台电脑，但都不允许配对：请在对方电脑上打开"允许新电脑配对"'
          : '没有发现其他电脑。请确认两台在同一局域网、对方的 AgentLink 已启动；' +
            '如果对方的广播发不出来（装了 VMware/VirtualBox 的电脑常见），用它窗口上显示的地址直连：' +
            'pair auto --host <对方IP>');
        if (open.length > 1 && !flagValue('--name')) throw new Error('发现多台可配对电脑，请加 --name 指定其中一台');
        target = flagValue('--name') ? open.find(peer => peer.name === flagValue('--name')) : open[0];
        if (!target) throw new Error('没有找到指定的电脑');
      }
      console.error('正在等待对方电脑上点「允许连接」……两分钟内有效。');
      console.log(JSON.stringify(await pairWith(target, { paths }), null, 2));
    } else throw new Error('Unknown pair subcommand: ' + sub + ' (export, import, discover, auto)');
  } else if (command === 'node') {
    // Prepare the computer that will BE USED: identity, certificate and configuration, with no
    // hand editing. This is what makes "install it and open it" possible on a fresh machine.
    const { setupNode } = await import('../node/setup.js');
    const sub = name ?? 'setup';
    if (sub !== 'setup') throw new Error('Unknown node subcommand: ' + sub + ' (setup)');
    const result = await setupNode({ directory: flagValue('--dir'), port: flagValue('--port') ? Number(flagValue('--port')) : undefined,
      shareRoot: flagValue('--share') });
    console.log(JSON.stringify({ ...result, token: '<hidden>', note: '把这个配置文件交给 App/服务启动即可；配对时另一台电脑会自动取得凭据。' }, null, 2));
  } else if (command === 'status') {
    // Single status source for every UI (menu bar app, tray, scripts). Never mutates state.
    const { collectStatus, summarize } = await import('./status.js');
    const status = await collectStatus();
    // "status --human" puts the flag in NAME, not ARGS: the first positional is consumed.
    if (hasFlag('--human')) console.log(summarize(status));
    else if (name !== undefined) throw new Error('Usage: agentlink status [--human]');
    else console.log(JSON.stringify(status, null, 2));
    // Always exit 0 when a payload was produced: UIs read "registry.error" from the JSON.
    // A non-zero exit is reserved for "could not produce a status at all".
  } else if (command === 'ui') {
    // The settings window is a page this runtime serves itself: the same interface on macOS and
    // Windows, and the native shells only ever have to host a web view.
    const { startUi } = await import('./ui.js');
    const ui = await startUi({ port: flagValue('--port') ? Number(flagValue('--port')) : 0,
      open: !hasFlag('--no-open'),
      parentPid: flagValue('--parent-pid') ? Number(flagValue('--parent-pid')) : undefined });
    console.log(hasFlag('--json') ? JSON.stringify({url:ui.url}) : '设置界面：' + ui.url);
  } else if (command === 'agent') {
    // Agent-neutral registration for ANY MCP client; never binds the product to one vendor.
    const sub = name ?? 'list';
    const flag = (key: string) => { const index = args.indexOf(key); return index >= 0 ? args[index + 1] : undefined; };
    const targetId = args.find(value => !value.startsWith('--')) ?? 'generic';
    // Each client gets its own context session, so computer_use in one agent never
    // silently moves another agent's target computer.
    const context = installContext({ paths, workdir: flag('--dir') ?? process.cwd(), name: flag('--name') ?? 'agentlink',
      session: flag('--session') ?? 'agentlink-' + (sub === 'install' ? targetId : 'default') });
    if (sub === 'list') console.log(JSON.stringify(await installedSummary(context), null, 2));
    else if (sub === 'guide') {
      if (args.includes('--install')) console.log(JSON.stringify(await installGuide(paths), null, 2));
      else console.log(await readFile(guidePath(paths), 'utf8'));
    } else if (sub === 'snippet') console.log(JSON.stringify({ mcpServers: { [context.name]: context.entry } }, null, 2));
    else if (sub === 'install') {
      const plan = await planInstall(targetId, context);
      const payload: Record<string, unknown> = { target: plan.target, label: plan.label, scope: plan.scope, file: plan.file, action: plan.action, applied: false };
      if (args.includes('--apply') && plan.action !== 'unchanged') Object.assign(payload, { applied: true, ...(await applyPlan(plan)) });
      else payload.snippet = plan.snippet;
      console.log(JSON.stringify(payload, null, 2));
      if (plan.action !== 'unchanged' && !args.includes('--apply')) console.log('\nDry run: nothing was written. Add --apply to write (a timestamped backup is created first).');
    } else throw new Error('Unknown agent subcommand: ' + sub + ' (list, install, guide, snippet)');
  } else if (command === 'mcp-http') {
    const { startHttpServer } = await import('./mcp-http.js');
    const portValue = flagValue('--port');
    const started = await startHttpServer({ port: portValue ? Number(portValue) : 7788, session: process.env.AGENTLINK_SESSION ?? 'default' });
    console.log('AgentLink MCP over HTTP: http://' + started.host + ':' + started.port + '/mcp');
    console.log('Token file: ' + started.tokenFile + (started.tokenCreated ? ' (created, mode 0600)' : ' (existing)'));
    console.log('Use: Authorization: Bearer <token from that file>. Stop with Ctrl+C.');
    await new Promise<void>(resolve => { const stop = () => { started.server.close(() => resolve()); process.off('SIGINT', stop); process.off('SIGTERM', stop); }; process.on('SIGINT', stop); process.on('SIGTERM', stop); });
  } else if (['use','current','computers','computer.list','computer.use','computer.current','computer.info'].includes(command)) {
    let result:unknown;
    if(command==='use'||command==='computer.use') { if(!name)throw new Error('Usage: computer use NAME [CWD]');result=await context.use(name,args[0]); }
    else if(command==='current'||command==='computer.current')result=await context.current();
    else if(command==='computer.info')result=await context.info(name);
    else result=await context.list();
    console.log(JSON.stringify(result,null,2));
  } else if (!command || command === "help") {
    console.log('agentlink install [--apply] — show (or fix) divergence between this tree, installed releases, login agent and agent registrations');
    console.log('agentlink status [--human] — machine-readable state for any UI (devices, bridge, mount, services)');
    console.log('agentlink secrets status|migrate [--apply] — keep pairing credentials in the system keychain instead of the config file');
    console.log('agentlink pair discover — list AgentLink computers on this network');
    console.log('agentlink pair auto [--name NAME] — find a computer that allows pairing and connect to it in one step');
    console.log('agentlink node setup [--dir DIR] [--port N] [--share DIR] — prepare THIS computer to be used (identity + certificate)');
    console.log('agentlink pair export [NAME] [--out FILE] — bundle a pairing so another computer can import it');
    console.log('agentlink pair import FILE [--apply] — import a pairing on this computer (dry run by default)');
    console.log('agentlink trust status|init [--apply] — sign requests with a keychain-held key so a stolen token is not enough');
    console.log('agentlink paths — show where AgentLink keeps configuration and state');
    console.log('agentlink agent list — show known AI clients and whether AgentLink is registered');
    console.log('agentlink agent install TARGET [--apply] [--dir .] — print (or write) an MCP registration; targets: codex, claude-desktop, claude-code, cursor, vscode, generic');
    console.log('agentlink agent snippet — print a copy-pasteable MCP config for any client');
    console.log('agentlink agent guide [--install] — agent-neutral usage guide for any AI agent');
    console.log('agentlink mcp-http [--port 7788] — serve the same tools over local HTTP for any agent');
    console.log('agentlink doctor [NAME] — read-only connection diagnostics');
    console.log('agentlink computer reconnect NAME https://CURRENT-ADDRESS:7443 — verify the paired identity, then save a new route with a backup');
    console.log('agentlink reconnect [NAME] [URL] — verify a new address, or re-probe the addresses this computer used before (auto)');
    console.log(
      "agentlink computer list\nagentlink use RTX-PC [CWD]\nagentlink current\nagentlink computer info [NAME]\nAGENTLINK_SESSION isolates each agent context. Context does not hook local Shell.\nAGENTLINK_CONFIG=runtime.local.json\nagentlink devices\nagentlink info NAME\nagentlink exec NAME COMMAND CWD\nagentlink list NAME PATH\nagentlink read NAME REMOTE_PATH LOCAL_OUTPUT\nagentlink write NAME REMOTE_PATH LOCAL_INPUT\nagentlink launch NAME APP CWD [ARGS...]\nagentlink screen NAME OUTPUT.png [MONITOR_INDEX]",
    );
  } else {
    const config: { devices: Device[] } = JSON.parse(
      await readFile(
        configPath,
        "utf8",
      ),
    );
    if (command === "devices") {
      console.log(
        JSON.stringify(
          await Promise.all(
            config.devices.map(async (d) => {
              try {
                return { ...((await call(d)) as object), online: true };
              } catch (e) {
                return {
                  name: d.name,
                  online: false,
                  error: (e as Error).message,
                };
              }
            }),
          ),
          null,
          2,
        ),
      );
    } else {
      const device = config.devices.find((d) => d.name === name);
      if (!device) throw new Error("Unknown device");
      await call(device);
      const need = (i: number) => {
        if (args[i] === undefined)
          throw new Error("Missing argument; run help");
        return args[i];
      };
      let result: unknown;
      if (command === "info") result = await call(device);
      else if (command === "exec")
        result = await call(device, "shell.run", {
          command: need(0),
          cwd: need(1),
        });
      else if (command === "list")
        result = await call(device, "files.list", { path: need(0) });
      else if (command === "read") {
        // files.read stops at 1 MiB, so anything larger is streamed in chunks instead.
        const remote = need(0),
          out = need(1);
        const info = (await call(device, "files.stat", { path: remote })) as { size: number };
        const handle = await open(out, "wx", 0o600);
        let offset = 0,
          version: string | undefined;
        try {
          while (offset < info.size) {
            const chunk = (await call(device, "files.read_chunk", {
              path: remote, offset, length: Math.min(512 * 1024, info.size - offset), version,
            })) as { data: string; bytes: number; version: string };
            if (!chunk.bytes) break;
            await handle.write(Buffer.from(chunk.data, "base64"));
            version = chunk.version;
            offset += chunk.bytes;
          }
        } finally {
          await handle.close();
        }
        if (offset !== info.size) throw new Error("Downloaded " + offset + " of " + info.size + " bytes");
        result = { saved: out, bytes: offset };
      } else if (command === "write") {
        // Chunked upload with an explicit truncate, so replacing a file with a shorter one
        // cannot leave stale bytes behind, and files above the 1 MiB RPC limit still work.
        const remote = need(0),
          local = need(1),
          data = await readFile(local),
          step = 512 * 1024;
        let offset = 0;
        do {
          const part = data.subarray(offset, offset + step);
          await call(device, "files.write_chunk", { path: remote, offset, data: part.toString("base64") });
          offset += part.length;
        } while (offset < data.length);
        await call(device, "files.truncate", { path: remote, size: data.length });
        result = { written: remote, bytes: data.length };
      } else if (command === "launch")
        result = await call(device, "apps.launch", {
          app: need(0),
          cwd: need(1),
          args: args.slice(2),
        });
      else if (command === "screen") {
        const out = need(0);
        const png = await call(device, "screen.capture", {
          monitor: args[1] === undefined ? undefined : Number(args[1]),
        });
        if (!Buffer.isBuffer(png)) throw new Error("Invalid screenshot");
        await writeFile(out, png, { flag: "wx" });
        result = { saved: out };
      } else throw new Error("Unknown command");
      console.log(JSON.stringify(result, null, 2));
      if (
        command === "exec" &&
        (result as { exit_code: number }).exit_code !== 0
      )
        process.exitCode = 1;
    }
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
