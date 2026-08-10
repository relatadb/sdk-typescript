/**
 * Tests for citation injection + post-synthesis faithfulness scoring — RAG
 * epic highest-priority SDK ticket (#4527, ported from
 * sdks/python/tests/test_synthesis.py, #4579). Every LLM call in these
 * tests is a plain stub — RelataDB has no server-side agent loop (ADR-013)
 * and this module is intentionally provider-agnostic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSynthesisPrompt, synthesize } from "./synthesis.ts";
import type { RagHit, RagQueryResponse } from "./rag.ts";

const HIT_SUPPORTED: RagHit = {
  bm25_score: 4.2,
  vector_score: 0.83,
  rerank_score: null,
  chunk_id: "chunk-1",
  report_id: "doc-1",
  text: "RelataDB fuses BM25 and vector retrieval natively via RRF.",
  section_path: ["3", "3.2"],
  page_start: 5,
  page_end: 6,
  prev_chunk_id: null,
  next_chunk_id: "chunk-2",
  entity_ids: ["ent-1"],
};

const HIT_OTHER: RagHit = {
  bm25_score: 3.1,
  vector_score: 0.61,
  rerank_score: null,
  chunk_id: "chunk-2",
  report_id: "doc-1",
  text: "The fused ranking uses reciprocal rank fusion (RRF) across channels.",
  section_path: ["3", "3.3"],
  page_start: 6,
  page_end: 7,
  prev_chunk_id: "chunk-1",
  next_chunk_id: null,
  entity_ids: [],
};

function response(hits: RagHit[] = [HIT_SUPPORTED, HIT_OTHER]): RagQueryResponse {
  return { hits };
}

const alwaysSupported = () => true;
const neverSupported = () => false;

// ── buildSynthesisPrompt — inline citation instructions ─────────────────────

test("buildSynthesisPrompt includes citation-grade fields for every hit", () => {
  const prompt = buildSynthesisPrompt(
    "How does RelataDB rank hybrid results?",
    response().hits,
  );
  assert.match(prompt, /\[chunk-1\]/);
  assert.match(prompt, /\[chunk-2\]/);
  assert.match(prompt, /3 > 3\.2/); // section_path breadcrumb
  assert.match(prompt, /p\.5-6/);
  assert.match(prompt, /RelataDB fuses BM25 and vector retrieval natively via RRF\./);
  assert.match(prompt, /Never invent a chunk id/);
});

// ── synthesize() — inline citation injection, no fabrication possible ───────

test("synthesize resolves real citations inline", async () => {
  const result = await synthesize("How does RelataDB rank hybrid results?", response(), {
    llm: () => "RelataDB fuses BM25 and vector retrieval natively [chunk-1].",
    entailmentFn: alwaysSupported,
  });

  assert.equal(result.citations.length, 1);
  // Non-null: the length assertion above already guarantees this element
  // exists — noUncheckedIndexedAccess doesn't narrow from a separate
  // length check, so this asserts what's already proven, not a new risk.
  const citation = result.citations[0]!;
  assert.equal(citation.chunkId, "chunk-1");
  assert.equal(citation.reportId, "doc-1");
  assert.deepEqual(citation.sectionPath, ["3", "3.2"]);
  assert.equal(citation.pageStart, 5);
  assert.equal(citation.pageEnd, 6);
  assert.match(result.answer, /\[chunk-1\]/);
  assert.equal(result.sentences[0]!.citations[0]!.chunkId, "chunk-1");
});

test("synthesize strips a fabricated citation by construction", async () => {
  const result = await synthesize("q", response(), {
    llm: () => "RelataDB invented this fact [chunk-does-not-exist].",
    entailmentFn: alwaysSupported,
  });

  assert.deepEqual(result.citations, []);
  assert.ok(!result.answer.includes("chunk-does-not-exist"));
  assert.deepEqual(result.sentences[0]!.citations, []);
});

test("synthesize dedupes citations across sentences", async () => {
  const result = await synthesize("q", response(), {
    llm: () =>
      "RelataDB fuses BM25 and vector retrieval natively [chunk-1]. " +
      "It uses RRF to combine channel scores [chunk-1].",
    entailmentFn: alwaysSupported,
  });

  assert.deepEqual(
    result.citations.map((c) => c.chunkId),
    ["chunk-1"],
  );
  assert.equal(result.sentences.length, 2);
});

// ── faithfulness pass — on by default, marks unsupported claims ─────────────

test("faithfulness check runs by default", async () => {
  const calls: string[] = [];
  await synthesize("q", response(), {
    llm: () => "RelataDB fuses BM25 and vector retrieval natively [chunk-1].",
    entailmentFn: (sentence) => {
      calls.push(sentence);
      return true;
    },
  });

  // entailmentFn was invoked without the caller passing faithfulnessCheck
  // explicitly.
  assert.equal(calls.length, 1);
});

test("synthesize marks a deliberately injected unsupported claim", async () => {
  const result = await synthesize("q", response(), {
    llm: () =>
      "RelataDB fuses BM25 and vector retrieval natively [chunk-1]. " +
      "RelataDB was founded on the moon in 1969 [chunk-2].",
    entailmentFn: (sentence) =>
      // Only the fabricated "founded on the moon" claim fails entailment
      // against its cited evidence — deliberately injected to prove
      // faithfulness marking actually happens.
      !sentence.toLowerCase().includes("moon"),
  });

  assert.equal(result.unsupportedCount, 1);
  assert.equal(result.hasUnsupportedClaims, true);
  assert.equal(result.sentences.length, 2);
  // Non-null: the length assertion above already guarantees both elements
  // exist — array destructuring doesn't narrow under noUncheckedIndexedAccess.
  const [supportedSentence, unsupportedSentence] = result.sentences as [
    (typeof result.sentences)[number],
    (typeof result.sentences)[number],
  ];
  assert.equal(supportedSentence.supported, true);
  assert.ok(!supportedSentence.text.includes("[unsupported]"));
  assert.equal(unsupportedSentence.supported, false);
  assert.ok(unsupportedSentence.text.endsWith("[unsupported]"));
  assert.match(result.answer, /\[unsupported\]/);
  // The unsupported sentence still carries its (real) citation — marking it
  // doesn't erase which chunk it claimed to come from.
  assert.equal(unsupportedSentence.citations[0]!.chunkId, "chunk-2");
});

test("synthesize supports a custom unsupported marker", async () => {
  const result = await synthesize("q", response(), {
    llm: () => "A totally fabricated claim with no citation at all.",
    entailmentFn: neverSupported,
    unsupportedMarker: "[NEEDS VERIFICATION]",
  });
  assert.ok(result.answer.endsWith("[NEEDS VERIFICATION]"));
});

test("faithfulness check can be disabled", async () => {
  const result = await synthesize("q", response(), {
    llm: () => "Some claim [chunk-1].",
    entailmentFn: () => {
      throw new Error("entailmentFn must not be called when faithfulnessCheck=false");
    },
    faithfulnessCheck: false,
  });
  assert.equal(result.unsupportedCount, 0);
  assert.ok(result.sentences.every((s) => s.supported));
});

test("default entailment fn makes a second, independent llm call", async () => {
  const prompts: string[] = [];
  const llm = (prompt: string) => {
    prompts.push(prompt);
    if (prompt.includes("Claim:")) return "NO";
    return "RelataDB fuses BM25 and vector retrieval natively [chunk-1].";
  };

  const result = await synthesize("q", response(), { llm });

  assert.equal(prompts.length, 2); // one synthesis call, one entailment call
  assert.match(prompts[1]!, /Claim:/);
  assert.match(prompts[1]!, /Evidence:/);
  assert.equal(result.unsupportedCount, 1);
});

test("uncited sentence with no evidence is unsupported by default", async () => {
  const result = await synthesize("q", response(), {
    llm: () => "This sentence cites nothing.",
    entailmentFn: (_sentence, evidence) =>
      // No citation resolved -> evidence falls back to every retrieved
      // hit's text (non-empty here), so this exercises the "has some
      // evidence but still fails" path rather than the empty-evidence
      // short-circuit covered by the "second independent llm call" test's
      // "NO" case.
      evidence.length === 0,
  });
  assert.equal(result.unsupportedCount, 1);
});

test("synthesize with no hits produces no citations", async () => {
  for (const hits of [[], undefined]) {
    const result = await synthesize("q", response(hits as RagHit[] | undefined), {
      llm: () => "I don't have enough information to answer that.",
      entailmentFn: (_sentence, evidence) => evidence.length === 0,
    });
    assert.deepEqual(result.citations, []);
  }
});
