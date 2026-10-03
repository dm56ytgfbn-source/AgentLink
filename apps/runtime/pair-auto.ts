import https from 'node:https';
import {setTimeout as wait} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {X509Certificate} from 'node:crypto';
import {browse, type Announcement} from '../../packages/discovery/index.js';
import {resolvePaths, type Paths} from '../../packages/config/index.js';
import {importPairing, type PairingBundle} from './pairing.js';
import {setupNode} from '../node/setup.js';

// The whole "open it on two computers" flow: find the other computer on the network, ask it
// to pair, and store what it hands back. No addresses typed, no files copied.

export interface PairResult {
  peer: string; host: string; port: number; device_id: string; fingerprint: string;
  file: string; devices: string[]; backup: string | null;
}

export function discoverComputers(options: { timeoutMs?: number } = {}): Promise<Announcement[]> {
  return browse({ timeoutMs: options.timeoutMs ?? 1500 });
}

// Broadcast is not always usable: a computer carrying a virtual adapter (VMware, VirtualBox,
// Hyper-V) can send it out of that interface instead of the real one, and some networks drop
// it outright. Typing the address therefore has to work just as well, so the same station
// information is fetched over a direct connection. The fingerprint is taken from the
// certificate that connection actually presented, not from the answer body, so the later
// pairing requests are pinned to the machine we really reached.
export function describeHost(host: string, port = 7443, timeoutMs = 8000): Promise<Announcement> {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL('https://' + host + ':' + port + '/pair/info'), {
      method: 'GET', rejectUnauthorized: false, timeout: timeoutMs, agent: false,
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          const certificate = (request.socket as { getPeerCertificate?: () => { raw?: Buffer } }).getPeerCertificate?.();
          resolve({ v: 1, kind: 'agentlink', host, port,
            device_id: String(body.device_id ?? ''), name: String(body.name ?? host),
            os: String(body.os ?? ''), hostname: String(body.hostname ?? ''),
            fingerprint: certificate?.raw ? new X509Certificate(certificate.raw).fingerprint256 : '',
            pairing_open: body.pairing_open === true, version: String(body.version ?? '') });
        } catch { reject(new Error(host + ' 返回了无效响应，那个地址上可能不是 AgentLink')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('连接超时：' + host + ':' + port + '（确认对方电脑开着、服务在跑、防火墙放行了）')));
    request.on('error', reject);
    request.end();
  });
}

interface JsonResponse { status: number; body: Record<string, unknown>; }

function postJson(url: URL, payload: unknown, expectedFingerprint: string, timeoutMs = 8000): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const request = https.request(url, {
      method: 'POST', rejectUnauthorized: false, timeout: timeoutMs, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }); }
        catch { reject(new Error('对方返回了无效响应')); }
      });
    });
    request.on('timeout', () => { request.destroy(new Error('连接超时')); });
    request.on('error', reject);
    // The certificate is compared with the fingerprint the computer announced, so an unrelated
    // device answering at that address cannot take the pairing over.
    request.on('socket', socket => {
      const verify = () => {
        const certificate = (socket as { getPeerCertificate?: () => { raw?: Buffer } }).getPeerCertificate?.();
        if (!certificate?.raw) return;
        const fingerprint = new X509Certificate(certificate.raw).fingerprint256;
        if (expectedFingerprint && fingerprint !== expectedFingerprint) {
          request.destroy(new Error('证书指纹与对方广播的不一致，已中止配对'));
        }
      };
      // A reused connection never fires secureConnect again, so verify immediately when the
      // socket is already up (pooling is disabled above, this is belt and braces).
      if (socket.connecting) socket.on('secureConnect', verify);
      else verify();
    });
    request.end(body);
  });
}

export interface PairAttempt { peer: Announcement; pendingId: string; expires: number }
export interface LocalPairIdentity { directory?: string; shareRoot?: string }
export async function beginPairWith(peer: Announcement, name?: string, identity: LocalPairIdentity = {}): Promise<PairAttempt> {
  if (!peer.pairing_open) throw new Error('对方当前不允许配对，请在对方电脑重新开放配对窗口');
  const base = new URL('https://' + peer.host + ':' + peer.port);
  const directory = identity.directory ?? path.join(os.homedir(), '.agentlink-node');
  // Pairing is a user action. Prepare one durable identity here, even if this computer has
  // not yet enabled inbound access; the same identity is reused when it later does so.
  const setup = await setupNode({ directory, ...(identity.shareRoot ? { shareRoot: identity.shareRoot } : {}) });
  const started = await postJson(new URL('/pair/request', base), { device_id: setup.device_id, name: name ?? setup.name }, peer.fingerprint);
  if (started.status !== 200 || started.body.ok !== true)
    throw new Error('对方拒绝了配对请求（' + String(started.body.reason ?? started.status) + '）');
  return { peer, pendingId: String(started.body.pending_id), expires: Date.now() + 120_000 };
}

export async function finishPairWith(attempt: PairAttempt, paths = resolvePaths()): Promise<PairResult> {
  if (Date.now() >= attempt.expires) throw new Error('配对请求已过期，请重试');
  const { peer, pendingId } = attempt;
  const base = new URL('https://' + peer.host + ':' + peer.port);
  let finished: JsonResponse;
  do {
    finished = await postJson(new URL('/pair/complete', base), { pending_id: pendingId }, peer.fingerprint);
    if (finished.status !== 202) break;
    if (Date.now() + 1500 >= attempt.expires) throw new Error('Windows 上未在两分钟内允许连接，请重新尝试');
    await wait(1500);
  } while (true);
  if (finished.status !== 200 || finished.body.ok !== true)
    throw new Error('配对未能完成（' + String(finished.body.reason ?? finished.status) + '）');
  const bundle: PairingBundle = {
    version: 1, created_at: new Date().toISOString(),
    warning: '配对导入时自动生成，包含访问对端电脑的凭据。',
    devices: [{
      name: String(finished.body.name), url: String(finished.body.url), device_id: String(finished.body.device_id),
      tls_server_name: String(finished.body.tls_server_name), token: String(finished.body.token),
      cert_pem: String(finished.body.cert_pem),
    }],
  };
  const imported = await importPairing(bundle, { paths, replace: true });
  return { peer: peer.name, host: peer.host, port: peer.port, device_id: String(finished.body.device_id),
    fingerprint: String(finished.body.fingerprint ?? ''), file: imported.file, devices: imported.devices,
    backup: imported.backup };
}

export async function pairWith(peer: Announcement, options: { paths?: Paths; name?: string; localIdentity?: LocalPairIdentity } = {}): Promise<PairResult> {
  const attempt = await beginPairWith(peer, options.name, options.localIdentity);
  return finishPairWith(attempt, options.paths);
}
