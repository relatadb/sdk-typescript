/**
 * multi-tenant.ts — write as tenant A, verify tenant B cannot read the data.
 *
 * The server must be running with `RELATA_TENANCY_MODE=multi` and two
 * admin-issued bearer tokens for two different tenants.
 *
 * Run:
 *   RELATA_TOKEN_A=<token-a> RELATA_TOKEN_B=<token-b> \
 *     node --experimental-strip-types examples/multi-tenant.ts
 */

import { createClient, IngestClient } from "../src/index.ts";
import { banner, exitOnRelataError, out, step } from "./_helpers.ts";

const url = process.env.RELATA_URL ?? "http://localhost:9090";
const tokenA = process.env.RELATA_TOKEN_A ?? "token-a";
const tokenB = process.env.RELATA_TOKEN_B ?? "token-b";

async function main(): Promise<void> {
  banner(`Tenant A: ingest`);
  const clientA = createClient(url, { bearerToken: tokenA, defaultPurpose: "data-load" });
  const ingest = IngestClient.fromClient(clientA);
  const receipt = await ingest.bulk("SecretRecord", [
    { _pk: "s1", secret: "tenant-a-only", value: 42 },
  ]);
  out(`Tenant A receipt: ${JSON.stringify(receipt)}`);

  step("Tenant A: query (should see ≥1 row)");
  const r1 = await clientA.query("SELECT secret FROM SecretRecord LIMIT 10");
  out(`Tenant A sees ${r1.rows?.length ?? 0} row(s)`);

  step("Tenant B: query (should see 0 rows — org isolation)");
  const clientB = createClient(url, { bearerToken: tokenB, defaultPurpose: "analytics" });
  const r2 = await clientB.query("SELECT secret FROM SecretRecord LIMIT 10");
  out(`Tenant B sees ${r2.rows?.length ?? 0} row(s)`);
}

await main().catch(exitOnRelataError);
