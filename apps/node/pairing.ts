import {statSync} from 'node:fs';
import {randomBytes} from 'node:crypto';

// New clients need a local, explicit decision from the computer being controlled.
export interface PairedClient { device_id: string; name: string; paired_at: string }
export interface StationInfo {
  device_id: string; name: string; os: string; hostname: string; port: number;
  tls_server_name: string; fingerprint: string; pairing_open: boolean; protocol: number; version?: string;
}
export interface PairingDependencies {
  station: () => StationInfo;
  markerFile: string;
  clients: PairedClient[];
  onPaired: (client: PairedClient) => Promise<void>;
  onRequest?: (pendingId: string, client: PairedClient, expires: number) => void;
  isApproved: (pendingId: string, client: PairedClient) => boolean;
  now?: () => number;
  requestTtlMs?: number;
}
export function pairingWindowOpen(markerFile: string, hasClients: boolean, until: number, now: number): boolean {
  let manual = false;
  try { const age = now - statSync(markerFile).mtimeMs; manual = age >= 0 && age < 10 * 60_000; } catch {}
  return manual || (!hasClients && now < until);
}
export class PairingService {
  private pending = new Map<string, { client: PairedClient; expires: number }>();
  private requests: number[] = [];
  private firstRunUntil: number;
  private now: () => number;
  private ttl: number;
  constructor(private dependencies: PairingDependencies, firstRunMinutes = 10) {
    this.now = dependencies.now ?? (() => Date.now());
    this.ttl = dependencies.requestTtlMs ?? 120000;
    this.firstRunUntil = this.now() + firstRunMinutes * 60_000;
  }
  get open(): boolean {
    return pairingWindowOpen(this.dependencies.markerFile, this.dependencies.clients.length > 0, this.firstRunUntil, this.now());
  }
  info(): StationInfo { return { ...this.dependencies.station(), pairing_open: this.open }; }
  request(client: { device_id?: unknown; name?: unknown }): { ok: true; pending_id: string } | { ok: false; reason: string } {
    if (!this.open) return { ok: false, reason: 'pairing-closed' };
    const deviceId = typeof client?.device_id === 'string' ? client.device_id.trim() : '';
    const name = typeof client?.name === 'string' ? client.name.trim() : '';
    if (!deviceId || deviceId.length > 200) return { ok: false, reason: 'invalid-device-id' };
    if (!name || name.length > 200) return { ok: false, reason: 'invalid-name' };
    if (this.dependencies.clients.some(entry => entry.device_id === deviceId)) return { ok: false, reason: 'already-paired' };
    this.prune();
    this.requests = this.requests.filter(at => this.now() - at < 60_000);
    if (this.requests.length >= 5 || this.pending.size >= 5) return { ok: false, reason: 'rate-limited' };
    this.requests.push(this.now());
    const pendingId = randomBytes(24).toString('hex');
    const entry = { client: { device_id: deviceId, name, paired_at: new Date().toISOString() }, expires: this.now() + this.ttl };
    this.pending.set(pendingId, entry);
    try { this.dependencies.onRequest?.(pendingId, entry.client, entry.expires); }
    catch (error) { this.pending.delete(pendingId); throw error; }
    return { ok: true, pending_id: pendingId };
  }
  async complete(pendingId: unknown): Promise<{ ok: true; client: PairedClient } | { ok: false; reason: string }> {
    this.prune();
    const entry = typeof pendingId === 'string' ? this.pending.get(pendingId) : undefined;
    if (!entry) return { ok: false, reason: 'no-such-request' };
    if (!this.open) return { ok: false, reason: 'pairing-closed' };
    if (!this.dependencies.isApproved(pendingId as string, entry.client)) return { ok: false, reason: 'awaiting-local-approval' };
    this.pending.delete(pendingId as string);
    this.dependencies.clients.push(entry.client);
    try { await this.dependencies.onPaired(entry.client); }
    catch (error) { this.dependencies.clients.pop(); throw error; }
    return { ok: true, client: entry.client };
  }
  get pendingCount(): number { this.prune(); return this.pending.size; }
  private prune() {
    const now = this.now();
    for (const [key, entry] of this.pending) if (entry.expires <= now) this.pending.delete(key);
  }
}
