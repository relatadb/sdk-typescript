/**
 * Tests for the heuristic gate + corrective retrieval grading + loop
 * confidence cost ladder (#4525), plus sub-agent fan-out + deterministic
 * merge (#4526) — #4582 (epic #4576).
 *
 * Mirrors `sdks/python/tests/test_rag_loop.py` and
 * `sdks/python/tests/test_rag_fanout.py`'s acceptance criteria: the
 * zero-LLM-calls-on-heuristic-pass property, `MAX_ITERATIONS` enforcement
 * under adversarial input, deterministic fan-out winner selection, and the
 * `LOW_CONFIDENCE_FLOOR`/`MERGE_THRESHOLD` merge behavior. Uses an injected
 * `fetch` mock, no live server required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RagClient } from "./rag.ts";
import type { RagHit, RagQueryResponse } from "./rag.ts";
import {
  CORRECTIVE_FRACTION_CORRECT_FLOOR,
  CorrectiveGradingResult,
  GateDecision,
  HEURISTIC_PASS_THRESHOLD,
  HEURISTIC_RETRY_THRESHOLD,
  HitGrade,
  LOOP_CONFIDENCE_THRESHOLD,
  LOW_CONFIDENCE_FLOOR,
  MAX_FANOUT_STRATEGIES,
  MAX_ITERATIONS,
  MERGE_THRESHOLD,
  MIN_FANOUT_STRATEGIES,
  gradeHits,
  heuristicGate,
  runAgenticLoop,
  runSubagentFanout,
  type EmbeddingFn,
  type GraderFn,
  type SubAgentStrategy,
} from "./rag-loop.ts";

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
    ...overrides,
  };
}

type Handler = (body: Record<string, unknown>) => { status: number; body: unknown };

function mockRagClient(handler: Handler): RagClient {
  const fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const resp = handler(body);
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return new RagClient({ baseUrl: "http://localhost:9090", bearerToken: "tok", fetch });
}

/**
 * Return an embedding function under which any query text's embedding vs.
 * any hit text's embedding (hit text always starts with "text for ", per
 * `hit()` above) has cosine similarity exactly `score`.
 */
function embeddingFnForScore(score: number): EmbeddingFn {
  const queryVec = [1.0, 0.0];
  const orthogonal = Math.sqrt(Math.max(0, 1 - score * score));
  const hitVec = [score, orthogonal];
  return (text: string) => (text.startsWith("text for ") ? hitVec : queryVec);
}

// ── heuristic gate — threshold defaults, verified against the ticket ───────

test("heuristic gate threshold defaults match verified values", () => {
  assert.equal(HEURISTIC_PASS_THRESHOLD, 0.85);
  assert.equal(HEURISTIC_RETRY_THRESHOLD, 0.6);
  assert.equal(LOOP_CONFIDENCE_THRESHOLD, 0.85);
  assert.equal(MAX_ITERATIONS, 5);
});

test("heuristicGate passes above threshold", () => {
  const result = heuristicGate([1.0, 0.0], [[1.0, 0.0], [1.0, 0.0]]);
  assert.ok(Math.abs(result.score - 1.0) < 1e-9);
  assert.equal(result.decision, GateDecision.PASS);
});

test("heuristicGate retries below threshold", () => {
  const result = heuristicGate([1.0, 0.0], [[0.0, 1.0]]);
  assert.ok(Math.abs(result.score - 0.0) < 1e-9);
  assert.equal(result.decision, GateDecision.RETRY);
});

test("heuristicGate evaluates between thresholds", () => {
  const result = heuristicGate([1.0, 0.0], [[0.7, Math.sqrt(1 - 0.7 ** 2)]]);
  assert.ok(Math.abs(result.score - 0.7) < 1e-9);
  assert.equal(result.decision, GateDecision.EVALUATE);
});

test("heuristicGate no hits retries", () => {
  const result = heuristicGate([1.0, 0.0], []);
  assert.equal(result.score, 0.0);
  assert.equal(result.decision, GateDecision.RETRY);
});

test("heuristicGate boundary values fall into evaluate", () => {
  // Strict inequalities: exactly at either bar is neither an auto-pass nor
  // an auto-retry — it must go to the (cheap-model) evaluator, not be
  // silently treated as confident or worthless.
  const passBoundary = heuristicGate([1.0, 0.0], [[0.85, Math.sqrt(1 - 0.85 ** 2)]]);
  assert.equal(passBoundary.decision, GateDecision.EVALUATE);
  const retryBoundary = heuristicGate([1.0, 0.0], [[0.6, Math.sqrt(1 - 0.6 ** 2)]]);
  assert.equal(retryBoundary.decision, GateDecision.EVALUATE);
});

// ── corrective retrieval grading ────────────────────────────────────────────

test("gradeHits computes fraction correct", async () => {
  const hits = [hit("c1"), hit("c2"), hit("c3")];
  const graderFn: GraderFn = () => [HitGrade.CORRECT, HitGrade.INCORRECT, HitGrade.AMBIGUOUS];
  const result = await gradeHits("q", hits, graderFn);
  assert.ok(Math.abs(result.fractionCorrect - 1.0 / 3.0) < 1e-9);
  assert.deepEqual(result.grades, [HitGrade.CORRECT, HitGrade.INCORRECT, HitGrade.AMBIGUOUS]);
});

test("gradeHits needs requery below floor", async () => {
  const hits = [hit("c1"), hit("c2")];
  const graderFn: GraderFn = () => [HitGrade.INCORRECT, HitGrade.INCORRECT];
  const result = await gradeHits("q", hits, graderFn);
  assert.ok(result.fractionCorrect < CORRECTIVE_FRACTION_CORRECT_FLOOR);
  assert.equal(result.needsRequery, true);
});

test("gradeHits does not need requery above floor", async () => {
  const hits = [hit("c1"), hit("c2")];
  const graderFn: GraderFn = () => [HitGrade.CORRECT, HitGrade.CORRECT];
  const result = await gradeHits("q", hits, graderFn);
  assert.equal(result.needsRequery, false);
});

test("gradeHits empty hits short-circuits", async () => {
  const result = await gradeHits("q", [], () => []);
  assert.equal(result.fractionCorrect, 0.0);
  assert.deepEqual(result.grades, []);
  assert.ok(result instanceof CorrectiveGradingResult);
});

test("gradeHits rejects mismatched grade count", async () => {
  const hits = [hit("c1"), hit("c2")];
  await assert.rejects(() => gradeHits("q", hits, () => [HitGrade.CORRECT]), RangeError);
});

// ── runAgenticLoop — the zero-LLM-calls property (AC #2) ────────────────────

test("iteration 0 heuristic pass makes zero LLM calls", async () => {
  let queryCallCount = 0;
  const client = mockRagClient(() => {
    queryCallCount += 1;
    return { status: 200, body: { hits: [hit("c1"), hit("c2")] } };
  });

  const graderCalls: unknown[] = [];
  const hydeCalls: string[] = [];
  const graderFn: GraderFn = (query, hits) => {
    graderCalls.push([query, hits]);
    return hits.map(() => HitGrade.CORRECT);
  };
  const hypothesisFn = (q: string): string => {
    hydeCalls.push(q);
    return "hypothetical answer";
  };

  const result = await runAgenticLoop(client, "What is RelataDB?", "DocumentChunk", {
    purpose: "research",
    embeddingFn: embeddingFnForScore(1.0), // clears the pass bar
    graderFn,
    hypothesisFn,
  });

  assert.equal(result.stoppedReason, "heuristic_pass");
  assert.equal(result.llmCalls, 0);
  assert.equal(queryCallCount, 1); // exactly one /rag/query call, nothing more
  assert.deepEqual(graderCalls, []); // graderFn never invoked
  assert.deepEqual(hydeCalls, []); // hypothesisFn never invoked
  assert.equal(result.iterations.length, 1);
  assert.ok(Math.abs((result.iterations[0]!.confidence ?? -1) - 1.0) < 1e-9);
});

// ── runAgenticLoop — MAX_ITERATIONS hard cap under adversarial input ───────

test("heuristic retry is bounded by max iterations", async () => {
  let queryCallCount = 0;
  const client = mockRagClient(() => {
    queryCallCount += 1;
    return { status: 200, body: { hits: [hit("c1")] } };
  });

  // Score 0.0 never clears the retry floor — an adversarial embeddingFn
  // that always forces GateDecision.RETRY.
  const result = await runAgenticLoop(client, "adversarial query", "DocumentChunk", {
    purpose: "research",
    embeddingFn: embeddingFnForScore(0.0),
    maxIterations: 3,
  });

  assert.equal(result.stoppedReason, "max_iterations");
  assert.equal(queryCallCount, 3);
  assert.equal(result.iterations.length, 3);
  assert.equal(result.llmCalls, 0); // RETRY never reaches the evaluator
});

test("corrective grading low fraction correct is bounded by max iterations", async () => {
  let queryCallCount = 0;
  const client = mockRagClient(() => {
    queryCallCount += 1;
    return { status: 200, body: { hits: [hit("c1"), hit("c2")] } };
  });

  // An adversarial grader that never reports confidence.
  const graderFn: GraderFn = (_query, hits) => hits.map(() => HitGrade.INCORRECT);

  const result = await runAgenticLoop(client, "adversarial query", "DocumentChunk", {
    purpose: "research",
    embeddingFn: embeddingFnForScore(0.7), // lands in EVALUATE
    graderFn,
    maxIterations: 3,
  });

  assert.equal(result.stoppedReason, "max_iterations");
  assert.equal(queryCallCount, 3);
  assert.equal(result.llmCalls, 3); // one grading call per iteration, no HyDE
});

test("no grader configured stops immediately on evaluate", async () => {
  const client = mockRagClient(() => ({ status: 200, body: { hits: [hit("c1")] } }));
  const result = await runAgenticLoop(client, "q", "DocumentChunk", {
    purpose: "research",
    embeddingFn: embeddingFnForScore(0.7),
  });
  assert.equal(result.stoppedReason, "no_grader_configured");
  assert.equal(result.llmCalls, 0);
  assert.equal(result.iterations.length, 1);
});

// ── runAgenticLoop — corrective grading reaching loop confidence ───────────

test("corrective grading confident stop", async () => {
  let queryCallCount = 0;
  const client = mockRagClient(() => {
    queryCallCount += 1;
    return { status: 200, body: { hits: [hit("c1"), hit("c2")] } };
  });
  const graderFn: GraderFn = (_query, hits) => hits.map(() => HitGrade.CORRECT);

  const result = await runAgenticLoop(client, "q", "DocumentChunk", {
    purpose: "research",
    embeddingFn: embeddingFnForScore(0.7),
    graderFn,
  });
  assert.equal(result.stoppedReason, "confident");
  assert.equal(queryCallCount, 1);
  assert.equal(result.llmCalls, 1);
  const last = result.iterations[result.iterations.length - 1]!;
  assert.ok(Math.abs((last.confidence ?? -1) - 1.0) < 1e-9);
  assert.ok((last.confidence ?? -1) >= LOOP_CONFIDENCE_THRESHOLD);
});

// ── runAgenticLoop — web-search fallback + HyDE requery refinement ─────────

test("web search fallback used when needs requery", async () => {
  const client = mockRagClient(() => ({ status: 200, body: { hits: [hit("c1")] } }));
  const graderFn: GraderFn = (_query, hits) => hits.map(() => HitGrade.INCORRECT);

  const fallbackCalls: string[] = [];
  const webSearchFallback = (q: string): RagQueryResponse => {
    fallbackCalls.push(q);
    return { hits: [hit("web-1")] };
  };

  const result = await runAgenticLoop(client, "q", "DocumentChunk", {
    purpose: "research",
    embeddingFn: embeddingFnForScore(0.7),
    graderFn,
    webSearchFallback,
    maxIterations: 5,
  });
  assert.equal(result.stoppedReason, "web_search_fallback");
  assert.deepEqual(fallbackCalls, ["q"]);
  assert.deepEqual(result.response.hits.map((h) => h.chunk_id), ["web-1"]);
  assert.equal(result.llmCalls, 1); // the one grading call; fallback isn't an LLM call
});

test("HyDE refines query on requery and is called at most once per retry", async () => {
  const client = mockRagClient(() => ({ status: 200, body: { hits: [hit("c1")] } }));
  const graderFn: GraderFn = (_query, hits) => hits.map(() => HitGrade.INCORRECT);

  const hydeCalls: string[] = [];
  const hypothesisFn = (q: string): string => {
    hydeCalls.push(q);
    return "a refined hypothetical answer, not numeric-intent";
  };

  const result = await runAgenticLoop(client, "How does hybrid retrieval work?", "DocumentChunk", {
    purpose: "research",
    embeddingFn: embeddingFnForScore(0.7),
    graderFn,
    hypothesisFn,
    maxIterations: 2,
  });
  assert.equal(result.stoppedReason, "max_iterations");
  assert.equal(result.iterations.length, 2);
  // HyDE only fires once — after iteration 0's low-confidence grading, not
  // again on the last iteration (which returns before requerying further).
  assert.deepEqual(hydeCalls, ["How does hybrid retrieval work?"]);
  assert.equal(result.llmCalls, 3); // 2 grading calls + 1 HyDE call
  assert.equal(result.iterations[1]!.query, "a refined hypothetical answer, not numeric-intent");
});

test("runAgenticLoop rejects non-positive max iterations", async () => {
  const client = mockRagClient(() => ({ status: 200, body: { hits: [] } }));
  await assert.rejects(
    () =>
      runAgenticLoop(client, "q", "DocumentChunk", {
        purpose: "research",
        embeddingFn: embeddingFnForScore(1.0),
        maxIterations: 0,
      }),
    RangeError,
  );
});

// ── sub-agent fan-out — verified default thresholds ─────────────────────────

function strategies(): SubAgentStrategy[] {
  return [
    { name: "lexical", ragOptions: { searchMode: "lexical" } },
    { name: "dense", ragOptions: { searchMode: "dense" } },
    { name: "hybrid", ragOptions: { searchMode: "hybrid" } },
  ];
}

function hitWithConfidence(chunkId: string, relevanceConfidence: number | null): RagHit {
  return hit(chunkId, { relevance_confidence: relevanceConfidence });
}

test("fanout threshold defaults match verified values", () => {
  assert.equal(LOW_CONFIDENCE_FLOOR, 0.2);
  assert.equal(MERGE_THRESHOLD, 0.5);
  assert.equal(MIN_FANOUT_STRATEGIES, 2);
  assert.equal(MAX_FANOUT_STRATEGIES, 5);
});

// ── deterministic winner selection (AC #1) ──────────────────────────────────

test("winner is strict argmax by confidence, no LLM call", async () => {
  const confidences: Record<string, number> = { lexical: 0.9, dense: 0.3, hybrid: 0.1 };
  const client = mockRagClient((body) => {
    const mode = body["search_mode"] as string;
    return { status: 200, body: { hits: [hitWithConfidence(`${mode}-1`, confidences[mode]!)] } };
  });

  const result = await runSubagentFanout(client, "q", "DocumentChunk", strategies(), {
    purpose: "research",
  });

  // Deterministic argmax — no arbitration callable exists anywhere in this
  // call, so "no LLM call in the merge path" is provable by construction:
  // runSubagentFanout's signature accepts no LLM-shaped callable at all.
  assert.equal(result.winner.strategy.name, "lexical");
  assert.ok(Math.abs(result.winner.confidence - 0.9) < 1e-9);
});

test("ties broken by strategy declaration order", async () => {
  const client = mockRagClient(() => ({
    status: 200,
    body: { hits: [hitWithConfidence("c1", 0.9)] },
  }));
  const result = await runSubagentFanout(client, "q", "DocumentChunk", strategies(), {
    purpose: "research",
  }); // lexical, dense, hybrid — all score 0.9
  assert.equal(result.winner.strategy.name, "lexical");
});

// ── LOW_CONFIDENCE_FLOOR — excluded as noise before any expensive step ─────

test("low-confidence strategies excluded as noise", async () => {
  const confidences: Record<string, number> = { lexical: 0.9, dense: 0.1, hybrid: 0.05 };
  const client = mockRagClient((body) => {
    const mode = body["search_mode"] as string;
    return { status: 200, body: { hits: [hitWithConfidence(`${mode}-1`, confidences[mode]!)] } };
  });
  const result = await runSubagentFanout(client, "q", "DocumentChunk", strategies(), {
    purpose: "research",
  });
  assert.deepEqual(
    new Set(result.excluded.map((r) => r.strategy.name)),
    new Set(["dense", "hybrid"]),
  );
  assert.deepEqual(result.included, [result.winner]);
});

test("all strategies below floor falls back to best scoring", async () => {
  const confidences: Record<string, number> = { lexical: 0.15, dense: 0.1, hybrid: 0.05 };
  const client = mockRagClient((body) => {
    const mode = body["search_mode"] as string;
    return { status: 200, body: { hits: [hitWithConfidence(`${mode}-1`, confidences[mode]!)] } };
  });
  const result = await runSubagentFanout(client, "q", "DocumentChunk", strategies(), {
    purpose: "research",
  });
  assert.equal(result.winner.strategy.name, "lexical");
  assert.equal(result.excluded.length, 2);
});

// ── MERGE_THRESHOLD — supporting evidence folded in via RRF merge ──────────

test("survivor above merge threshold is folded in", async () => {
  const confidences: Record<string, number> = { lexical: 0.9, dense: 0.6, hybrid: 0.05 };
  const client = mockRagClient((body) => {
    const mode = body["search_mode"] as string;
    return { status: 200, body: { hits: [hitWithConfidence(`${mode}-1`, confidences[mode]!)] } };
  });
  const result = await runSubagentFanout(client, "q", "DocumentChunk", strategies(), {
    purpose: "research",
  });
  assert.deepEqual(new Set(result.included.map((r) => r.strategy.name)), new Set(["lexical", "dense"]));
  const mergedIds = new Set(result.mergedResponse.hits.map((h) => h.chunk_id));
  assert.deepEqual(mergedIds, new Set(["lexical-1", "dense-1"]));
});

test("survivor below merge threshold is not folded in", async () => {
  const confidences: Record<string, number> = { lexical: 0.9, dense: 0.4, hybrid: 0.3 };
  const client = mockRagClient((body) => {
    const mode = body["search_mode"] as string;
    return { status: 200, body: { hits: [hitWithConfidence(`${mode}-1`, confidences[mode]!)] } };
  });
  const result = await runSubagentFanout(client, "q", "DocumentChunk", strategies(), {
    purpose: "research",
  });
  assert.deepEqual(result.included, [result.winner]);
  assert.equal(result.mergedResponse, result.winner.response);
  assert.deepEqual(new Set(result.mergedResponse.hits.map((h) => h.chunk_id)), new Set(["lexical-1"]));
});

// ── missing relevance_confidence (pre-#4520 server) defaults to 0.0 ────────

test("missing relevance_confidence defaults to zero and is excluded", async () => {
  const client = mockRagClient(() => ({
    status: 200,
    body: { hits: [hitWithConfidence("c1", null)] },
  }));
  const result = await runSubagentFanout(client, "q", "DocumentChunk", strategies(), {
    purpose: "research",
  });
  assert.equal(result.winner.confidence, 0.0);
  // All three strategies tie at 0.0 (below the floor) -> fallback keeps one
  // winner and excludes the other two, never crashes on an all-noise set.
  assert.equal(result.excluded.length, 2);
});

test("empty hits scores zero confidence", async () => {
  const client = mockRagClient(() => ({ status: 200, body: { hits: [] } }));
  const result = await runSubagentFanout(client, "q", "DocumentChunk", strategies(), {
    purpose: "research",
  });
  assert.equal(result.winner.confidence, 0.0);
});

// ── strategy-count validation ───────────────────────────────────────────────

test("rejects fewer than two strategies", async () => {
  const client = mockRagClient(() => ({ status: 200, body: { hits: [] } }));
  await assert.rejects(
    () => runSubagentFanout(client, "q", "DocumentChunk", [strategies()[0]!], { purpose: "research" }),
    RangeError,
  );
});

test("rejects more than five strategies", async () => {
  const client = mockRagClient(() => ({ status: 200, body: { hits: [] } }));
  const six: SubAgentStrategy[] = Array.from({ length: 6 }, (_v, i) => ({
    name: `s${i}`,
    ragOptions: { searchMode: "hybrid" },
  }));
  await assert.rejects(
    () => runSubagentFanout(client, "q", "DocumentChunk", six, { purpose: "research" }),
    RangeError,
  );
});

// ── every strategy issues exactly one /rag/query call, nothing more ────────

test("each strategy issues exactly one call", async () => {
  let callCount = 0;
  const client = mockRagClient(() => {
    callCount += 1;
    return { status: 200, body: { hits: [hitWithConfidence("c1", 0.9)] } };
  });
  await runSubagentFanout(client, "q", "DocumentChunk", strategies(), { purpose: "research" });
  assert.equal(callCount, strategies().length);
});
