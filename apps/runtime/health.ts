import { call, type Device } from './client.js';
import type { NodeInfo } from '../../packages/protocol/index.js';

export type HealthProbe = (device: Device) => Promise<NodeInfo>;

// Deliberately exclude exception messages: OS/server messages can contain credentials.
export function connectionFailure(error: unknown) {
  const e = error as { code?: string; message?: string } | null;
  const code = e?.code ?? (e?.message === 'TIMEOUT' ? 'TIMEOUT' : '');
  const issue = (error_code: string, summary: string, next_action: string, retryable = false) =>
    ({ error_code, summary, next_action, retryable });
  if (code === 'IDENTITY_MISMATCH' || e?.message === 'Device identity mismatch')
    return issue('IDENTITY_MISMATCH', '连接目标与已配对电脑身份不符', '在 Windows 本机核对设备身份；不要自动替换配对信息。');
  if (code === 'UNAUTHORIZED')
    return issue('AUTH_FAILED', '认证未通过', '核对两端配对凭据；不要在聊天或日志中粘贴 token。');
  if (code === 'FORBIDDEN')
    return issue('ACCESS_DENIED', '电脑拒绝访问', '在 Windows 本机检查权限和紧急停止状态。');
  if (code.includes('CERT') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    return issue('TLS_FAILED', '证书验证未通过', '核对证书有效期和配对地址；保持证书验证开启。');
  if (['ENOENT', 'EACCES', 'EPERM', 'INVALID_CONFIG', 'ERR_INVALID_URL'].includes(code))
    return issue('CONFIG_INVALID', '本机配对配置或证书不可用', '检查配对地址和证书文件是否存在且可读。');
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code))
    return issue('NAME_UNRESOLVED', '无法解析电脑地址', '确认网络连接和已配对电脑的主机名。', code === 'EAI_AGAIN');
  if (code === 'ECONNREFUSED')
    return issue('CONNECTION_REFUSED', '目标拒绝连接', '确认 Windows 已启动 AgentLink Node，并核对当前地址和端口。', true);
  if (['TIMEOUT', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN'].includes(code))
    return issue('NETWORK_UNREACHABLE', '连接超时或网络不可达', '确认电脑已唤醒、处于可达网络，检查地址和防火墙；保持 Mac 使用 DHCP。', true);
  if (['ECONNRESET', 'EPIPE'].includes(code))
    return issue('CONNECTION_INTERRUPTED', '连接中断', '等待 Node 就绪后重新检查；不要直接重复提交写入或执行任务。', true);
  return issue('CHECK_FAILED', '连接检查失败', '查看本机诊断记录；尚不能确认是网络、协议还是服务异常。');
}

export async function inspectDevice(
  device: Device,
  options: {
    attempts?: number;
    probe?: HealthProbe;
    wait?: (ms: number) => Promise<void>;
  } = {},
) {
  const max = Math.max(1, Math.min(3, Math.trunc(options.attempts ?? 1) || 1));
  const probe = options.probe ?? (async d => await call(d) as NodeInfo);
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    const attemptStart = Date.now();
    try {
      const info = await probe(device);
      if (info.device_id !== device.device_id) throw Object.assign(new Error(), { code: 'IDENTITY_MISMATCH' });
      if (typeof info.hostname !== 'string' || typeof info.os !== 'string' ||
          typeof info.architecture !== 'string' || !Array.isArray(info.capabilities) ||
          !info.capabilities.every(c => typeof c === 'string')) throw new Error('Invalid info response');
      return {
        device_id: device.device_id, name: device.name, local: false, online: true,
        status: 'ready', hostname: info.hostname, os: info.os, architecture: info.architecture,
        capabilities: info.capabilities, latency_ms: Date.now() - attemptStart,
        elapsed_ms: Date.now() - start,
        checked_at: new Date().toISOString(), attempts: attempt,
      };
    } catch (e) {
      const failure = connectionFailure(e);
      if (failure.retryable && attempt < max) {
        await wait(250 * 2 ** (attempt - 1));
        continue;
      }
      return {
        device_id: device.device_id, name: device.name, local: false, online: false,
        status: 'unavailable', error: 'NODE_OFFLINE_OR_UNTRUSTED', ...failure,
        checked_at: new Date().toISOString(), attempts: attempt, elapsed_ms: Date.now() - start,
      };
    }
  }
}
