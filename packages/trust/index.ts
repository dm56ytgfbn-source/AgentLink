import {createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify} from 'node:crypto';

// The trust anchor for "who may use this computer". A bearer token proves only that a caller
// once read a file; a signature proves possession of a private key that never leaves the
// other machine's keychain, and a nonce makes a captured request useless afterwards.
// Everything here is symmetric: the Mac client and the Windows node run the same code.

export interface DeviceKeyPair { public_key: string; private_key: string }

export const SIGNATURE_HEADERS = {
  device: 'x-agentlink-device',
  timestamp: 'x-agentlink-timestamp',
  nonce: 'x-agentlink-nonce',
  signature: 'x-agentlink-signature',
} as const;

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    private_key: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function bodyDigest(body: string | Buffer | undefined): string {
  return createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex');
}

// The signed string covers the method, the path, freshness, uniqueness and the exact body.
export function canonicalRequest(input: { method: string; path: string; timestamp: number; nonce: string; body: string | Buffer | undefined }): string {
  return [input.method.toUpperCase(), input.path, String(input.timestamp), input.nonce, bodyDigest(input.body)].join('\n');
}

export function signRequest(privateKeyBase64: string, canonical: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(canonical, 'utf8'), key).toString('base64');
}

export function verifyRequest(publicKeyBase64: string, canonical: string, signatureBase64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(canonical, 'utf8'), key, Buffer.from(signatureBase64, 'base64'));
  } catch { return false; }
}

export function newNonce(): string { return randomBytes(16).toString('hex'); }

export function publicKeyFingerprint(publicKeyBase64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 32);
}

export interface ReplayDecision { ok: boolean; reason?: 'stale-timestamp' | 'future-timestamp' | 'replayed-nonce' }

// Bounded, in-memory replay window. A captured request cannot be replayed inside the window,
// and the table cannot grow without limit.
export class ReplayGuard {
  private seen = new Map<string, number>();
  private windowMs: number;
  private limit: number;
  private now: () => number;
  constructor(options: { windowMs?: number; limit?: number; now?: () => number } = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.limit = options.limit ?? 10_000;
    this.now = options.now ?? (() => Date.now());
  }
  accept(nonce: string, timestamp: number): ReplayDecision {
    const now = this.now();
    if (!Number.isFinite(timestamp)) return { ok: false, reason: 'stale-timestamp' };
    if (timestamp < now - this.windowMs) return { ok: false, reason: 'stale-timestamp' };
    if (timestamp > now + this.windowMs) return { ok: false, reason: 'future-timestamp' };
    if (this.seen.has(nonce)) return { ok: false, reason: 'replayed-nonce' };
    this.seen.set(nonce, timestamp + this.windowMs);
    if (this.seen.size > this.limit) this.prune();
    return { ok: true };
  }
  private prune() {
    const now = this.now();
    for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key);
    while (this.seen.size > this.limit) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
  get size() { return this.seen.size; }
}

export interface SignedHeaders { [key: string]: string | string[] | undefined }
export interface VerificationResult { ok: boolean; reason?: string; device_id?: string }

// Server-side entry point: look up the trusted public key, rebuild the canonical string from
// the request as received, and reject anything stale, replayed or signed by another key.
export function verifySignedRequest(input: {
  method: string; path: string; body: string; headers: SignedHeaders;
  trusted: Record<string, string>; guard: ReplayGuard;
}): VerificationResult {
  const read = (name: string): string | undefined => {
    const value = input.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const deviceId = read(SIGNATURE_HEADERS.device);
  const timestamp = Number(read(SIGNATURE_HEADERS.timestamp));
  const nonce = read(SIGNATURE_HEADERS.nonce);
  const signature = read(SIGNATURE_HEADERS.signature);
  if (!deviceId || !nonce || !signature || !Number.isFinite(timestamp)) return { ok: false, reason: 'missing-signature-headers' };
  const publicKey = input.trusted[deviceId];
  if (!publicKey) return { ok: false, reason: 'untrusted-device' };
  const canonical = canonicalRequest({ method: input.method, path: input.path, timestamp, nonce, body: input.body });
  if (!verifyRequest(publicKey, canonical, signature)) return { ok: false, reason: 'bad-signature' };
  const replay = input.guard.accept(nonce, timestamp);
  if (!replay.ok) return { ok: false, reason: replay.reason };
  return { ok: true, device_id: deviceId };
}
