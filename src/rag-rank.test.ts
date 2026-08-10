/**
 * Tests for MMR diversity selection (#4526), TS parity port of
 * `sdks/python/tests/test_rag_rank.py` (#4578).
 *
 * Pure-function tests over `RagHit` — no client, no mocked transport
 * needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RagHit } from "./rag.ts";
import {
  DEFAULT_MMR_LAMBDA,
  MMR_LAMBDA_BY_PURPOSE,
  defaultRelevance,
  defaultTextSimilarity,
  mmrLambdaForPurpose,
  mmrSelect,
  mmrSelectForPurpose,
} from "./rag-rank.ts";

function hit(chunkId: string, overrides: Partial<RagHit> = {}): RagHit {
  return {
    bm25_score: 1.0,
    vector_score: 1.0,
    rerank_score: null,
    chunk_id: chunkId,
    report_id: "doc-1",
    text: `text for ${chunkId}`,
    section_path: [],
    page_start: 1,
    page_end: 1,
    prev_chunk_id: null,
    next_chunk_id: null,
    entity_ids: [],
    relevance_confidence: null,
    ...overrides,
  };
}

// ── domain-configurable lambda (AC #3) ──────────────────────────────────────

test("verified lambda defaults by domain", () => {
  assert.equal(MMR_LAMBDA_BY_PURPOSE["legal"], 0.7);
  assert.equal(MMR_LAMBDA_BY_PURPOSE["clinical"], 0.7);
  assert.equal(MMR_LAMBDA_BY_PURPOSE["medical"], 0.7);
  assert.equal(MMR_LAMBDA_BY_PURPOSE["finance"], 0.65);
  assert.equal(MMR_LAMBDA_BY_PURPOSE["research"], 0.6);
  assert.equal(MMR_LAMBDA_BY_PURPOSE["general"], 0.5);
  assert.equal(MMR_LAMBDA_BY_PURPOSE["code"], 0.4);
  assert.equal(DEFAULT_MMR_LAMBDA, 0.5);
});

test("mmrLambdaForPurpose known domains, case-insensitive", () => {
  assert.equal(mmrLambdaForPurpose("legal"), 0.7);
  assert.equal(mmrLambdaForPurpose("Legal"), 0.7);
  assert.equal(mmrLambdaForPurpose("CLINICAL"), 0.7);
  assert.equal(mmrLambdaForPurpose("medical"), 0.7);
  assert.equal(mmrLambdaForPurpose("finance"), 0.65);
  assert.equal(mmrLambdaForPurpose("research"), 0.6);
  assert.equal(mmrLambdaForPurpose("general"), 0.5);
  assert.equal(mmrLambdaForPurpose("code"), 0.4);
});

test("mmrLambdaForPurpose unknown falls back to default", () => {
  assert.equal(mmrLambdaForPurpose("marketing"), DEFAULT_MMR_LAMBDA);
});

test("mmrLambdaForPurpose undefined/null falls back to default", () => {
  assert.equal(mmrLambdaForPurpose(undefined), DEFAULT_MMR_LAMBDA);
  assert.equal(mmrLambdaForPurpose(null), DEFAULT_MMR_LAMBDA);
});

// ── default relevance/similarity are pure functions over sub-scores ────────

test("defaultRelevance prefers relevance_confidence when present", () => {
  const h = hit("c1", { relevance_confidence: 0.42, bm25_score: 1.0, vector_score: 1.0 });
  assert.equal(defaultRelevance(h), 0.42);
});

test("defaultRelevance falls back to score average", () => {
  const h = hit("c1", { relevance_confidence: null, bm25_score: 0.8, vector_score: 0.4 });
  assert.ok(Math.abs(defaultRelevance(h) - 0.6) < 1e-9);
});

test("defaultTextSimilarity identical text is one", () => {
  const a = hit("a", { text: "quarterly revenue rose sharply" });
  const b = hit("b", { text: "quarterly revenue rose sharply" });
  assert.equal(defaultTextSimilarity(a, b), 1.0);
});

test("defaultTextSimilarity disjoint text is zero", () => {
  const a = hit("a", { text: "quarterly revenue" });
  const b = hit("b", { text: "unrelated topic entirely" });
  assert.equal(defaultTextSimilarity(a, b), 0.0);
});

test("defaultTextSimilarity partial overlap", () => {
  const a = hit("a", { text: "alpha beta gamma" });
  const b = hit("b", { text: "alpha beta delta" });
  // tokens: {alpha,beta,gamma} vs {alpha,beta,delta} -> intersection 2, union 4
  assert.equal(defaultTextSimilarity(a, b), 0.5);
});

// ── mmrSelect — pure, deterministic, no LLM/embedding/network call ────────

test("mmrSelect lambda=1 is pure relevance ranking", () => {
  const hits = [
    hit("low", { relevance_confidence: 0.2, text: "alpha" }),
    hit("high", { relevance_confidence: 0.9, text: "alpha" }),
    hit("mid", { relevance_confidence: 0.5, text: "alpha" }),
  ];
  const selected = mmrSelect(hits, { lambdaMult: 1.0 });
  assert.deepEqual(
    selected.map((h) => h.chunk_id),
    ["high", "mid", "low"],
  );
});

test("mmrSelect lambda=0 maximizes diversity only", () => {
  const hits = [
    hit("first", { relevance_confidence: 0.9, text: "alpha beta gamma" }),
    hit("dup", { relevance_confidence: 0.9, text: "alpha beta gamma" }),
    hit("diverse", { relevance_confidence: 0.9, text: "totally unrelated content" }),
  ];
  const selected = mmrSelect(hits, { lambdaMult: 0.0, topN: 2 });
  assert.equal(selected[0]!.chunk_id, "first");
  assert.equal(selected[1]!.chunk_id, "diverse");
});

test("mmrSelect respects topN", () => {
  const hits = Array.from({ length: 5 }, (_, i) =>
    hit(`c${i}`, { relevance_confidence: 1.0 - i * 0.1 }),
  );
  const selected = mmrSelect(hits, { lambdaMult: 1.0, topN: 2 });
  assert.equal(selected.length, 2);
  assert.deepEqual(
    selected.map((h) => h.chunk_id),
    ["c0", "c1"],
  );
});

test("mmrSelect topN larger than pool returns everything", () => {
  const hits = [hit("a"), hit("b")];
  const selected = mmrSelect(hits, { topN: 10 });
  assert.equal(selected.length, 2);
});

test("mmrSelect empty input returns empty", () => {
  assert.deepEqual(mmrSelect([]), []);
});

test("mmrSelect rejects out-of-range lambda", () => {
  assert.throws(() => mmrSelect([hit("a")], { lambdaMult: 1.5 }));
  assert.throws(() => mmrSelect([hit("a")], { lambdaMult: -0.1 }));
});

test("mmrSelect is deterministic across repeated calls", () => {
  const hits = [
    hit("a", { relevance_confidence: 0.8, text: "one two three" }),
    hit("b", { relevance_confidence: 0.7, text: "two three four" }),
    hit("c", { relevance_confidence: 0.6, text: "five six seven" }),
  ];
  const first = mmrSelect(hits, { lambdaMult: 0.5 }).map((h) => h.chunk_id);
  const second = mmrSelect(hits, { lambdaMult: 0.5 }).map((h) => h.chunk_id);
  assert.deepEqual(first, second);
});

test("mmrSelect accepts custom relevance and similarity fns", () => {
  const hits = [hit("a"), hit("b"), hit("c")];
  const calls: string[] = [];
  const relevanceFn = (h: RagHit): number => {
    calls.push(h.chunk_id);
    return { a: 0.1, b: 0.9, c: 0.5 }[h.chunk_id]!;
  };
  const similarityFn = (): number => 0.0;

  const selected = mmrSelect(hits, { lambdaMult: 1.0, relevanceFn, similarityFn });
  assert.deepEqual(
    selected.map((h) => h.chunk_id),
    ["b", "c", "a"],
  );
  assert.deepEqual(new Set(calls), new Set(["a", "b", "c"]));
});

// ── mmrSelectForPurpose — the purpose-keyed convenience entry point ─────

test("mmrSelectForPurpose uses domain lambda", () => {
  const hits = [
    hit("low", { relevance_confidence: 0.2, text: "alpha" }),
    hit("high", { relevance_confidence: 0.9, text: "alpha" }),
  ];
  const selected = mmrSelectForPurpose(hits, "legal");
  assert.equal(selected[0]!.chunk_id, "high");
});

test("mmrSelectForPurpose null uses general default", () => {
  const hits = [hit("a", { relevance_confidence: 0.9 }), hit("b", { relevance_confidence: 0.1 })];
  const selected = mmrSelectForPurpose(hits, null);
  assert.equal(selected[0]!.chunk_id, "a");
});
