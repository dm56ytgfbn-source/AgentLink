import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { createNode, type Config } from "./server.js";
import { killAll } from "../../adapters/windows.js";
const [command, file = "node.local.json", root = process.cwd()] =
  process.argv.slice(2);
try {
  if (command === "init") {
    const config: Config = {
      device_id: randomUUID(),
      name: os.hostname(),
      host: "127.0.0.1",
      port: 7443,
      token: randomBytes(32).toString("hex"),
      cert: path.resolve("cert.pem"),
      key: path.resolve("key.pem"),
      allowed_roots: [path.resolve(root)],
      mode: "read-only",
      capabilities: ["filesystem"],
      audit: path.resolve("audit.jsonl"),
      kill_switch: path.resolve("DISABLE_AGENT_ACCESS"),
    };
    await writeFile(file, JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log(`Created ${file}. Configure TLS certificates before starting.`);
  } else if (command === "serve") {
    const c: Config = JSON.parse(await readFile(file, "utf8"));
    const { server, disable, initializeTasks } = await createNode(c);
    server.on('error', (e: NodeJS.ErrnoException) => { console.error(e.code ?? 'LISTEN_FAILED'); disable(); process.exitCode = 1; });
    server.listen(c.port, c.host, async () => {
      try { await initializeTasks(); } catch { console.error('TASK_RECOVERY_FAILED'); disable(); }
      console.log(
        `AgentLink ${c.name} listening on https://${c.host}:${c.port}`,
      );
    });
    for (const sig of ["SIGINT", "SIGTERM"] as const)
      process.on(sig, () => {
        disable();
        killAll();
        server.closeAllConnections();
        server.close();
      });
  } else {
    console.log(
      "node dist/apps/node/main.js init [config] [allowed-root]\nnode dist/apps/node/main.js serve [config]",
    );
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
