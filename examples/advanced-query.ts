/**
 * advanced-query.ts — filtered SELECT + aggregate + Arrow result.
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/advanced-query.ts
 */

import { createClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "analytics" });

interface Row { [k: string]: unknown }

async function main(): Promise<void> {
  banner("1. Filtered SELECT");
  const r1 = await relata.query<Row>(
    "SELECT name, age FROM Person WHERE age > 25 ORDER BY name LIMIT 10",
  );
  out(`Rows: ${r1.rows?.length ?? 0}`);
  for (const row of r1.rows ?? []) out(`  name=${row.name}  age=${row.age}`);

  step("2. COUNT aggregate");
  const r2 = await relata.query<Row>("SELECT COUNT(*) AS total FROM Person");
  out(`Total persons: ${r2.rows?.[0]?.total ?? "?"}`);

  step("3. Streaming Arrow bytes (via StreamingClient.queryArrowRaw)");
  try {
    const { StreamingClient } = await import("../src/index.ts");
    const streaming = StreamingClient.fromClient(relata);
    const iter = streaming.queryArrowRaw("SELECT name, age FROM Person LIMIT 5", {});
    let total = 0;
    for await (const chunk of iter) total += chunk.byteLength;
    await iter.return?.();
    out(`Arrow stream consumed: ${total} bytes`);
  } catch (err) {
    out(`(Arrow streaming path — ${(err as Error).message})`);
  }
}

await main().catch(exitOnRelataError);
