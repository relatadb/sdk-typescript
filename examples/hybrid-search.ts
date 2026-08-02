/**
 * hybrid-search.ts — BM25 + vector fusion via `VectorClient.hybridSearch()` (#2678).
 *
 * `HYBRID_SEARCH` is the operator that makes Relata more than "yet another
 * vector DB" or "yet another BM25 engine": supply `queryText` (BM25 leg),
 * `queryEmbedding` (vector leg), or both — when both are present the server
 * fuses the two rankings via reciprocal rank fusion (ADR-175).
 *
 * This walkthrough embeds a few short texts (`POST /embed`, #1172), writes
 * them into a `Document` namespace with the embedding pre-computed in the
 * `_emb_text` slot (the caller-supplied convention, see
 * `docs/src/end-users/search.md`), then runs `hybridSearch` three ways —
 * BM25-only, vector-only, and fused — so the effect of fusion is visible
 * side by side.
 *
 * Run:
 *   RELATA_TOKEN=secret \
 *     node --experimental-strip-types examples/hybrid-search.ts
 */

import { createClient, VectorClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "rag" });
const vectors = VectorClient.fromClient(relata);

const DOCS: { id: string; title: string; body: string }[] = [
  {
    id: "doc-1",
    title: "Knowledge graphs 101",
    body: "An introduction to entities, edges, and graph retrieval.",
  },
  {
    id: "doc-2",
    title: "Vector search at scale",
    body: "HNSW indexes and approximate nearest neighbour retrieval.",
  },
  {
    id: "doc-3",
    title: "Bi-temporal databases",
    body: "Tracking valid time and system time for auditable history.",
  },
];

function printHits(hits: Record<string, unknown>[]): void {
  for (const row of hits) {
    const score = typeof row["_score"] === "number" ? row["_score"] : 0;
    out(`  score=${score.toFixed(4)}  ${String(row["title"] ?? "")}`);
  }
}

async function main(): Promise<void> {
  banner("1. Embed + ingest 3 Documents (schemaless write)");
  const rows: Record<string, unknown>[] = [];
  for (const doc of DOCS) {
    const { embedding } = await vectors.embed(doc.body);
    rows.push({ ...doc, _emb_text: embedding });
  }
  await relata.namespace("Document").write(rows);
  out(`  wrote ${rows.length} rows with pre-computed _emb_text embeddings`);

  step("2. BM25-only: queryText='graph retrieval'");
  printHits(await vectors.hybridSearch("Document", { queryText: "graph retrieval", k: 5 }));

  step("3. Vector-only: nearest neighbour to doc-2's embedding");
  const { embedding: queryEmbedding } = await vectors.embed("approximate nearest neighbour search");
  printHits(
    await vectors.hybridSearch("Document", {
      queryEmbedding,
      embeddingSlot: "_emb_text",
      k: 5,
    }),
  );

  step("4. Fused: queryText + queryEmbedding together (ADR-175 reciprocal rank fusion)");
  const { embedding: fusedEmbedding } = await vectors.embed("graph retrieval with vectors");
  printHits(
    await vectors.hybridSearch("Document", {
      queryText: "graph retrieval",
      queryEmbedding: fusedEmbedding,
      embeddingSlot: "_emb_text",
      k: 5,
    }),
  );
}

await main().catch(exitOnRelataError);
