import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  symlink,
  rm,
} from "node:fs/promises";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { createNode, type Config } from "../apps/node/server.js";
import { call, type Device } from "../apps/runtime/client.js";
import { resolveAllowed } from "../packages/security/index.js";
import { run } from "../adapters/windows.js";
import { parseRequest } from "../packages/protocol/index.js";
test("HTTPS authenticated file lifecycle, boundaries and kill switch", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentlink-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "root");
  await mkdir(root);
  const outside = path.join(dir, "outside");
  await mkdir(outside);
  const cert = path.join(dir, "cert.pem"),
    key = path.join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const config: Config = {
    device_id: "test-device",
    name: "Test",
    host: "127.0.0.1",
    port: 0,
    token: "a".repeat(64),
    cert,
    key,
    allowed_roots: [root],
    mode: "developer",
    capabilities: ["filesystem"],
    audit: path.join(dir, "audit.jsonl"),
    kill_switch: path.join(dir, "STOP"),
  };
  const { server } = await createNode(config);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  const device: Device = {
    name: "Test",
    url: `https://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: config.token,
    ca: cert,
    device_id: "test-device",
  };
  assert.equal(((await call(device)) as { name: string }).name, "Test");
  const runtimeConfig = path.join(dir, "runtime.json");
  await writeFile(runtimeConfig, JSON.stringify({ devices: [device] }));
  const cli = await promisify(execFile)(
    process.execPath,
    ["dist/apps/runtime/cli.js", "devices"],
    { env: { ...process.env, AGENTLINK_CONFIG: runtimeConfig } },
  );
  assert.equal(JSON.parse(cli.stdout)[0].online, true);
  await assert.rejects(call({ ...device, token: "wrong" }), /UNAUTHORIZED/);
  await assert.rejects(
    call({ ...device, device_id: "impostor" }),
    /identity mismatch/,
  );
  const file = path.join(root, "中文 文件.txt");
  assert.deepEqual(
    await call(device, "files.write", {
      path: file,
      data: "Hello AgentLink 你好",
      encoding: "utf8",
    }),
    { bytes: Buffer.byteLength("Hello AgentLink 你好") },
  );
  await call(device, "files.write", {
    path: file,
    data: "Hello AgentLink 你好",
    encoding: "utf8",
  });
  const read = (await call(device, "files.read", { path: file })) as {
    data: string;
  };
  assert.equal(
    Buffer.from(read.data, "base64").toString(),
    "Hello AgentLink 你好",
  );
  assert.equal(
    ((await call(device, "files.list", { path: root })) as unknown[]).length,
    1,
  );
  await assert.rejects(
    call(device, "files.write", {
      path: path.join(outside, "bad"),
      data: "x",
      encoding: "utf8",
    }),
    /PATH_DENIED/,
  );
  await writeFile(path.join(outside, "secret"), "secret");
  await symlink(outside, path.join(root, "escape"), "dir");
  await assert.rejects(
    call(device, "files.read", { path: path.join(root, "escape", "secret") }),
    /PATH_DENIED/,
  );
  await symlink(path.join(outside, "missing"), path.join(root, "dangling"));
  await assert.rejects(
    resolveAllowed(path.join(root, "dangling"), [root], true),
    /PATH_DENIED/,
  );
  await assert.rejects(
    call(device, "shell.run", { command: "echo hi", cwd: root }),
    /FORBIDDEN/,
  );
  await writeFile(path.join(root, "large"), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(
    call(device, "files.read", { path: path.join(root, "large") }),
    /1 MiB/,
  );
  const rpcDir=path.join(root,"RPC目录");
  await call(device,"files.mkdir",{path:rpcDir});
  const rpcFile=path.join(rpcDir,"分块.bin");
  await call(device,"files.write_chunk",{path:rpcFile,offset:0,data:Buffer.alloc(800000,42).toString("base64")});
  await call(device,"files.write_chunk",{path:rpcFile,offset:800000,data:Buffer.alloc(800000,17).toString("base64")});
  assert.equal((await call(device,"files.stat",{path:rpcFile}) as {size:number}).size,1600000);
  const block=await call(device,"files.read_chunk",{path:rpcFile,offset:799999,length:2}) as {data:string};
  assert.deepEqual(Buffer.from(block.data,"base64"),Buffer.from([42,17]));
  const moved=path.join(rpcDir,"改名.bin");await call(device,"files.rename",{path:rpcFile,destination:moved});
  await call(device,"files.truncate",{path:moved,size:0});await call(device,"files.delete",{path:moved});await call(device,"files.delete",{path:rpcDir});
  config.mode = "read-only";
  await assert.rejects(call(device,"files.mkdir",{path:rpcDir}),/FORBIDDEN/);
  await assert.rejects(call(device,"files.write_chunk",{path:file,offset:0,data:"eA=="}),/FORBIDDEN/);
  await assert.rejects(call(device,"files.delete",{path:file}),/FORBIDDEN/);
  assert.ok((await call(device,"files.stat",{path:file}) as {size:number}).size>0);

  await assert.rejects(
    call(device, "files.write", { path: file, data: "bad", encoding: "utf8" }),
    /FORBIDDEN/,
  );
  assert.equal(await readFile(file, "utf8"), "Hello AgentLink 你好");
  await writeFile(config.kill_switch, "");
  await assert.rejects(call(device), /disabled/);
  await rm(config.kill_switch);
  await assert.rejects(call(device), /disabled/);
  const audit = await readFile(config.audit, "utf8");
  assert.match(audit, /PATH_DENIED/);
  assert.ok(!audit.includes(config.token));
});
test("protocol rejects malformed input", () => {
  for (const value of [
    null,
    {},
    { id: "x", type: "request", timestamp: 0, action: "evil", payload: {} },
  ])
    assert.throws(() => parseRequest(value));
});
test(
  "execution runner: output, failure, timeout, cancellation",
  { skip: process.platform === "win32" },
  async () => {
    const result = await run(
      "printf hello",
      os.tmpdir(),
      {},
      1000,
      undefined,
      "/bin/sh",
    );
    assert.equal(result.stdout, "hello");
    assert.equal(result.exit_code, 0);
    assert.equal(
      (await run("exit 7", os.tmpdir(), {}, 1000, undefined, "/bin/sh"))
        .exit_code,
      7,
    );
    await assert.rejects(
      run("sleep 10", os.tmpdir(), {}, 50, undefined, "/bin/sh"),
      /TIMEOUT/,
    );
    const abort = new AbortController();
    const task = run(
      "sleep 10",
      os.tmpdir(),
      {},
      1000,
      abort.signal,
      "/bin/sh",
    );
    abort.abort();
    await assert.rejects(task, /Cancelled/);
  },
);
