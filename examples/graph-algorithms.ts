/**
 * graph-algorithms.ts — graph operator chain for fraud-ring + centrality
 * analysis (#967).
 *
 * Demonstrates the typed graph algorithm operators on the TS client:
 *   - graphDijkstra        — shortest path between two entities
 *   - graphPageRank        — centrality (who are the hub entities?)
 *   - graphSCC             — strongly connected components (fraud-ring)
 *   - graphCycles          — cyclic flow (e.g. money-laundering loops)
 *   - graphTriangleCount   — triadic closure (co-offending networks)
 *
 * Each operator translates to a governed SQL TVF call (POST /query) with the
 * caller's purpose recorded in the audit log.
 *
 * Run:
 *   FROM_ID=p1 TO_ID=p2 node --experimental-strip-types examples/graph-algorithms.ts
 */

import { createClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "investigation" });

const TYPE = "Person";
const fromId = process.env.FROM_ID ?? "person-001";
const toId = process.env.TO_ID ?? "person-002";

interface Row { [k: string]: unknown }
interface Resp { rows?: Row[]; count?: number }

function printRows(label: string, resp: unknown, fields: string[]): void {
  const obj = resp as Resp;
  const rows = obj.rows ?? [];
  if (rows.length === 0) {
    out(`  (empty result — ${JSON.stringify(resp).slice(0, 200)})`);
    return;
  }
  const shown = Math.min(rows.length, 10);
  out(`  ${label}: ${rows.length} row(s), showing first ${shown}:`);
  for (const row of rows.slice(0, shown)) {
    out(`    ${fields.map((f) => `${f}=${row[f]}`).join("  ")}`);
  }
}

async function main(): Promise<void> {
  banner(`1. GRAPH_DIJKSTRA: ${fromId} → ${toId}`);
  const path = await relata.graphDijkstra(TYPE, fromId, toId, "investigation");
  printRows("paths", path, ["hop", "node_id", "edge_type", "weight"]);

  step("2. GRAPH_PAGERANK: top-5 by centrality (damping=0.85, 20 iter)");
  const centrality = await relata.graphPageRank(TYPE, { damping: 0.85, maxIter: 20, purpose: "investigation" });
  printRows("centrality", centrality, ["node_id", "score"]);

  step("3. GRAPH_SCC: fraud-ring candidates (≥3-node SCCs)");
  const scc = (await relata.graphSCC(TYPE, "investigation")) as Resp;
  const sccRows = scc.rows ?? [];
  const big = sccRows.filter((r) => Number(r.size ?? 0) >= 3);
  out(`  ${sccRows.length} SCC(s) total, ${big.length} with size ≥ 3`);
  big.slice(0, 5).forEach((ring) =>
    out(`    scc_id=${String(ring.scc_id ?? "?").padEnd(10)} size=${ring.size}`),
  );

  step("4. GRAPH_CYCLES: cyclic flows");
  const cycles = await relata.graphCycles(TYPE, "investigation");
  printRows("cycles", cycles, ["cycle_id", "length", "nodes"]);

  step("5. GRAPH_TRIANGLE_COUNT: triadic closure");
  const triangles = (await relata.graphTriangleCount(TYPE, "investigation")) as Resp;
  const triCount =
    typeof triangles.count === "number"
      ? triangles.count
      : Number(triangles.rows?.[0]?.count ?? 0);
  out(`  ${triCount} triangle(s) found`);
}

await main().catch(exitOnRelataError);
