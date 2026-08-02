/**
 * hybrid-search-quickstart.ts — the flagship retrieval path (#88, ADR-175).
 *
 * Emits `HYBRID_SEARCH FROM <type> QUERY '<text>' LIMIT <k>` fused via
 * reciprocal rank fusion (graph + BM25 + vector). The server embeds the query
 * text server-side; caller-supplied embeddings are not accepted by the
 * `/query` SQL surface (no vector-literal grammar).
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/hybrid-search-quickstart.ts
 */

import { RelataClient, VectorClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();

interface Hit {
  id?: string;
  score?: number;
}

async function main(): Promise<void> {
  const relata = new RelataClient({
    baseUrl: url,
    bearerToken: token,
    defaultPurpose: "analytics",
  });
  const vectors = new VectorClient(relata);

  banner("1. hybridSearch — BM25 ⊕ vector fusion");
  const hits = (await vectors.hybridSearch("Document", {
    queryText: "graph database",
    k: 5,
  })) as Hit[];
  for (const [i, h] of hits.entries()) {
    out(`  ${i + 1}. [${(h.score ?? 0).toFixed(3)}] ${h.id ?? ""}`);
  }

  step("2. hybridSearch — tuned (RERANK + METRIC + WEIGHTS)");
  const tuned = (await vectors.hybridSearch("Document", {
    queryText: "graph database",
    k: 5,
    rerank: true,
    metric: "cosine",
    weights: [0.3, 0.5, 0.2],
  })) as Hit[];
  out(`tuned hits: ${tuned.length}`);
}

await main().catch(exitOnRelataError);
