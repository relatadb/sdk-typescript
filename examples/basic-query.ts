/**
 * basic-query.ts — minimal example of querying Relata.
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/basic-query.ts
 *   # or
 *   deno run --allow-net examples/basic-query.ts
 *   # or
 *   bun run examples/basic-query.ts
 */

import { createClient } from "../src/index.ts";
import {
  banner,
  exitOnRelataError,
  fatal,
  loadEnv,
  ok,
  out,
  step,
} from "./_helpers.ts";

// ---------------------------------------------------------------------------
// 1. Create a client (URL + optional bearer token + default purpose)
// ---------------------------------------------------------------------------

const { url, token } = loadEnv();

const relata = createClient(url, {
  bearerToken: token,
  defaultPurpose: "analytics",
  timeoutMs: 15_000,
});

interface Person {
  id: string;
  name: string;
  dob?: string;
  nationality?: string;
}

try {
  // -------------------------------------------------------------------------
  // 2. Health check before querying
  // -------------------------------------------------------------------------

  const health = await relata.health();
  banner("Relata Basic Query Demo");
  out(`Server: ${health.profile} / node ${health.nodeId} — ${health.status}`);

  if (health.status !== "ok") {
    fatal("Server is not healthy. Exiting.");
  }

  // -------------------------------------------------------------------------
  // 3. Raw SQL query — untyped rows
  // -------------------------------------------------------------------------

  step("raw SQL: SELECT * FROM Person LIMIT 10");
  const result = await relata.query("SELECT * FROM Person LIMIT 10");
  out(`  Query ID : ${result.queryId}`);
  out(`  Elapsed  : ${result.elapsedMs}ms`);
  out(`  Rows     : ${result.rowCount}`);
  if (result.rows[0]) out(`  First row: ${JSON.stringify(result.rows[0])}`);

  // -------------------------------------------------------------------------
  // 4. Typed query
  // -------------------------------------------------------------------------

  step("typed SQL: SELECT id, name, dob, nationality FROM Person LIMIT 5");
  const persons = await relata.query<Person>(
    "SELECT id, name, dob, nationality FROM Person LIMIT 5",
  );
  out("  Persons:");
  for (const p of persons.rows) {
    out(
      `    ${p.id} — ${p.name} (${p.nationality ?? "unknown"}, ${p.dob ?? "n/a"})`,
    );
  }

  // -------------------------------------------------------------------------
  // 5. Fluent query builder
  // -------------------------------------------------------------------------

  step("builder: select Person where created_at > '2024-01-01'");
  const recent = await relata
    .select("Person")
    .columns("id", "name", "created_at")
    .where("created_at > '2024-01-01T00:00:00Z'")
    .orderBy("created_at", "DESC")
    .limit(5)
    .execute<Person>();
  ok(`${recent.rows.length} recent persons`);
  for (const p of recent.rows) out(`    ${p.name}`);

  // -------------------------------------------------------------------------
  // 6. Show generated SQL without executing
  // -------------------------------------------------------------------------

  step("builder.toSQL() (dry-run)");
  const sql = relata
    .select("BankAccount")
    .purpose("audit")
    .where("balance_usd > 100000")
    .asOf("2025-01-01T00:00:00Z")
    .withProvenance()
    .orderBy("balance_usd", "DESC")
    .limit(20)
    .toSQL();
  out(`  ${sql}`);
} catch (err) {
  exitOnRelataError(err);
}
