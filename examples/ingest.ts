/**
 * ingest.ts — batch ingest + CSV ingest via IngestClient.
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/ingest.ts
 */

import { createClient, IngestClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "data-load" });
const ingest = IngestClient.fromClient(relata);

async function main(): Promise<void> {
  banner("1. Bulk NDJSON ingest (3 rows)");
  const receipt = await ingest.bulk("Person", [
    { _pk: "p1", name: "Alice", email: "alice@example.com", age: 30 },
    { _pk: "p2", name: "Bob", email: "bob@example.com", age: 25 },
    { _pk: "p3", name: "Carol", email: "carol@example.com", age: 35 },
  ]);
  out(`Receipt: ${JSON.stringify(receipt)}`);

  step("2. CSV ingest");
  const csv = "_pk,name,email\np4,Dave,dave@example.com\np5,Eve,eve@example.com\n";
  const csvReceipt = await ingest.bulkCsv("Person", csv);
  out(`Receipt: ${JSON.stringify(csvReceipt)}`);

  step("3. Verify rows are queryable");
  const result = await relata.query("SELECT name, age FROM Person ORDER BY name LIMIT 10");
  out(`${result.rows?.length ?? 0} row(s) returned`);
}

await main().catch(exitOnRelataError);
