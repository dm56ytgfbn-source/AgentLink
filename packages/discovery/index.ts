import dgram from 'node:dgram';
import os from 'node:os';

// Two computers running AgentLink must find each other without typing an address. A small
// UDP announcement on the local network is enough here (no DNS-SD daemon, no dependency):
// every instance repeats a compact description of itself, and any instance can collect the
// announcements for a moment to build a list of reachable computers.

export const DISCOVERY_PORT = 47823;
export const DISCOVERY_VERSION = 1;

export interface Announcement {
  v: number;
  kind: 'agentlink';
  device_id: string;
  name: string;
  os: string;
  hostname: string;
  port: number;
  host: string;
  fingerprint: string;
  pairing_open: boolean;
  version: string;
}

export function isAnnouncement(value: unknown): value is Announcement {
  const message = value as Partial<Announcement> | null;
  return !!message && typeof message === 'object'
    && message.kind === 'agentlink' && message.v === DISCOVERY_VERSION
    && typeof message.device_id === 'string' && !!message.device_id
    && typeof message.name === 'string'
    && Number.isInteger(message.port) && (message.port as number) > 0 && (message.port as number) < 65536
    && typeof message.host === 'string' && !!message.host
    && typeof message.fingerprint === 'string';
}

function localAddresses(): string[] {
  const result: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) result.push(entry.address);
    }
  }
  return result;
}

export interface AnnouncerOptions { port?: number; intervalMs?: number; target?: string; sockets?: dgram.Socket[] }

// A computer that carries a virtual adapter (VMware, VirtualBox, Hyper-V) can send
// 255.255.255.255 out of that adapter instead of the real network, and the announcement then
// never reaches anybody. Sending to each interface's own subnet broadcast as well makes the
// packet follow that interface's route, which is the one the other computer can answer on.
export function broadcastTargets(): string[] {
  const targets = new Set<string>(['255.255.255.255']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const address = entry.address.split('.').map(Number);
      const mask = entry.netmask.split('.').map(Number);
      if (address.length !== 4 || mask.length !== 4) continue;
      targets.add(address.map((part, index) => (part & mask[index]) | (~mask[index] & 0xff)).join('.'));
    }
  }
  return [...targets];
}

export function startAnnouncer(build: () => Announcement, options: AnnouncerOptions = {}) {
  const port = options.port ?? DISCOVERY_PORT;
  const targets = options.target ? [options.target] : broadcastTargets();
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let timer: NodeJS.Timeout | undefined;
  socket.on('error', () => { /* a network without broadcast must not crash the product */ });
  socket.bind(() => {
    try { socket.setBroadcast(true); } catch { /* loopback-only testing */ }
    const send = () => {
      const message = Buffer.from(JSON.stringify(build()));
      for (const target of targets) socket.send(message, port, target, () => { /* ignore unreachable networks */ });
    };
    send();
    timer = setInterval(send, options.intervalMs ?? 2000);
    timer.unref?.();
  });
  return { stop() { if (timer) clearInterval(timer); try { socket.close(); } catch { /* already closed */ } } };
}

export interface BrowseOptions { port?: number; timeoutMs?: number; target?: string; bindAddress?: string }

// Collects announcements for a short window. Own broadcasts are ignored so a computer never
// lists itself as a pairable peer.
export function browse(options: BrowseOptions = {}): Promise<Announcement[]> {
  const port = options.port ?? DISCOVERY_PORT;
  const timeoutMs = options.timeoutMs ?? 1500;
  const found = new Map<string, Announcement>();
  return new Promise(resolve => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const finish = () => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on('message', (data, remote) => {
      try {
        const value: unknown = JSON.parse(data.toString('utf8'));
        if (!isAnnouncement(value)) return;
        // Prefer the address the packet actually came from: it is the one that routes back.
        found.set(value.device_id, { ...value, host: remote.address });
      } catch { /* ignore foreign traffic on this port */ }
    });
    socket.on('error', finish);
    socket.bind({ port, address: options.bindAddress ?? '0.0.0.0', exclusive: false }, () => {
      try { socket.setBroadcast(true); } catch { /* loopback-only testing */ }
    });
  });
}

export function describePeers(peers: Announcement[]) {
  return peers.map(peer => ({ name: peer.name, host: peer.host, port: peer.port,
    os: peer.os, pairing_open: peer.pairing_open, fingerprint: peer.fingerprint.slice(0, 16) }));
}

export { localAddresses };
