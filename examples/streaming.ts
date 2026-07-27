/**
 * streaming.ts — SSE watch + transparency log (#967 Tier 2b).
 *
 * Two related real-time surfaces:
 *   1. `StreamingClient.watch(sql)` — async generator that yields `RowsAppended`
 *      events as commits matching the watch SQL land. Reconnects with
 *      exponential backoff. This is what agent frameworks subscribe to.
 *   2. `LogClient` — `/log/append|head|loadLeaves` is the tamper-evident
 *      audit append-log. Every governed write lands here as a leaf.
 *
 * The example consumes watch events for 5 seconds in a race with a timer,
 * performs a write to trigger an event, then queries the transparency log.
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/streaming.ts
 */

import { createClient, LogClient, StreamingClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "analytics" });
const streaming = StreamingClient.fromClient(relata);
const log = LogClient.fromClient(relata);

async function main(): Promise<void> {
  banner("1. StreamingClient.watch('SELECT * FROM Person') — 5s window");

  // Race the async-generator against a 5-second timeout. The generator
  // reconnects indefinitely, so without the timeout the example would hang.
  let seen = 0;
  const watchIter = streaming.watch("SELECT * FROM Person", "analytics");

  const timer = new Promise((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([
    (async () => {
      for await (const evt of watchIter) {
        seen++;
        out(`  [${seen}] ${JSON.stringify(evt).slice(0, 200)}`);
      }
    })(),
    timer,
  ]).catch(() => undefined);
  out(`watch window elapsed — saw ${seen} event(s)`);

  step("2. Issuing a write to trigger watch events");
  await relata.query("INSERT INTO Person (_pk, name) VALUES ('watch-1', 'Watch Test 1')");
  out("inserted Person watch-1");

  step("3. Alerts stream URL (for external curl consumer)");
  out(`${url}/alerts/stream`);

  step("4. Transparency log (append + head + loadLeaves)");
  const [index, size] = await log.append(JSON.stringify({ action: "example_run" }));
  out(`appended leaf (index=${index}, size=${size})`);
  const head = await log.head();
  out(`log head (tree size) = ${head}`);
}

await main().catch(exitOnRelataError);
