/**
 * streaming.ts — SSE watch (#967 Tier 2b).
 *
 * Real-time surface:
 *   `StreamingClient.watch(sql)` — async generator that yields `RowsAppended`
 *      events as commits matching the watch SQL land. Reconnects with
 *      exponential backoff. This is what agent frameworks subscribe to.
 *
 * The example consumes watch events for 5 seconds in a race with a timer,
 * and performs a write to trigger an event.
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/streaming.ts
 */

import { createClient, IngestClient, StreamingClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "analytics" });
const streaming = StreamingClient.fromClient(relata);
const ingest = IngestClient.fromClient(relata);

async function main(): Promise<void> {
  banner("1. StreamingClient.watch('SELECT * FROM Person') — 5s window");

  // Race the async-generator against a 5-second timeout. The generator
  // reconnects indefinitely, so without the timeout the example would hang.
  // `Promise.race` alone does NOT cancel the losing side, though — the
  // `for await` loop keeps driving `watchIter` forever after the timer wins
  // (#5020). Explicitly call `watchIter.return()` once the timer fires, and
  // await the consumer promise afterward so the generator's `finally` block
  // (which closes the underlying SSE connection) has actually run before we
  // move on — otherwise the process can still hang at exit.
  let seen = 0;
  const watchIter = streaming.watch("SELECT * FROM Person", "analytics");

  const consumeEvents = (async () => {
    for await (const evt of watchIter) {
      seen++;
      out(`  [${seen}] ${JSON.stringify(evt).slice(0, 200)}`);
    }
  })();
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000));

  const winner = await Promise.race([
    consumeEvents.then(() => "done" as const),
    timer,
  ]).catch(() => "error" as const);
  if (winner !== "done") {
    // Timer won (or the consumer errored) — ask the generator to stop
    // reconnecting and tear down its SSE connection.
    await watchIter.return(undefined).catch(() => undefined);
  }
  // Wait for the consumer to fully settle either way, so its cleanup
  // (reader.cancel()) has run before we proceed.
  await consumeEvents.catch(() => undefined);
  out(`watch window elapsed — saw ${seen} event(s)`);

  // `/v1/query` is read-only (#782) — writes go through the governed ingest
  // door, not SQL INSERT.
  step("2. Issuing a write to trigger watch events");
  await ingest.bulk("Person", [{ _pk: "watch-1", name: "Watch Test 1" }]);
  out("inserted Person watch-1");

  step("3. Alerts stream URL (for external curl consumer)");
  out(`${url}/v1/alerts/stream`);
}

await main().catch(exitOnRelataError);
