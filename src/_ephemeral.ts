/**
 * Ephemeral Relata server helper for integration tests (Node.js only).
 *
 * Usage (Jest / Vitest):
 *
 * ```ts
 * import { spawnEphemeral } from './_ephemeral';
 *
 * describe('relata integration', () => {
 *   let server: Awaited<ReturnType<typeof spawnEphemeral>>;
 *   beforeAll(async () => { server = await spawnEphemeral(); });
 *   afterAll(() => server.stop());
 *
 *   it('health', async () => {
 *     const r = await fetch(`http://127.0.0.1:${server.port}/health`);
 *     expect(r.ok).toBe(true);
 *   });
 * });
 * ```
 */

import * as child_process from 'child_process';
import * as net from 'net';

/** Pick a free TCP port by asking the OS for one. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Poll until a TCP connection succeeds or timeout (ms). */
async function waitReady(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`relata on port ${port} did not start within ${timeoutMs} ms`);
}

export interface EphemeralServer {
  port: number;
  token: string;
  baseUrl: string;
  stop(): void;
}

/** Spawn a `relata serve` process on a random port and resolve when ready. */
export async function spawnEphemeral(): Promise<EphemeralServer> {
  const port = await freePort();
  const token = process.env.RELATA_TEST_TOKEN ?? 'relata-test';
  const bin = process.env.RELATA_BIN ?? 'relata';

  const proc = child_process.spawn(bin, ['serve'], {
    env: { ...process.env, RELATA_PORT: String(port), RELATA_BEARER_TOKEN: token, RELATA_LOG_LEVEL: 'warn' },
    stdio: 'ignore',
  });

  await waitReady(port);

  return {
    port,
    token,
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => { proc.kill(); },
  };
}
