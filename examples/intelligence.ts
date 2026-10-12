/**
 * intelligence.ts — chained KYC / sanctions sweep (#967).
 *
 * Demonstrates governed-query source retrieval and retained intelligence helpers:
 *   - OwnershipEdge and TransactionGraph rows — caller-owned analysis inputs
 *   - convoyDetect                — find entities travelling together
 *   - dnsTunnelDetect             — local triage over governed query pages
 *
 * Ownership and transaction queries retrieve source rows only; this example does
 * not reproduce their retired graph analyses. Sanctions matching and review
 * remain application responsibilities.
 *
 * Run:
 *   RELATA_TOKEN=secret TARGET_PARTY="Acme Holdings Ltd" \
 *     node --experimental-strip-types examples/intelligence.ts
 */

import { createClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const target = process.env.TARGET_PARTY ?? "Acme Holdings Ltd";
const relata = createClient(url, {
  bearerToken: token,
  defaultPurpose: "investigation",
});

interface Row { [k: string]: unknown }

async function main(): Promise<void> {
  banner("1. Sanctions reference data (application matching policy required)");
  const people = await relata.queryWithParams<Row>(
    "SELECT id, name, dob FROM Person WHERE name = $1 LIMIT 100",
    [target],
    { purpose: "compliance" },
  );
  const entries = await relata.query<Row>(
    "SELECT name, aliases, dob, list_name, program FROM SanctionEntry LIMIT 10000",
    { purpose: "compliance" },
  );
  out(`fetched ${people.rows.length} Person row(s) and ${entries.rows.length} sanctions reference row(s)`);
  out("apply your approved application-owned matching, list-version, and review policy; no built-in screen is provided");
  if (people.truncated || entries.truncated || people.next_cursor || entries.next_cursor) {
    out("source results are incomplete; do not treat them as a negative screen");
  }

  step("2. OwnershipEdge source rows (application analysis required)");
  const ownership = await relata.query<Row>(
    "SELECT subject, predicate, object, ownership_pct, jurisdiction FROM OwnershipEdge LIMIT 1000",
    { purpose: "investigation" },
  );
  out(`fetched ${ownership.rows.length} ownership source row(s)`);
  if (ownership.truncated || ownership.nextCursor) out("source result is incomplete; do not treat it as a complete ownership chain");
  out("apply documented ownership traversal and legal review outside this SDK");

  step(`3. TransactionGraph source rows for ${target} (retrieval only)`);
  const transactions = await relata.query<Row>(
    "SELECT from_wallet, to_wallet, amount, asset, chain, is_mixer FROM TransactionGraph LIMIT 1000",
    { purpose: "investigation" },
  );
  out(`fetched ${transactions.rows.length} transaction source row(s)`);
  if (transactions.truncated || transactions.nextCursor) out("source result is incomplete; do not treat it as a complete transaction trace");
  out("apply approved graph-walk and attribution policy outside this SDK");

  step("4. CONVOY_DETECT: radius=200m, time_tol=300s, min_points=2");
  const convoys = (await relata.convoyDetect({
    radiusM: 200,
    timeTolSecs: 300,
    minPoints: 2,
    purpose: "investigation",
  })) as { rows?: Row[] } | undefined;
  const cRows = convoys?.rows ?? [];
  out(`${cRows.length} convoy(s) detected`);
  for (const row of cRows.slice(0, 5)) {
    out(`  convoy_id=${row.convoy_id ?? "?"}  members=${row.members}  first_seen=${row.first_seen}`);
  }

  step("5. DNS tunnel triage");
  const dns = await relata.dnsTunnelDetect({ purpose: "investigation" });
  const dRows = dns?.rows ?? [];
  out(`${dRows.length} anomalous DNS pattern(s); complete=${dns.complete} rows_scanned=${dns.rows_scanned}`);
  for (const row of dRows.slice(0, 5)) {
    out(
      `  domain=${String(row.domain ?? "?").padEnd(30)} entropy=${row.avg_entropy} queries=${row.query_count} max_label_len=${row.max_label_len} confidence=${row.confidence}`,
    );
  }
}

await main().catch(exitOnRelataError);
