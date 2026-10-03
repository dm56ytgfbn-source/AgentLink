import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Server as HttpsServer } from 'node:https';
import { createNode, type Config } from '../node/server.js';
import { setupNode } from '../node/setup.js';

export interface PendingPair { pending_id: string; name: string; device_id: string; expires: number }

// Hosted inside the one-app local UI process. Starting it is an explicit user action;
// opening the settings window alone never exposes a listener on the LAN.
export class LocalNodeControl {
  private active: { server: HttpsServer; disable: () => void; config: Config } | null = null;
  constructor(private directory = path.join(os.homedir(), '.agentlink-node'), private shareRoot?: string) {}

  get running() { return this.active !== null; }
  async start() {
    if (this.active) return this.status();
    const setup = await setupNode({ directory: this.directory, ...(this.shareRoot ? { shareRoot: this.shareRoot } : {}) });
    const config = JSON.parse(await readFile(setup.config, 'utf8')) as Config;
    if (config.host === '127.0.0.1' || config.host === 'localhost')
      throw new Error('本机节点只监听本机地址；请先检查旧配置，不能自动扩大访问范围');
    const node = await createNode(config);
    try {
      await new Promise<void>((resolve, reject) => {
        node.server.once('error', reject);
        node.server.listen(config.port, config.host, () => { node.server.off('error', reject); resolve(); });
      });
      await node.initializeTasks();
      this.active = { server: node.server, disable: node.disable, config };
      return this.status();
    } catch (error) {
      node.disable();
      if (node.server.listening) node.server.closeAllConnections();
      node.server.close();
      throw error;
    }
  }

  async stop() {
    const active = this.active;
    this.active = null;
    if (!active) return;
    active.disable();
    active.server.closeAllConnections();
    await new Promise<void>(resolve => active.server.close(() => resolve()));
  }

  async status() {
    const config = this.active?.config;
    return { running: !!config, name: config?.name ?? '', port: config?.port ?? null,
      pending: await this.pending() };
  }

  async openPairing() {
    const config = this.requireActive();
    await writeFile(path.join(path.dirname(config.kill_switch), 'PAIRING_OPEN'),
      'Opened from AgentLink settings at ' + new Date().toISOString() + '\n', { mode: 0o600 });
  }

  async pending(): Promise<PendingPair[]> {
    const config = this.active?.config;
    if (!config) return [];
    const base = path.dirname(config.audit);
    const directory = path.join(base, 'pairing-requests');
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const result: PendingPair[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{48}\.json$/.test(name)) continue;
      try {
        const request = JSON.parse(await readFile(path.join(directory, name), 'utf8')) as PendingPair;
        if (request.pending_id !== name.slice(0, -5) || request.expires <= Date.now() ||
          existsSync(path.join(base, 'pairing-approvals', request.pending_id + '.approved'))) continue;
        result.push(request);
      } catch { /* damaged request cannot be approved */ }
    }
    return result.sort((a, b) => a.expires - b.expires);
  }

  async approve(pendingId: string) {
    if (!/^[a-f0-9]{48}$/.test(pendingId)) throw new Error('无效的配对请求');
    const config = this.requireActive();
    if (!(await this.pending()).some(request => request.pending_id === pendingId))
      throw new Error('配对请求不存在或已过期');
    const directory = path.join(path.dirname(config.audit), 'pairing-approvals');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, pendingId + '.approved'), 'approved', { flag: 'wx', mode: 0o600 });
  }

  private requireActive(): Config {
    if (!this.active) throw new Error('请先开启这台电脑的接收服务');
    return this.active.config;
  }
}
