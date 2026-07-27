/**
 * parameterized.ts — server-side $N binding (#1162).
 *
 * `$N` placeholders are substituted safely by the server before planning — no
 * string concatenation, no SQL injection. Use this for any query that takes
 * caller-supplied values.
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/parameterized.ts
 */

import { createClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "analytics" });

interface Row { [k: string]: unknown }

function printRows(result: { rows?: Row[]; rowCount?: number }, label: string): void {
  const rows = result.rows ?? [];
  if (rows.length === 0) {
    out(`${label}: (empty result)`);
    return;
  }
  out(`${label}: ${rows.length} row(s)`);
  for (const row of rows.slice(0, 10)) out(`  ${JSON.stringify(row)}`);
}

async function main(): Promise<void> {
  banner("1. Single-parameter filter (age = $1)");
  printRows(
    await relata.queryWithParams<Row>("SELECT name, age FROM Person WHERE age = $1", [30]),
    "age=30"
  );

  step("2. Multi-type parameters (age > $1 AND city = $2)");
  printRows(
    await relata.queryWithParams<Row>(
      "SELECT name, age, city FROM Person WHERE age > $1 AND city = $2 ORDER BY name",
      [25, "Karachi"],
    ),
    "filtered"
  );

  step("3. NULL / bool / float parameters");
  printRows(
    await relata.queryWithParams<Row>(
      "SELECT _pk FROM Sample WHERE flagged = $1 AND score >= $2 AND note IS NOT DISTINCT FROM $3",
      [true, 0.85, null],
    ),
    "typed"
  );

  step("4. IN-list via repeated placeholders");
  printRows(
    await relata.queryWithParams<Row>(
      "SELECT _pk FROM Person WHERE _pk IN ($1, $2, $3)",
      ["p1", "p2", "p3"],
    ),
    "in-list"
  );
}

await main().catch(exitOnRelataError);
