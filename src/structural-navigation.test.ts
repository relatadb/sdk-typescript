/**
 * Tests for structural table-of-contents navigation (#4542), TS/Go parity
 * port of `sdks/python/tests/test_structural_navigation.py` (#4581).
 *
 * Uses an injected `fetch` mock (no live server required), mirroring
 * `client.test.ts`'s approach.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { RelataClient } from "./client.ts";
import { PurposeError } from "./errors.ts";
import { StructuralNavigator, type StructureNode } from "./structural-navigation.ts";

// ---------------------------------------------------------------------------
// Mock fetch helper — queues one JSON response body per `/query` call.
// ---------------------------------------------------------------------------

function queuedClient(
  responses: Array<Record<string, unknown>[]>,
): { client: RelataClient; sentSql: string[] } {
  const sentSql: string[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const payload = JSON.parse(init?.body as string) as { sql: string };
    sentSql.push(payload.sql);
    const rows = responses[sentSql.length - 1] ?? [];
    return new Response(
      JSON.stringify({ data: rows, query_id: "qid-1", elapsed_ms: 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  const client = new RelataClient({ baseUrl: "http://localhost:9090", bearerToken: "tok", fetch });
  return { client, sentSql };
}

const ROOT_ROW = {
  node_id: "doc_1::",
  report_id: "doc_1",
  parent_id: null,
  title: "filing.pdf",
  depth: 0,
  page_start: 1,
  page_end: 10,
  summary: null,
  child_count: 1,
  leaf_chunk_ids: "[]",
};

const PART1_ROW = {
  node_id: "doc_1::Part I",
  report_id: "doc_1",
  parent_id: "doc_1::",
  title: "Part I",
  depth: 1,
  page_start: 1,
  page_end: 4,
  summary: "Liquidity and termination clauses.",
  child_count: 0,
  leaf_chunk_ids: '["ch_1", "ch_2"]',
};

const UNRELATED_ROW = {
  node_id: "doc_1::Part II",
  report_id: "doc_1",
  parent_id: "doc_1::",
  title: "Part II",
  depth: 1,
  page_start: 5,
  page_end: 8,
  summary: "Renewal options.",
  child_count: 0,
  leaf_chunk_ids: '["ch_3"]',
};

const LEAF_CHUNK_HIT_ROW = {
  chunk_id: "ch_1",
  report_id: "doc_1",
  text_body: "Liquidity terms are defined here.",
  section_path: ["Part I"],
  page_start: 1,
  page_end: 1,
  prev_chunk_id: null,
  next_chunk_id: "ch_2",
  canonical_entity_id: "e_1",
  _bm25_score: 2.1,
  _vector_score: 0.9,
};

// ── structureNodeFromRow ────────────────────────────────────────────────────

test("structureNodeFromRow parses leaf_chunk_ids JSON string", () => {
  const node = StructuralNavigator.structureNodeFromRow(PART1_ROW);
  assert.equal(node.nodeId, "doc_1::Part I");
  assert.equal(node.parentId, "doc_1::");
  assert.equal(node.title, "Part I");
  assert.deepEqual(node.leafChunkIds, ["ch_1", "ch_2"]);
  assert.equal(node.isLeaf, true); // child_count === 0
});

test("structureNodeFromRow handles missing and malformed leaf ids", () => {
  const row = { ...ROOT_ROW, leaf_chunk_ids: "not json" };
  const node = StructuralNavigator.structureNodeFromRow(row);
  assert.deepEqual(node.leafChunkIds, []);
  assert.equal(node.isLeaf, false); // child_count === 1
});

// ── fetchRootNode / fetchChildNodes ─────────────────────────────────────────

test("fetchRootNode queries parent_id IS NULL", async () => {
  const { client, sentSql } = queuedClient([[ROOT_ROW]]);
  const nav = new StructuralNavigator(client);
  const node = await nav.fetchRootNode({ reportId: "doc_1", purpose: "research" });
  assert.ok(node !== null);
  assert.equal(node?.nodeId, "doc_1::");
  assert.ok(sentSql[0]?.includes("parent_id IS NULL"));
  assert.ok(sentSql[0]?.includes("report_id = 'doc_1'"));
});

test("fetchRootNode returns null when no tree", async () => {
  const { client } = queuedClient([[]]);
  const nav = new StructuralNavigator(client);
  const node = await nav.fetchRootNode({ reportId: "doc_missing", purpose: "research" });
  assert.equal(node, null);
});

test("fetchChildNodes scopes by parent_id", async () => {
  const { client, sentSql } = queuedClient([[PART1_ROW, UNRELATED_ROW]]);
  const nav = new StructuralNavigator(client);
  const children = await nav.fetchChildNodes({
    reportId: "doc_1",
    parentId: "doc_1::",
    purpose: "research",
  });
  assert.deepEqual(children.map((c) => c.title), ["Part I", "Part II"]);
  assert.ok(sentSql[0]?.includes("parent_id = 'doc_1::'"));
});

// ── lexicalChildSelector ─────────────────────────────────────────────────────

test("lexicalChildSelector picks best overlap", () => {
  const children: StructureNode[] = [
    StructuralNavigator.structureNodeFromRow(PART1_ROW),
    StructuralNavigator.structureNodeFromRow(UNRELATED_ROW),
  ];
  const chosen = StructuralNavigator.lexicalChildSelector(
    "What are the liquidity termination clauses?",
    children,
  );
  assert.ok(chosen !== null);
  assert.equal(chosen?.title, "Part I");
});

test("lexicalChildSelector returns null on no overlap", () => {
  const children: StructureNode[] = [
    StructuralNavigator.structureNodeFromRow(PART1_ROW),
    StructuralNavigator.structureNodeFromRow(UNRELATED_ROW),
  ];
  assert.equal(StructuralNavigator.lexicalChildSelector("zzz qqq nonsense", children), null);
});

// ── navigateStructuralTree — the multi-hop descent ──────────────────────────

test("navigateStructuralTree descends and ranks leaf chunks", async () => {
  const { client, sentSql } = queuedClient([
    [ROOT_ROW], // 1. root
    [PART1_ROW, UNRELATED_ROW], // 2. root's children
    [], // 3. Part I's children — none, it's a leaf
    [LEAF_CHUNK_HIT_ROW], // 4. ranked RAG_RETRIEVE over ch_1/ch_2
  ]);
  const nav = new StructuralNavigator(client);
  const response = await nav.navigateStructuralTree({
    reportId: "doc_1",
    question: "What are the liquidity termination clauses?",
    type: "DocumentChunk",
    purpose: "research",
  });

  assert.equal(sentSql.length, 4);
  assert.ok(sentSql[0]?.includes("parent_id IS NULL"));
  assert.ok(sentSql[1]?.includes("parent_id = 'doc_1::'"));
  assert.ok(sentSql[2]?.includes("parent_id = 'doc_1::Part I'"));
  assert.ok(sentSql[3]?.includes("RAG_RETRIEVE FROM DocumentChunk"));
  assert.ok(sentSql[3]?.includes("chunk_id IN ('ch_1', 'ch_2')"));

  assert.equal(response.hits.length, 1);
  const hit = response.hits[0]!;
  assert.equal(hit.chunk_id, "ch_1");
  assert.equal(hit.text, "Liquidity terms are defined here.");
  assert.equal(hit.bm25_score, 2.1);
  assert.equal(hit.vector_score, 0.9);
  assert.deepEqual(hit.entity_ids, ["e_1"]);
  assert.equal(hit.rerank_score, null);
});

test("navigateStructuralTree returns empty when no tree", async () => {
  const { client, sentSql } = queuedClient([[]]);
  const nav = new StructuralNavigator(client);
  const response = await nav.navigateStructuralTree({
    reportId: "doc_flat",
    question: "anything",
    type: "DocumentChunk",
    purpose: "research",
  });
  assert.deepEqual(response.hits, []);
  assert.equal(sentSql.length, 1); // stopped after the root fetch found nothing
});

test("navigateStructuralTree stops when selector declines", async () => {
  // Root has children, but the (custom) selector never picks one — descent
  // stops at the root, and the root itself has no leaf_chunk_ids.
  const { client, sentSql } = queuedClient([[ROOT_ROW], [PART1_ROW, UNRELATED_ROW]]);
  const nav = new StructuralNavigator(client);
  const response = await nav.navigateStructuralTree({
    reportId: "doc_1",
    question: "totally unrelated query text",
    type: "DocumentChunk",
    purpose: "research",
    selectChild: () => null,
  });
  assert.deepEqual(response.hits, []);
  assert.equal(sentSql.length, 2); // root + one children fetch, no leaf-ranking call
});

test("navigateStructuralTree requires purpose", async () => {
  const { client } = queuedClient([[ROOT_ROW]]);
  const nav = new StructuralNavigator(client);
  await assert.rejects(
    () => nav.navigateStructuralTree({ reportId: "doc_1", question: "q", type: "DocumentChunk" }),
    PurposeError,
  );
});
