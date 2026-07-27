/**
 * ephemeral-server.ts — spawn a temporary `relata serve`, health check, exit.
 *
 * Requires the `relata` binary on `$PATH` (or `RELATA_BIN`).
 *
 * Run:
 *   node --experimental-strip-types examples/ephemeral-server.ts
 */

import { createServer, Socket } from "node:net";
import { spawn as spawnProc } from "node:child_process";
import { createClient } from "../src/index.ts";
import { banner, exitOnRelataError, out } from "./_helpers.ts";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("could not bind free port"));
      }
    });
  });
}

function tryConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket();
    s.setTimeout(500);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => { s.destroy(); resolve(false); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.connect(port, "127.0.0.1");
  });
}

async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tryConnect(port)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on port ${port} did not start within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  const bin = process.env.RELATA_BIN ?? "relata";
  const port = await freePort();
  const token = "relata-test";

  banner(`Spawning ${bin} serve on port ${port}`);
  const child = spawnProc(bin, ["serve"], {
    env: {
      ...process.env,
      RELATA_PORT: String(port),
      RELATA_BEARER_TOKEN: token,
      RELATA_LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  try {
    await waitForPort(port);
    const url = `http://127.0.0.1:${port}`;
    out(`Server ready at ${url}`);
    const relata = createClient(url, { bearerToken: token, defaultPurpose: "analytics" });
    const health = await relata.health();
    out(`Health: ${JSON.stringify(health)}`);
  } finally {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000);
  }
}

await main().catch(exitOnRelataError);
