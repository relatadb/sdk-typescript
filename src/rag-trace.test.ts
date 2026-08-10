/**
 * Tests for reasoning-trace write-back (#4528) — the final SDK-side stage of
 * the RAG epic's agentic loop.
 *
 * Mirrors `sdks/python/tests/test_rag_trace.py`'s acceptance criteria:
 * constructs real `LoopResult`/`FanoutResult`/`SynthesisResult` objects (the
 * same types those modules' own real execution produces) rather than
 * mocking them, then asserts the exact `rag_store_answer` MCP payload
 * `buildReasoningTrace`/`storeReasoningTrace` builds from them — mirroring
 * `typed-clients.test.ts`'s injected-`fetch` mock pattern for the wire-call
 * assertions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpClient } from "./mcp.ts";
import type { RagHit } from "./rag.ts";
import {
  CorrectiveGradingResult,
  GateDecision,
  HitGrade,
  type FanoutResult,
  type LoopIteration,
  type LoopResult,
  type SubAgentResult,
} from "./rag-loop.ts";
import { buildReasoningTrace, storeReasoningTrace } from "./rag-trace.ts";
import type { Citation, SynthesisResult, SynthesizedSentence } from "./synthesis.ts";

function hit(chunkId: string, overrides: Partial<RagHit> = {}): RagHit {
  return {
    bm25_score: 1.0,
    vector_score: 1.0,
    rerank_score: null,
    chunk_id: chunkId,
    report_id: "doc-1",
    text: `text for ${chunkId}`,
    section_path: ["3", "3.2"],
    page_start: 4,
    page_end: 5,
    prev_chunk_id: null,
    next_chunk_id: null,
    entity_ids: [],
    relevance_confidence: 0.7,
    ...overrides,
  };
}

function citation(chunkId: string, overrides: Partial<Citation> = {}): Citation {
  return {
    chunkId,
    reportId: "doc-1",
    sectionPath: ["3", "3.2"],
    pageStart: 4,
    pageEnd: 5,
    ...overrides,
  };
}

/**
 * A loop that evaluated once (grading found one incorrect hit) and then
 * converged with confidence — the shape the corrective-retrieval tier
 * (#4525) produces when it forces exactly one re-query.
 */
function twoIterationLoop(): LoopResult {
  const hitA = hit("ch_1", { relevance_confidence: 0.4 });
  const hitB = hit("ch_2", { relevance_confidence: 0.2 });
  const hitC = hit("ch_3", { relevance_confidence: 0.9 });

  const it0: LoopIteration = {
    query: "original query",
    response: { hits: [hitA, hitB] },
    gate: { score: 0.7, decision: GateDecision.EVALUATE },
    grading: new CorrectiveGradingResult([HitGrade.CORRECT, HitGrade.INCORRECT], 0.5),
    confidence: 0.5,
  };
  const it1: LoopIteration = {
    query: "original query, refined",
    response: { hits: [hitC] },
    gate: { score: 0.92, decision: GateDecision.PASS },
    grading: undefined,
    confidence: 0.92,
  };
  return {
    response: it1.response,
    iterations: [it0, it1],
    llmCalls: 1,
    stoppedReason: "heuristic_pass",
  };
}

function synthesisResult(): SynthesisResult {
  const sentence: SynthesizedSentence = {
    text: "Answer text grounded in [ch_3].",
    citations: [citation("ch_3")],
    supported: true,
  };
  return {
    answer: "Answer text grounded in [ch_3].",
    sentences: [sentence],
    citations: [citation("ch_3")],
    unsupportedCount: 0,
    hasUnsupportedClaims: false,
  };
}

// ---------------------------------------------------------------------------
// buildReasoningTrace — pure payload-building assertions
// ---------------------------------------------------------------------------

test("iteration count and final confidence", () => {
  const loopResult = twoIterationLoop();
  const args = buildReasoningTrace("q", loopResult, synthesisResult());
  assert.equal(args["num_iterations"], 2);
  assert.equal(args["confidence"], 0.92); // the LAST iteration's confidence, not the first
});

test("iteration trace carries per-iteration confidence and query", () => {
  const loopResult = twoIterationLoop();
  const args = buildReasoningTrace("q", loopResult, synthesisResult());
  const trace = args["iteration_trace"] as Record<string, unknown>[];
  assert.equal(trace.length, 2);
  assert.equal(trace[0]?.["query"], "original query");
  assert.equal(trace[0]?.["confidence"], 0.5);
  assert.equal(trace[0]?.["gate_decision"], "evaluate");
  assert.equal(trace[0]?.["fraction_correct"], 0.5);
  assert.equal(trace[1]?.["query"], "original query, refined");
  assert.equal(trace[1]?.["confidence"], 0.92);
  assert.equal(trace[1]?.["gate_decision"], "pass");
  assert.ok(!("fraction_correct" in (trace[1] ?? {}))); // no grading ran on the passing iteration
});

test("evidence gaps include hits graded not correct", () => {
  const loopResult = twoIterationLoop();
  const args = buildReasoningTrace("q", loopResult, synthesisResult());
  const gaps = args["evidence_gaps"] as Record<string, unknown>[];
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.["chunk_id"], "ch_2");
  assert.equal(gaps[0]?.["grade"], "incorrect");
  assert.equal(gaps[0]?.["reason"], "corrective_grading");
  // The CORRECT-graded hit (ch_1) must not show up as a gap.
  assert.ok(gaps.every((g) => g["chunk_id"] !== "ch_1"));
});

test("evidence gaps include fanout excluded strategies", () => {
  const loopResult = twoIterationLoop();
  const winner: SubAgentResult = {
    strategy: { name: "hybrid" },
    response: { hits: [hit("ch_3")] },
    confidence: 0.9,
  };
  const excluded: SubAgentResult = {
    strategy: { name: "lexical" },
    response: { hits: [] },
    confidence: 0.05,
  };
  const fanoutResult: FanoutResult = {
    winner,
    mergedResponse: winner.response,
    included: [winner],
    excluded: [excluded],
  };
  const args = buildReasoningTrace("q", loopResult, synthesisResult(), { fanoutResult });
  const gaps = args["evidence_gaps"] as Record<string, unknown>[];
  const fanoutGaps = gaps.filter((g) => g["reason"] === "fanout_low_confidence");
  assert.equal(fanoutGaps.length, 1);
  assert.equal(fanoutGaps[0]?.["strategy"], "lexical");
  assert.equal(fanoutGaps[0]?.["confidence"], 0.05);
});

test("evidence gaps empty when nothing discarded", () => {
  const it: LoopIteration = {
    query: "q",
    response: { hits: [hit("ch_1")] },
    gate: { score: 0.9, decision: GateDecision.PASS },
    grading: undefined,
    confidence: 0.9,
  };
  const loopResult: LoopResult = {
    response: it.response,
    iterations: [it],
    llmCalls: 0,
    stoppedReason: "heuristic_pass",
  };
  const args = buildReasoningTrace("q", loopResult, synthesisResult());
  assert.deepEqual(args["evidence_gaps"], []);
});

test("sources built from synthesis citations with relevance score", () => {
  const loopResult = twoIterationLoop();
  const args = buildReasoningTrace("q", loopResult, synthesisResult());
  const sources = args["sources"] as Record<string, unknown>[];
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.["id"], "ch_3");
  assert.equal(sources[0]?.["source"], "doc-1");
  assert.equal(sources[0]?.["score"], 0.9); // from hit_c's relevance_confidence
  assert.equal(sources[0]?.["page"], 4);
  assert.deepEqual(sources[0]?.["sectionPath"], ["3", "3.2"]);
});

test("faithfulness computed from unsupported fraction", () => {
  const loopResult = twoIterationLoop();
  const sentenceOk: SynthesizedSentence = {
    text: "ok [ch_3].",
    citations: [citation("ch_3")],
    supported: true,
  };
  const sentenceBad: SynthesizedSentence = {
    text: "unsupported claim [unsupported]",
    citations: [],
    supported: false,
  };
  const result: SynthesisResult = {
    answer: "ok [ch_3]. unsupported claim [unsupported]",
    sentences: [sentenceOk, sentenceBad],
    citations: [citation("ch_3")],
    unsupportedCount: 1,
    hasUnsupportedClaims: true,
  };
  const args = buildReasoningTrace("q", loopResult, result);
  assert.equal(args["faithfulness"], 0.5);
});

test("faithfulness is sentinel when no sentences", () => {
  const loopResult = twoIterationLoop();
  const empty: SynthesisResult = {
    answer: "",
    sentences: [],
    citations: [],
    unsupportedCount: 0,
    hasUnsupportedClaims: false,
  };
  const args = buildReasoningTrace("q", loopResult, empty);
  assert.equal(args["faithfulness"], -1.0);
});

test("optional caseId/purpose/durationMs are omitted when unset", () => {
  const loopResult = twoIterationLoop();
  const args = buildReasoningTrace("q", loopResult, synthesisResult());
  assert.ok(!("case_id" in args));
  assert.ok(!("purpose" in args));
  assert.ok(!("duration_ms" in args));
});

test("optional caseId/purpose/durationMs are sent when given", () => {
  const loopResult = twoIterationLoop();
  const args = buildReasoningTrace("q", loopResult, synthesisResult(), {
    caseId: "case-42",
    purpose: "analytics",
    durationMs: 1234,
  });
  assert.equal(args["case_id"], "case-42");
  assert.equal(args["purpose"], "analytics");
  assert.equal(args["duration_ms"], 1234);
});

// ---------------------------------------------------------------------------
// storeReasoningTrace — wire-call assertions
// ---------------------------------------------------------------------------

function mcpEnvelope(inner: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(inner) }], isError: false };
}

test("storeReasoningTrace calls rag_store_answer with full payload", async () => {
  const seen: { name?: unknown; arguments?: Record<string, unknown> } = {};
  const fetchMock = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    seen.name = body["name"];
    seen.arguments = body["arguments"] as Record<string, unknown>;
    const result = {
      stored: "RagAnswer",
      source_rows: 1,
      has_iteration_trace: true,
      evidence_gap_count: 1,
    };
    return new Response(JSON.stringify(mcpEnvelope(result)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const client = new McpClient({ baseUrl: "http://localhost:9090", fetch: fetchMock });
  const loopResult = twoIterationLoop();
  const result = await storeReasoningTrace(client, "q", loopResult, synthesisResult(), {
    purpose: "analytics",
  });

  assert.equal(seen.name, "rag_store_answer");
  const args = seen.arguments!;
  assert.equal(args["question"], "q");
  assert.equal(args["answer"], "Answer text grounded in [ch_3].");
  assert.equal(args["num_iterations"], 2);
  assert.equal((args["iteration_trace"] as unknown[]).length, 2);
  assert.equal((args["evidence_gaps"] as unknown[]).length, 1);
  assert.equal(args["purpose"], "analytics");
  // The (mocked) server's response is passed straight through.
  assert.equal(result["stored"], "RagAnswer");
  assert.equal(result["has_iteration_trace"], true);
});
