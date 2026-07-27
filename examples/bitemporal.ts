/**
 * bitemporal.ts — point-in-time travel + provenance (Phase 3, ADR-117).
 *
 * Relata is bi-temporal: every row carries four timestamps —
 *   - `valid_from` / `valid_to`     — when the fact was true in the real world
 *   - `system_from` / `system_to`   — when the database knew about it
 *
 * Two SQL clauses operate on these:
 *
 *   `AS OF '<ts>'`        — point-in-time snapshot (rows whose
 *                           `[valid_from, valid_to)` interval contains `<ts>`
 *                           AND whose `[system_from, system_to)` interval also
 *                           contains `<ts>`).
 *   `WITH PROVENANCE`     — adds PROV-O columns: `source_id`, `collector`,
 *                           `method`, `confidence`, `observed_at`, `recorded_at`.
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/bitemporal.ts
 */

import { createClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "analytics" });

interface Row { [k: string]: unknown }
const PROV_KEYS = ["source_id", "collector", "method", "confidence", "observed_at", "recorded_at"];

async function run(sql: string, label: string): Promise<void> {
  const result = await relata.query(sql);
  const rows = (result.rows ?? []) as Row[];
  out(`${label}: ${rows.length} row(s)`);
  for (const row of rows.slice(0, 5)) out(`  ${JSON.stringify(row)}`);
}

async function main(): Promise<void> {
  banner("1. Current snapshot of Person");
  await run("SELECT _pk, name, valid_from, valid_to FROM Person LIMIT 5", "current");

  step("2. AS OF '2024-06-01' — point-in-time snapshot");
  await run("SELECT _pk, name FROM Person AS OF '2024-06-01' LIMIT 5", "as-of");

  step("3. WITH PROVENANCE — provenance columns");
  const withProv = await relata.query("SELECT _pk, name FROM Person WITH PROVENANCE LIMIT 5");
  for (const row of (withProv.rows ?? []).slice(0, 5) as Row[]) {
    const prov: Record<string, unknown> = {};
    for (const k of PROV_KEYS) if (k in row) prov[k] = row[k];
    out(`  _pk=${row._pk}  name=${row.name}  prov=${JSON.stringify(prov)}`);
  }

  step("4. Combined: AS OF + WITH PROVENANCE — forensic snapshot");
  await run(
    "SELECT _pk, name, source_id FROM Person AS OF '2024-06-01' WITH PROVENANCE LIMIT 5",
    "as-of+prov",
  );

  step("5. Temporal shift: who was present at each date?");
  for (const [label, ts] of [["2024-01-01", "2024-01-01"], ["2024-06-01", "2024-06-01"], ["2025-01-01", "2025-01-01"]]) {
    const r = await relata.query(`SELECT COUNT(*) AS n FROM Person AS OF '${ts}'`);
    const n = (r.rows?.[0] as Row?)?.n ?? "?";
    out(`  ${label}: ${n} row(s)`);
  }

  step("6. IR builder: query().from(...).asOf(...).withProvenance().build()");
  // The TS QueryBuilder lives in `src/builder.ts` and emits a JSON IR. The IR
  // is the same shape the Rust `QueryBuilder::build()` produces — documented
  // in `docs/api/query-ir.md`. The SQL form above is the simpler integration;
  // use the IR form when you want to inspect/transform the structured query
  // before sending.
  const { query } = await import("../src/builder.ts");
  const ir = query()
    .purpose("analytics")
    .from("Person")
    .asOf("2024-06-01")
    .withProvenance()
    .limit(5)
    .build();
  out(`IR built: ${JSON.stringify(ir).slice(0, 200)}...`);
}

await main().catch(exitOnRelataError);
