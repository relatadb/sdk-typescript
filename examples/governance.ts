/**
 * governance.ts — PURPOSE declaration, audit trail, type listing.
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/governance.ts
 */

import { createClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token });

async function main(): Promise<void> {
  banner("1. Query under PURPOSE 'analytics'");
  const r1 = await relata.query("SELECT * FROM Person LIMIT 3", { purpose: "analytics" });
  out(`Rows returned: ${r1.rows?.length ?? 0}`);

  step("2. Same query under PURPOSE 'audit'");
  const r2 = await relata.query("SELECT * FROM Person LIMIT 3", { purpose: "audit" });
  out(`Rows returned: ${r2.rows?.length ?? 0}`);

  step("3. Audit log");
  const auditCount = await relata.auditCount();
  out(`Audit entries: ${JSON.stringify(auditCount)}`);

  step("4. List registered object types");
  const types = (await relata.listTypes()) as { types?: { name?: string }[] } | { name?: string }[];
  const list = Array.isArray(types) ? types : types?.types ?? [];
  out(`${list.length} type(s):`);
  for (const t of list.slice(0, 10)) out(`  - ${t.name}`);
}

await main().catch(exitOnRelataError);
