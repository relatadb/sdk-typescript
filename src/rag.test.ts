/**
 * Tests for the typed `/rag/query` client — RAG epic foundational SDK
 * ticket (#4523, wraps #4514's ADR-0299 contract). Uses a mock fetch, no
 * live server required — the contract is frozen per ADR-0299 regardless of
 * whether #4514 has merged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RagClient, buildRagPayload, RAG_DEFAULT_TOP_K } from "./rag.ts";
import { PurposeError } from "./errors.ts";

const RAG_HIT = {
  bm25_score: 4.2,
  vector_score: 0.83,
  rerank_score: null,
  chunk_id: "chunk-1",
  report_id: "doc-1",
  text: "RelataDB fuses BM25 and vector retrieval natively.",
  section_path: ["3", "3.2"],
  page_start: 5,
  page_end: 6,
  prev_chunk_id: null,
  next_chunk_id: "chunk-2",
  entity_ids: ["ent-1", "ent-2"],
  relevance_confidence: null,
};

function makeClient(
  responses: Array<{ status: number; body: unknown }>,
  capture?: { body?: unknown },
): RagClient {
  let idx = 0;
  const fakeFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    if (capture && init?.body) capture.body = JSON.parse(init.body as string);
    const r = responses[idx++] ?? { status: 500, body: { error: "no more mocks" } };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  };

  return new RagClient({
    baseUrl: "http://localhost:9090",
    bearerToken: "test-token",
    fetch: fakeFetch as typeof globalThis.fetch,
  });
}

// ── buildRagPayload — #4514's exact request table ──────────────────────────

test("buildRagPayload carries every required field", () => {
  const body = buildRagPayload("graph databases", { type: "DocumentChunk" }, "research");
  assert.deepEqual(body, {
    query: "graph databases",
    type: "DocumentChunk",
    top_k: RAG_DEFAULT_TOP_K,
    rerank: false,
    search_mode: "hybrid",
    embedding_slot: "text",
    filters: [],
    as_of: null,
    purpose: "research",
    expand_window: false,
    graph_hops: 0,
  });
});

test("buildRagPayload passes through explicit options", () => {
  const body = buildRagPayload(
    "q",
    {
      type: "DocumentChunk",
      topK: 5,
      rerank: true,
      searchMode: "lexical",
      embeddingSlot: "summary",
      filters: [{ field: "status", op: "eq", value: "published" }],
      asOf: "2026-01-01T00:00:00Z",
      expandWindow: true,
      graphHops: 2,
    },
    "research",
  );
  assert.equal(body["top_k"], 5);
  assert.equal(body["rerank"], true);
  assert.equal(body["search_mode"], "lexical");
  assert.equal(body["embedding_slot"], "summary");
  assert.deepEqual(body["filters"], [{ field: "status", op: "eq", value: "published" }]);
  assert.equal(body["as_of"], "2026-01-01T00:00:00Z");
  assert.equal(body["expand_window"], true);
  assert.equal(body["graph_hops"], 2);
});

test("buildRagPayload rejects an empty query", () => {
  assert.throws(() => buildRagPayload("", { type: "DocumentChunk" }, "research"));
});

test("buildRagPayload rejects an empty type", () => {
  assert.throws(() => buildRagPayload("q", { type: "" }, "research"));
});

// ── RagClient.query → POST /rag/query ───────────────────────────────────────

test("RagClient.query posts the full contract and returns typed hits", async () => {
  const capture: { body?: unknown } = {};
  const client = makeClient([{ status: 200, body: { hits: [RAG_HIT] } }], capture);
  const res = await client.query("graph retrieval", {
    type: "DocumentChunk",
    topK: 5,
    rerank: true,
    purpose: "research",
  });
  const sent = capture.body as Record<string, unknown>;
  assert.equal(sent["query"], "graph retrieval");
  assert.equal(sent["type"], "DocumentChunk");
  assert.equal(sent["top_k"], 5);
  assert.equal(sent["rerank"], true);
  assert.equal(sent["purpose"], "research");
  assert.equal(res.hits.length, 1);
  assert.equal(res.hits[0]!.bm25_score, 4.2);
  assert.equal(res.hits[0]!.vector_score, 0.83);
  assert.equal(res.hits[0]!.chunk_id, "chunk-1");
});

test("RagClient.query throws PurposeError when no purpose is available", async () => {
  const client = makeClient([{ status: 200, body: { hits: [] } }]);
  await assert.rejects(
    () => client.query("q", { type: "DocumentChunk" }),
    PurposeError,
  );
});
