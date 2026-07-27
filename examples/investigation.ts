/**
 * investigation.ts — PATHS_BETWEEN operator for forensic link analysis.
 *
 * Run:
 *   RELATA_TOKEN=secret FROM_ID=person-001 TO_ID=org-001 \
 *     node --experimental-strip-types examples/investigation.ts
 */

import { createClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, {
  bearerToken: token,
  defaultPurpose: "investigation",
  timeoutMs: 120_000,
});

const src = process.env.FROM_ID ?? "person-001";
const dst = process.env.TO_ID ?? "org-hawala-001";
const maxHops = Number.parseInt(process.env.MAX_HOPS ?? "4", 10);

interface Row { [k: string]: unknown }

async function main(): Promise<void> {
  banner(`Direct connection: ${src} <-> ${dst}`);
  const r1 = await relata.query<Row>(
    `SELECT path_id, edge_type, total_path_weight ` +
      `FROM PATHS_BETWEEN('${src}', '${dst}', max_hops => 1) ` +
      `ORDER BY total_path_weight DESC LIMIT 10`,
  );
  const direct = r1.rows ?? [];
  if (direct.length > 0) {
    out(`Directly connected via ${direct.length} edge(s):`);
    for (const row of direct) {
      out(`  ${String(row.edge_type ?? "?").padEnd(30)}  weight=${row.total_path_weight}`);
    }
  } else {
    out("No direct connection found.");
  }

  step(`Multi-hop traversal: ${src} → ${dst} (max_hops=${maxHops})`);
  const r2 = await relata.query<Row>(
    `SELECT path_id, edge_type, hop_count, total_path_weight, path_json ` +
      `FROM PATHS_BETWEEN('${src}', '${dst}', max_hops => ${maxHops}) ` +
      `ORDER BY hop_count ASC, total_path_weight DESC LIMIT 100`,
  );
  const rows = r2.rows ?? [];
  out(`${rows.length} path(s) found (${r2.elapsedMs ?? "?"} ms)`);
  for (const row of rows.slice(0, 10)) {
    out(
      `  [${row.hop_count ?? "?"} hops, weight=${row.total_path_weight ?? "?"}]  via ${row.edge_type ?? "?"}`,
    );
  }
}

await main().catch(exitOnRelataError);
