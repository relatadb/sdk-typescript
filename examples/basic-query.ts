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

import { createClient, PurposeError, AuthError, NetworkError } from "../src/index.ts";

// ---------------------------------------------------------------------------
// 1. Create a client (URL + optional bearer token + default purpose)
// ---------------------------------------------------------------------------

const relata = createClient("http://localhost:9090", {
  bearerToken: process.env["RELATA_TOKEN"],
  defaultPurpose: "analytics",
  timeoutMs: 15_000,
});

// ---------------------------------------------------------------------------
// 2. Health check before querying
// ---------------------------------------------------------------------------

const health = await relata.health();
console.log(`Server: ${health.profile} / node ${health.nodeId} — ${health.status}`);

if (health.status !== "ok") {
  console.error("Server is not healthy. Exiting.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Raw SQL query — untyped rows
// ---------------------------------------------------------------------------

try {
  const result = await relata.query("SELECT * FROM Person LIMIT 10");

  console.log(`\nQuery ID : ${result.queryId}`);
  console.log(`Elapsed  : ${result.elapsedMs}ms`);
  console.log(`Rows     : ${result.rowCount}`);
  console.log("\nFirst row:", result.rows[0]);
} catch (err) {
  if (err instanceof PurposeError) {
    // This shouldn't happen because we set defaultPurpose, but good practice.
    console.error("Purpose rejected:", err.message);
  } else if (err instanceof AuthError) {
    console.error("Auth failed — set RELATA_TOKEN:", err.message);
  } else if (err instanceof NetworkError) {
    console.error("Cannot reach server:", err.message);
  } else {
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 4. Typed query
// ---------------------------------------------------------------------------

interface Person {
  id: string;
  name: string;
  dob?: string;
  nationality?: string;
}

const persons = await relata.query<Person>(
  "SELECT id, name, dob, nationality FROM Person LIMIT 5",
);

console.log("\nTyped persons:");
for (const p of persons.rows) {
  console.log(`  ${p.id} — ${p.name} (${p.nationality ?? "unknown"}, ${p.dob ?? "n/a"})`);
}

// ---------------------------------------------------------------------------
// 5. Fluent query builder
// ---------------------------------------------------------------------------

const recent = await relata
  .select("Person")
  .columns("id", "name", "created_at")
  .where("created_at > '2024-01-01T00:00:00Z'")
  .orderBy("created_at", "DESC")
  .limit(5)
  .execute<Person>();

console.log("\nRecent persons (builder API):");
for (const p of recent.rows) {
  console.log(`  ${p.name}`);
}

// ---------------------------------------------------------------------------
// 6. Show generated SQL without executing
// ---------------------------------------------------------------------------

const sql = relata
  .select("BankAccount")
  .purpose("audit")
  .where("balance_usd > 100000")
  .asOf("2025-01-01T00:00:00Z")
  .withProvenance()
  .orderBy("balance_usd", "DESC")
  .limit(20)
  .toSQL();

console.log("\nGenerated SQL:\n ", sql);
