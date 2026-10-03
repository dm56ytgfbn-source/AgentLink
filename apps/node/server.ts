import {attachNodeInput} from '../input-share/node-transport.js';
import {NativeHelper} from '../input-share/helper.js';
import {layoutSchema,type Layout} from '../../packages/input-share/protocol.js';
import {FileOperations, extendedFileActions} from "../../adapters/filesystem.js";
import { TaskStore } from './tasks.js';
import { AuditLog } from './audit.js';
import { createServer } from "node:https";
import {
  readFile,
  readdir,
  open,
  mkdtemp,
  rm,
  appendFile,
  access,
  writeFile,
} from "node:fs/promises";
import { constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { authorized, resolveAllowed } from "../../packages/security/index.js";
import {
  LinkError,
  normalizeError,
  parseRequest,
  str,
  type NodeInfo,
} from "../../packages/protocol/index.js";
import { screenshot, listWindows, captureWindow, focusWindow, windowInput, killAll } from "../../adapters/windows.js";
import { runHost, launchHost, defaultNodeCapabilities } from '../../adapters/host.js';
import { windowBrokerEnabled } from "../../adapters/windows.js";
import { ReplayGuard, verifySignedRequest } from "../../packages/trust/index.js";
import { PairingService, type PairedClient } from "./pairing.js";
import { startAnnouncer, localAddresses } from "../../packages/discovery/index.js";
import { X509Certificate } from "node:crypto";
export interface Config {
  device_id: string;
  name: string;
  host: string;
  port: number;
  token: string;
  cert: string;
  key: string;
  allowed_roots: string[];
  mode: "read-only" | "developer";
  capabilities: string[];
  audit: string;
  kill_switch: string;
  tasks_dir?: string;
  audit_max_bytes?: number;
  audit_health?: boolean;
  audit_full_command?: boolean;
  // Peers allowed to present a signed request. Absent means token-only (legacy).
  trusted_clients?: Array<{ device_id: string; public_key: string }>;
  tls_server_name?: string;
  // Computers that were allowed in through pairing; persisted next to the audit log.
  paired_clients?: PairedClient[];
  pairing?: { first_run_minutes?: number };
  input_share?: {enabled:boolean;helper:string;layout?:Layout};
}
export function validateConfig(c: Config) {
  if (
    !c ||
    !c.device_id ||
    !c.name ||
    !c.host ||
    !Number.isInteger(c.port) ||
    c.port < 0 ||
    c.port > 65535 ||
    typeof c.token !== "string" ||
    c.token.length < 32 ||
    !Array.isArray(c.allowed_roots) ||
    !c.allowed_roots.length ||
    c.allowed_roots.some((r) => !path.isAbsolute(r)) ||
    !["read-only", "developer"].includes(c.mode) ||
    !Array.isArray(c.capabilities) ||
    c.capabilities.some(
      (x) => !defaultNodeCapabilities().includes(x),
    ) ||
    !c.audit ||
    !c.kill_switch
  )
    throw new Error("Invalid node config");
  if(c.input_share){if(typeof c.input_share.enabled!=='boolean'||!path.isAbsolute(c.input_share.helper))throw Error('Invalid input_share config');if(c.input_share.layout)c.input_share.layout=layoutSchema.parse(c.input_share.layout);}
  if (c.trusted_clients !== undefined) {
    if (!Array.isArray(c.trusted_clients)) throw new Error('trusted_clients must be an array');
    for (const client of c.trusted_clients) {
      if (!client || typeof client.device_id !== 'string' || !client.device_id) throw new Error('trusted_clients entries need a device_id');
      if (typeof client.public_key !== 'string' || client.public_key.length < 32) throw new Error('trusted_clients entries need a public_key');
    }
  }
  if (c.tasks_dir !== undefined && !path.isAbsolute(c.tasks_dir)) throw new Error('tasks_dir must be absolute');
  if (c.capabilities.includes('tasks') && !c.tasks_dir) throw new Error('tasks capability requires tasks_dir');
}
export async function createNode(c: Config, local: { onPairingRequest?: (pendingId: string, client: PairedClient, expires: number) => void; isPairingApproved?: (pendingId: string, client: PairedClient) => boolean } = {}) {
  validateConfig(c);
  const files=new FileOperations(c.allowed_roots);
  await Promise.all(
    c.allowed_roots.map((r) => resolveAllowed(r, c.allowed_roots)),
  );
  const auditLog = new AuditLog({ file:c.audit, maxBytes:c.audit_max_bytes, includeHealth:c.audit_health === true, fullCommand:c.audit_full_command === true });
  await auditLog.initialize();
  // Pairing state: a fresh computer opens a short window so the first computer can join
  // without any manual step; afterwards it stays closed until someone opens it on purpose.
  const pairingMarker = path.join(path.dirname(c.kill_switch), 'PAIRING_OPEN');
  const pairedFile = path.join(path.dirname(c.audit), 'paired-clients.json');
  const pairedClients: PairedClient[] = Array.isArray(c.paired_clients) ? [...c.paired_clients] : [];
  try {
    const stored = JSON.parse(await readFile(pairedFile, 'utf8')) as PairedClient[];
    for (const entry of stored) if (entry?.device_id && !pairedClients.some(client => client.device_id === entry.device_id)) pairedClients.push(entry);
  } catch { /* first run */ }
  const tlsName = c.tls_server_name ?? ('agentlink-' + c.device_id + '.local');
  const certificateFingerprint = new X509Certificate(await readFile(c.cert)).fingerprint256;
  const pairingRequests = path.join(path.dirname(c.audit), 'pairing-requests');
  const pairingApprovals = path.join(path.dirname(c.audit), 'pairing-approvals');
  const pairing = new PairingService({
    markerFile: pairingMarker,
    clients: pairedClients,
    onRequest: local.onPairingRequest ?? ((pendingId, client, expires) => {
      mkdirSync(pairingRequests, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(pairingRequests, pendingId + '.json'), JSON.stringify({ pending_id: pendingId, name: client.name, device_id: client.device_id, expires }), { flag: 'wx', mode: 0o600 });
    }),
    isApproved: local.isPairingApproved ?? (pendingId => existsSync(path.join(pairingApprovals, pendingId + '.approved'))),
    station: () => ({ device_id: c.device_id, name: c.name, os: process.platform, hostname: os.hostname(),
      port: c.port, tls_server_name: tlsName, fingerprint: certificateFingerprint, pairing_open: false, protocol: 1, version: '0.1.0-rc.3' }),
    onPaired: async (client) => {
      await writeFile(pairedFile, JSON.stringify(pairedClients, null, 2) + '\n', { mode: 0o600 });
      void client;
    },
  }, c.pairing?.first_run_minutes ?? 10);
  const announcer = startAnnouncer(() => ({ ...pairing.info(),
    kind: 'agentlink' as const, v: 1, os: process.platform, hostname: os.hostname(), version: '0.2.0',
    host: localAddresses()[0] ?? '127.0.0.1' }));
  const info: NodeInfo = {
    protocol_version: 2,
    features: ['safe-rename-replace', 'default-cwd-v1', ...(c.trusted_clients?.length ? ['signed-requests-v1'] : []), ...(windowBrokerEnabled() ? ['window-broker-external'] : []), ...(c.input_share?.enabled && c.mode==='developer' ? ['input-sharing-v1'] : []), ...(c.tasks_dir && c.capabilities.includes('tasks') ? ['persistent-tasks-v1'] : [])],
    device_id: c.device_id,
    name: c.name,
    os: process.platform,
    hostname: os.hostname(),
    architecture: os.arch(),
    default_cwd: c.allowed_roots[0],
    capabilities: c.capabilities.filter(
      (x) => c.mode !== "read-only" || x === "filesystem",
    ),
  };
  const trustedClients: Record<string, string> = {};
  for (const client of c.trusted_clients ?? []) trustedClients[client.device_id] = client.public_key;
  const replayGuard = new ReplayGuard();
  let disabled = false;
  let stopInputSharing=()=>{};
  const tasks = c.tasks_dir && c.mode === 'developer' && c.capabilities.includes('tasks')
    ? new TaskStore(c.tasks_dir, (input, signal, output) => runHost(input.command, input.cwd, {}, input.timeout, signal, output)) : undefined;
  // Task recovery must run only after the caller has obtained the listening port.
  let tasksReady = false;
  const initializeTasks = async () => { if (tasks) await tasks.initialize(); tasksReady = true; };
  const disable = () => {
    disabled = true;
    announcer.stop();
    stopInputSharing();
    tasks?.stopAll();
    killAll();
  };
  const checkKill = async () => {
    try {
      await access(c.kill_switch);
      disable();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") disable();
    }
  };
  await checkKill();
  const interval = setInterval(() => void checkKill(), 200);
  interval.unref();
  const server = createServer(
    {
      cert: await readFile(c.cert),
      key: await readFile(c.key),
      minVersion: "TLSv1.2",
    },
    async (req, res) => {
      const started = Date.now();
      let id = "",
        action = req.url ?? "",
        detail: unknown = null;
      const send = (status: number, value: unknown) => {
        if (!res.destroyed) {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        }
      };
      const audit = async (result: string) =>
        auditLog.record({
          source: req.socket.remoteAddress,
          target: c.device_id,
          id,
          operation: action,
          detail,
          result,
          duration: Date.now() - started,
        });
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) abort.abort();
      });
      try {
        await checkKill();
        if (disabled)
          throw new LinkError(
            "FORBIDDEN",
            "Agent access disabled; restart with a new token",
          );
        // Pairing endpoints are intentionally unauthenticated: they are how a new computer
        // obtains a credential. Completion requires explicit approval on this computer.
        if (req.url?.startsWith("/pair/")) {
          if (req.method === "GET" && req.url === "/pair/info") { await audit("SUCCESS"); send(200, pairing.info()); return; }
          const raw = await new Promise<string>((resolve, reject) => {
            let size = 0; const parts: Buffer[] = [];
            req.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 16384) { reject(new LinkError("INVALID_REQUEST")); req.destroy(); } else parts.push(chunk); });
            req.on("error", reject);
            req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
          });
          const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
          if (req.method === "POST" && req.url === "/pair/request") {
            const result = pairing.request({ device_id: body.device_id, name: body.name });
            await audit(result.ok ? "SUCCESS" : "FORBIDDEN");
            action = "/pair/request";
            send(result.ok ? 200 : 403, result);
            return;
          }
          if (req.method === "POST" && req.url === "/pair/complete") {
            const result = await pairing.complete(body.pending_id);
            if (!result.ok) { await audit(result.reason === "awaiting-local-approval" ? "SUCCESS" : "FORBIDDEN"); send(result.reason === "awaiting-local-approval" ? 202 : 403, result); return; }
            await audit("SUCCESS");
            send(200, { ok: true, client: result.client, device_id: c.device_id, name: c.name, url: 'https://' + (req.socket.localAddress ?? '127.0.0.1') + ':' + c.port,
              token: c.token, cert_pem: await readFile(c.cert, 'utf8'), tls_server_name: tlsName, fingerprint: certificateFingerprint });
            return;
          }
          send(404, { ok: false, reason: 'NOT_FOUND' });
          return;
        }
        if (!authorized(req.headers.authorization, c.token))
          throw new LinkError("UNAUTHORIZED");
        if (req.method === "GET" && req.url === "/info") {
          await audit("SUCCESS");
          // Task service health is part of the node's reported state: a degraded journal is
          // something the desktop apps should be able to show instead of guessing.
          send(200, tasks ? { ...info, tasks: tasks.health } : info);
          return;
        }
        if (req.method !== "POST" || req.url !== "/rpc")
          throw new LinkError("NOT_FOUND");
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024)
            throw new LinkError("INVALID_REQUEST", "Request exceeds 2 MiB");
          chunks.push(chunk);
        }
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = JSON.parse(rawBody);
        } catch {
          throw new LinkError("INVALID_REQUEST");
        }
        const r = parseRequest(json);
        id = r.id;
        action = r.action;
        const p = r.payload;
        detail = { path: p.path, destination:p.destination, offset:p.offset, length:p.length, size:p.size, cwd: p.cwd, command: p.command, app: p.app, window_id:p.id, input_kind:p.kind, task_id:p.task_id, task_key:p.key };
        // When this node knows a peer's public key, an unsigned or replayed request is refused
        // even if it carries a valid token. Nodes without trusted clients keep the old flow.
        if (c.trusted_clients?.length) {
          const decision = verifySignedRequest({
            method: "POST", path: "/rpc", body: rawBody,
            headers: req.headers as Record<string, string | string[] | undefined>,
            trusted: trustedClients, guard: replayGuard,
          });
          if (!decision.ok) throw new LinkError("UNAUTHORIZED", "Request signature rejected: " + decision.reason);
        }
        const cap = action.startsWith("files.")
          ? "filesystem"
          : action.split(".")[0];
        if (!info.capabilities.includes(cap)) throw new LinkError("FORBIDDEN");
        if (
          c.mode === "read-only" &&
          !["files.list", "files.read", "files.stat", "files.read_chunk"].includes(action)
        )
          throw new LinkError("FORBIDDEN");
        // Fail closed if the operation cannot be recorded before execution.
        await audit("STARTED");
        let result: unknown;
        if (action.startsWith('tasks.')) {
          if (!tasks || !tasksReady) throw new LinkError('BUSY', 'Task service is not ready');
          if (action === 'tasks.submit') result = await tasks.submit({ key: str(p.key), command: str(p.command), cwd: await resolveAllowed(str(p.cwd), c.allowed_roots), timeout: p.timeout === undefined ? 3600000 : Number(p.timeout) });
          else if (action === 'tasks.get') result = await tasks.get(str(p.task_id));
          else if (action === 'tasks.logs') result = await tasks.logs(str(p.task_id), p.cursor === undefined ? 0 : Number(p.cursor));
          else result = await tasks.cancel(str(p.task_id));
        } else if (extendedFileActions.includes(action)) { result=await files.run(action,p); } else if (action === "files.list") {
          const entries = await readdir(
            await resolveAllowed(str(p.path), c.allowed_roots),
            { withFileTypes: true },
          );
          if (entries.length > 10000)
            throw new LinkError(
              "INVALID_REQUEST",
              "Directory exceeds 10000 entries",
            );
          result = entries.map((e) => ({
            name: e.name,
            type: e.isSymbolicLink()
              ? "symlink"
              : e.isDirectory()
                ? "directory"
                : "file",
          }));
        } else if (action === "files.read") {
          const file = await open(
            await resolveAllowed(str(p.path), c.allowed_roots),
            constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
          );
          try {
            const s = await file.stat();
            if (!s.isFile() || s.size > 1024 * 1024)
              throw new LinkError(
                "INVALID_REQUEST",
                "V0 reads regular files up to 1 MiB",
              );
            const b = Buffer.alloc(1024 * 1024 + 1);
            let bytesRead = 0;
            while (bytesRead < b.length) {
              const chunk = await file.read(b, bytesRead, b.length - bytesRead, bytesRead);
              if (chunk.bytesRead === 0) break;
              bytesRead += chunk.bytesRead;
            }
            if (bytesRead > 1024 * 1024) throw new LinkError("INVALID_REQUEST");
            result = {
              encoding: "base64",
              data: b.subarray(0, bytesRead).toString("base64"),
            };
          } finally {
            await file.close();
          }
        } else if (action === "shell.run") {
          const timeout = p.timeout === undefined ? 30000 : Number(p.timeout);
          if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000)
            throw new LinkError("INVALID_REQUEST");
          const environment = p.environment ?? {};
          if (
            typeof environment !== "object" ||
            !environment ||
            Array.isArray(environment) ||
            Object.entries(environment).some(
              ([k, v]) =>
                !k ||
                k.includes("=") ||
                k.includes("\0") ||
                typeof v !== "string" ||
                v.includes("\0"),
            )
          )
            throw new LinkError("INVALID_REQUEST");
          result = await runHost(
            str(p.command),
            await resolveAllowed(str(p.cwd), c.allowed_roots),
            environment as Record<string, string>,
            timeout,
            abort.signal,
          );
        } else if (action === "apps.launch") {
          const args = p.args ?? [];
          if (
            !Array.isArray(args) ||
            args.some((a) => typeof a !== "string" || a.includes("\0"))
          )
            throw new LinkError("INVALID_REQUEST");
          result = await launchHost(
            str(p.app),
            args,
            await resolveAllowed(str(p.cwd), c.allowed_roots),
            abort.signal,
          );
        } else if (action === "screen.capture") {
          const dir = await mkdtemp(path.join(os.tmpdir(), "agentlink-"));
          try {
            const file = path.join(dir, "screen.png");
            await screenshot(file, c.allowed_roots[0], p.monitor, abort.signal);
            const png = await readFile(file);
            await audit("SUCCESS");
            res.writeHead(200, {
              "content-type": "image/png",
              "cache-control": "no-store",
            });
            res.end(png);
            return;
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        } else if (action === "window.list") {
          result = await listWindows(c.allowed_roots[0], abort.signal);
        } else if (action === "window.focus") {
          result = await focusWindow(c.allowed_roots[0], p.id, abort.signal);
        } else if (action === "window.input") {
          result = await windowInput(c.allowed_roots[0], p, abort.signal);
        } else if (action === "window.capture") {
          const dir = await mkdtemp(path.join(os.tmpdir(), "agentlink-window-"));
          try {
            const file = path.join(dir, "window.png");
            await captureWindow(file, c.allowed_roots[0], p.id, abort.signal);
            const png = await readFile(file);
            await audit("SUCCESS");
            res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
            res.end(png);
            return;
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
        await audit("SUCCESS");
        send(200, { id, type: "response", ok: true, result, error: null });
      } catch (e) {
        const error = normalizeError(e);
        try {
          await audit(error.code);
        } catch {
          disable();
        }
        send(
          error.code === "UNAUTHORIZED"
            ? 401
            : error.code === "FORBIDDEN" || error.code === "PATH_DENIED"
              ? 403
              : error.code === "NOT_FOUND"
                ? 404
                : error.code === "INVALID_REQUEST"
                  ? 400
                  : 500,
          {
            id,
            type: "response",
            ok: false,
            result: null,
            error: { code: error.code, message: error.message },
          },
        );
      }
    },
  );
  stopInputSharing=attachNodeInput(server,{device_id:c.device_id,token:c.token,enabled:()=>!disabled&&c.mode==='developer'&&c.input_share?.enabled===true,helper:()=>new NativeHelper(c.input_share!.helper),layout:c.input_share?.layout});
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on("close", () => {
    clearInterval(interval);
    disable();
  });
  return { server, info, disable, initializeTasks };
}
