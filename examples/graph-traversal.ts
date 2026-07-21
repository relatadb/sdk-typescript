/**
 * graph-traversal.ts — graph traversal operators in Relata.
 *
 * Demonstrates:
 *   1. PATHS_BETWEEN — shortest paths between two entities
 *   2. NETWORK_EXPAND — expand from a seed to N hops
 *   3. MATCH syntax — sub-graph pattern matching
 *   4. Pregel BFS via raw SQL
 *   5. PageRank-style influence scoring
 *
 * Graph queries use the CSR (Compressed Sparse Row) backend with PLL
 * (Pruned Landmark Labelling) index for sub-millisecond shortest-path
 * queries (SPECS §5.12 / ADR-037).
 *
 * Run:
 *   node --experimental-strip-types examples/graph-traversal.ts
 */

import { createClient, QuotaError } from "../src/index.ts";
import {
  banner,
  exitOnRelataError,
  loadEnv,
  out,
  softFail,
  step,
} from "./_helpers.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PathEdge {
  path_id: string;
  hop_index: number;
  from_id: string;
  from_type: string;
  to_id: string;
  to_type: string;
  link_type: string;
  link_weight: number;
  _prov_confidence?: number;
}

interface NetworkNode {
  node_id: string;
  node_type: string;
  name?: string;
  degree: number;
  betweenness?: number;
}

interface SuspectNetEdge {
  from_id: string;
  to_id: string;
  link_type: string;
  confidence: number;
  hops_from_seed: number;
}

interface MatchResult {
  subject_id: string;
  subject_name: string;
  intermediary_id: string;
  target_id: string;
  target_name: string;
  pattern: string;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const { url, token } = loadEnv();

const relata = createClient(url, {
  bearerToken: token,
  defaultPurpose: "analytics",
  timeoutMs: 45_000,
});

// Seed nodes for demo — replace with real IDs from your data
const SEED_ID   = process.env["SEED_ID"]   ?? "person-001";
const TARGET_ID = process.env["TARGET_ID"] ?? "org-042";

try {
  const health = await relata.health();
  banner("Relata Graph Traversal Demo");
  out(`Seed   : ${SEED_ID}`);
  out(`Target : ${TARGET_ID}`);
  out(`Server : ${health.nodeId} (${health.profile})`);

  // -------------------------------------------------------------------------
  // 1. PATHS_BETWEEN — find all shortest paths (up to 4 hops)
  // -------------------------------------------------------------------------

  step("1: PATHS_BETWEEN (max_hops=4, with provenance)");

  try {
    // Using the fluent builder
    const pathsResult = await relata
      .select("Person")
      .pathsBetween(SEED_ID, TARGET_ID, { maxHops: 4 })
      .purpose("analytics")
      .withProvenance()
      .limit(20)
      .execute<PathEdge>();

    out(
      `  Paths found: ${pathsResult.rowCount}  (${pathsResult.elapsedMs}ms)`,
    );

    if (pathsResult.rowCount > 0) {
      // Group by path_id
      const paths = new Map<string, PathEdge[]>();
      for (const edge of pathsResult.rows) {
        const bucket = paths.get(edge.path_id) ?? [];
        bucket.push(edge);
        paths.set(edge.path_id, bucket);
      }

      let pathNo = 1;
      for (const [, hops] of paths) {
        const sorted = hops.sort((a, b) => a.hop_index - b.hop_index);
        const route = sorted
          .map((h) => `${h.from_id}(${h.from_type})`)
          .concat(`${sorted.at(-1)!.to_id}(${sorted.at(-1)!.to_type})`);

        out(`  Path ${pathNo++}: ${route.join(" → ")} [${sorted.length} hop(s)]`);
        if (pathNo > 4) {
          out(`  ... ${paths.size - 3} more paths`);
          break;
        }
      }
    }
  } catch (err) {
    if (err instanceof QuotaError) {
      softFail("Quota exhausted — try a smaller max_hops");
    } else throw err;
  }

  // -------------------------------------------------------------------------
  // 2. NETWORK_EXPAND — grow the network from seed
  // -------------------------------------------------------------------------

  step("2: NETWORK_EXPAND (seed, hops=3, confidence>0.6)");

  const netResult = await relata.query<SuspectNetEdge>(
    `SELECT from_id, to_id, link_type, confidence, hops_from_seed
     FROM NETWORK_EXPAND(
       seed_id   => '${SEED_ID}',
       hops      => 3
     )
     WHERE confidence > 0.6
     ORDER BY hops_from_seed ASC, confidence DESC
     LIMIT 500`,
  );

  out(`  Nodes reachable: ${netResult.rowCount}  (${netResult.elapsedMs}ms)`);

  // Aggregate by hop distance
  const byHop = new Map<number, number>();
  for (const e of netResult.rows) {
    byHop.set(e.hops_from_seed, (byHop.get(e.hops_from_seed) ?? 0) + 1);
  }
  for (const [hop, count] of [...byHop].sort((a, b) => a[0] - b[0])) {
    out(`  Hop ${hop}: ${count} edge(s)`);
  }

  // Top link types
  const byType = new Map<string, number>();
  for (const e of netResult.rows) {
    byType.set(e.link_type, (byType.get(e.link_type) ?? 0) + 1);
  }
  const topTypes = [...byType].sort((a, b) => b[1] - a[1]).slice(0, 5);
  out(`  Top link types: ${topTypes.map(([t, c]) => `${t}(${c})`).join(", ")}`);

  // -------------------------------------------------------------------------
  // 3. MATCH — subgraph pattern matching
  //    Find: Person → PhoneCall → Person → BankTransfer → BankAccount
  // -------------------------------------------------------------------------

  step("3: MATCH — find Person-via-call-to-Person-with-transaction");

  const matchResult = await relata.query<MatchResult>(
    `SELECT
       subject_id,
       subject_name,
       intermediary_id,
       target_id,
       target_name,
       'call→txn' AS pattern
     FROM MATCH (
       (p1:Person)-[:PhoneCall]->(p2:Person)-[:Transaction]->(p3:Person)
     )
     WHERE p1.id = '${SEED_ID}'
       AND p3.risk_score > 0.7
     LIMIT 50`,
  );

  out(`  Patterns matched: ${matchResult.rowCount}  (${matchResult.elapsedMs}ms)`);
  for (const m of matchResult.rows.slice(0, 3)) {
    out(`  ${m.subject_name} → ${m.intermediary_id} → ${m.target_name}`);
  }

  // -------------------------------------------------------------------------
  // 4. Pregel BFS — reachability from seed (raw SQL)
  //    This demonstrates multi-round iterative graph computation via the
  //    Pregel engine (SPECS §5.12.4 / ADR-037).
  // -------------------------------------------------------------------------

  step("4: Pregel BFS reachability (4 rounds)");

  const bfsResult = await relata.query<NetworkNode>(
    `SELECT node_id, node_type, name, degree
     FROM PREGEL_BFS(
       seed_id    => '${SEED_ID}',
       max_rounds => 4,
       edge_types => ARRAY['PhoneCall', 'Transaction', 'Association']
     )
     ORDER BY degree DESC
     LIMIT 100`,
  );

  out(`  Reachable nodes: ${bfsResult.rowCount}  (${bfsResult.elapsedMs}ms)`);
  const highDegree = bfsResult.rows.filter((n) => n.degree > 10);
  out(`  High-degree nodes (degree>10): ${highDegree.length}`);
  if (highDegree[0]) {
    out(`  Top hub: ${highDegree[0].name ?? highDegree[0].node_id} (degree ${highDegree[0].degree})`);
  }

  // -------------------------------------------------------------------------
  // 5. Shortest path with time-window constraint (AS OF + PATHS_BETWEEN)
  // -------------------------------------------------------------------------

  step("5: Temporal paths — did they connect before 2024-07-01?");

  const temporalPaths = await relata.query<PathEdge>(
    `SELECT path_id, hop_index, from_id, to_id, link_type
     FROM PATHS_BETWEEN('${SEED_ID}', '${TARGET_ID}', max_hops => 3)
     AS OF '2024-07-01T00:00:00Z'
     LIMIT 10`,
  );

  if (temporalPaths.rowCount > 0) {
    out(`  Connection existed before 2024-07-01: YES (${temporalPaths.rowCount} path edges)`);
  } else {
    out("  No connection before 2024-07-01 in the data.");
  }

  // -------------------------------------------------------------------------
  // 6. Cluster nodes — show topology (useful in cluster profile)
  // -------------------------------------------------------------------------

  step("6: Cluster topology");

  const nodes = await relata.clusterNodes();
  for (const node of nodes) {
    out(`  ${node.nodeId} — ${node.role} @ ${node.url}`);
  }

  out("\n=== Graph traversal complete ===");
} catch (err) {
  exitOnRelataError(err);
}
