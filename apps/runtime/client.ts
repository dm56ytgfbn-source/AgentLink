import {LinkError} from "../../packages/protocol/index.js";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { defaultSecretStore, type SecretStore } from "../../packages/secrets/index.js";
import { SIGNATURE_HEADERS, canonicalRequest, newNonce, signRequest } from "../../packages/trust/index.js";
import type {
  Action,
  NodeInfo,
  Response,
} from "../../packages/protocol/index.js";
export interface Device {
  name: string;
  url: string;
  // A device either carries the secret inline (legacy configuration) or points at the system
  // keychain through token_ref. Both are supported so existing pairings keep working.
  token?: string;
  token_ref?: string;
  // Identity presented to this peer. The private key stays in the system keychain; only its
  // reference travels with the configuration.
  signing?: { device_id: string; public_key: string; key_ref?: string; key_pem?: string };
  ca: string;
  device_id: string;
  tls_server_name?: string;
  // Addresses that answered with this exact device before. A DHCP change is then a
  // re-probe instead of a manual repair.
  url_history?: string[];
}

export async function resolveSigningKey(device: Device, store?: SecretStore | null): Promise<string | null> {
  const signing = device.signing;
  if (!signing) return null;
  if (signing.key_pem) return signing.key_pem;
  if (!signing.key_ref) return null;
  const active = store === undefined ? await defaultSecretStore() : store;
  return active ? active.get(signing.key_ref) : null;
}

export async function resolveToken(device: Device, store?: SecretStore | null): Promise<string> {
  if (device.token) return device.token;
  const account = device.token_ref;
  if (!account) throw Object.assign(new Error('Paired computer has no credential; pair it again'), { code: 'INVALID_CONFIG' });
  const active = store === undefined ? await defaultSecretStore() : store;
  if (!active) throw Object.assign(new Error('This credential is kept in the system keychain, which is not available here'), { code: 'INVALID_CONFIG' });
  const value = await active.get(account);
  if (!value) throw Object.assign(new Error('Credential not found in the system keychain; pair this computer again'), { code: 'INVALID_CONFIG' });
  return value;
}
export function requestDeadline(action?: Action, payload: Record<string, unknown> = {}) {
  if (!action) return 5000;
  if (action === 'shell.run') {
    const timeout = Number(payload.timeout ?? 30000);
    return Number.isFinite(timeout) ? Math.min(300000, Math.max(1, timeout)) + 10000 : 310000;
  }
  return 20000;
}
export async function call(
  device: Device,
  action?: Action,
  payload: Record<string, unknown> = {},
): Promise<unknown> {
  const url = new URL(action ? "/rpc" : "/info", device.url);
  if (url.protocol !== "https:") throw Object.assign(new Error("HTTPS required"), { code: 'INVALID_CONFIG' });
  if (device.tls_server_name !== undefined && (typeof device.tls_server_name !== 'string' || device.tls_server_name.length > 253 || !device.tls_server_name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))) throw Object.assign(new Error('Invalid paired TLS name'), { code: 'INVALID_CONFIG' });
  const ca = await readFile(device.ca);
  const token = await resolveToken(device);
  const requestId = randomUUID();
  const duration = requestDeadline(action, payload);
  const requestBody = action
    ? JSON.stringify({ id: requestId, type: "request", action, payload, timestamp: Date.now() })
    : undefined;
  // Signing is opt-in per paired computer; without key material the previous token flow is
  // used unchanged, so existing pairings keep working.
  const signingHeaders: Record<string, string> = {};
  const privateKey = await resolveSigningKey(device);
  if (privateKey && device.signing) {
    const timestamp = Date.now(), nonce = newNonce();
    const canonical = canonicalRequest({ method: action ? "POST" : "GET", path: url.pathname, timestamp, nonce, body: requestBody });
    signingHeaders[SIGNATURE_HEADERS.device] = device.signing.device_id;
    signingHeaders[SIGNATURE_HEADERS.timestamp] = String(timestamp);
    signingHeaders[SIGNATURE_HEADERS.nonce] = nonce;
    signingHeaders[SIGNATURE_HEADERS.signature] = signRequest(privateKey, canonical);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: action ? "POST" : "GET",
        ca,
        rejectUnauthorized: true,
        // The pinned configuration names the TLS identity; the URL is its current network route.
        servername: device.tls_server_name,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...signingHeaders,
        },
        timeout: duration,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (b: Buffer) => {
          size += b.length;
          if (size > 32 * 1024 * 1024)
            res.destroy(new Error("Response limit exceeded"));
          else chunks.push(b);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const b = Buffer.concat(chunks);
            if (
              res.statusCode === 200 &&
              res.headers["content-type"] === "image/png"
            ) {
              resolve(b);
              return;
            }
            const value = JSON.parse(b.toString());
            if (res.statusCode !== 200)
              throw new LinkError(String(value.error?.code ?? "INTERNAL_ERROR") as never, value.error?.message ?? "Node request failed");
            if (!action) {
              if ((value as NodeInfo).device_id !== device.device_id)
                throw new Error("Device identity mismatch");
              resolve(value);
            } else {
              const r = value as Response;
              if (r.id !== requestId || r.type !== "response") throw new Error("Invalid response identity");
              if (!r.ok) throw new LinkError(r.error?.code ?? 'INTERNAL_ERROR', r.error?.message);
              resolve(r.result);
            }
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("TIMEOUT")));
    // Bound the entire transport exchange, not just socket inactivity. A timed-out mutation
    // has an uncertain outcome and is never replayed here. Long work uses durable tasks.
    const deadline = setTimeout(() => req.destroy(new LinkError('TIMEOUT')), duration);
    req.once('close', () => clearTimeout(deadline));
    req.on("error", reject);
    req.end(requestBody);
  });
}
