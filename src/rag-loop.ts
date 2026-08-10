/**
 * The agentic loop's spine — heuristic gate, corrective retrieval grading,
 * and loop confidence evaluation (#4525, the RAG epic's three-tier cost
 * ladder), plus sub-agent fan-out with a deterministic (non-LLM) merge
 * (#4526).
 *
 * Faithful TS port of `sdks/python/relata/rag_loop.py` (#4582, epic #4576)
 * — closing the deliberate Python-only asymmetry ADR-0298 introduced ("one
 * SDK carries the canonical implementation... until real usage demands
 * porting the loop to them too"). Every verified numeric constant (the
 * seven fidelity thresholds below) matches the Python source exactly.
 *
 * Per ADR-0298, RelataDB runs no server-side agent loop and no LLM
 * (ADR-013) — this module is the SDK-side control flow that decides,
 * after each `POST /rag/query` call (#4514's ADR-0299 contract), whether
 * the hits are good enough to synthesize from or whether another round is
 * warranted, and it never calls an LLM itself: every LLM-backed decision
 * point ({@link EmbeddingFn} excepted — the heuristic gate is not an LLM
 * call either way) is a caller-supplied callable, exactly like
 * `./rag-understanding.ts`'s {@link HypothesisGenerator}.
 *
 * One structural adaptation from the Python source, required by language
 * shape rather than a deliberate behavior change: Python exposes separate
 * sync (`run_agentic_loop`/`run_subagent_fanout`) and async
 * (`arun_agentic_loop`/`arun_subagent_fanout`) twins because its
 * `RelataClient` has two transports. TypeScript's `RagClient` (`rag.ts`) is
 * async-only, so each Python sync/async pair collapses to a single `async`
 * function here — the same collapse `./rag-understanding.ts` already made
 * for `smart_rag_query`/`asmart_rag_query`. {@link EmbeddingFn} and
 * {@link GraderFn} may return synchronously or a `Promise`, matching
 * {@link HypothesisGenerator}'s existing convention.
 *
 * **The three-tier cost ladder (verified defaults — do not change without a
 * test-backed reason):**
 *
 * 1. **Heuristic gate** ({@link heuristicGate}) — centroid cosine similarity
 *    between the query embedding and the top-K `/rag/query` hits'
 *    embeddings, <5ms, no LLM call either way. Score strictly greater than
 *    {@link HEURISTIC_PASS_THRESHOLD} (`0.85`) auto-passes (stop,
 *    synthesize from these hits). Score strictly less than
 *    {@link HEURISTIC_RETRY_THRESHOLD} (`0.60`) auto-retries (issue another
 *    `/rag/query` call, still no LLM). Between the two thresholds, control
 *    proceeds to corrective retrieval grading below.
 * 2. **Corrective retrieval grading** ({@link gradeHits}) — one batched
 *    cheap-model call grades every hit correct/ambiguous/incorrect at once
 *    (never one call per hit — that would defeat the point of a *cost*
 *    ladder). A low `fractionCorrect` (below
 *    {@link CORRECTIVE_FRACTION_CORRECT_FLOOR}) marks
 *    {@link CorrectiveGradingResult.needsRequery}, which
 *    {@link runAgenticLoop} honors by forcing a re-query — refined via HyDE
 *    ({@link expandQueryHyde} from `./rag-understanding.ts`) when
 *    `hypothesisFn` is supplied, or a caller-supplied web-search fallback
 *    when `webSearchFallback` is supplied, or a plain retry otherwise.
 * 3. **Loop confidence** ({@link LOOP_CONFIDENCE_THRESHOLD}, `0.85`) — once
 *    corrective grading runs, its `fractionCorrect` *is* the loop's
 *    confidence signal (no extra LLM call to compute a separate
 *    "confidence" number): reaching the threshold stops iteration.
 *    {@link MAX_ITERATIONS} (`5`) is a hard cap enforced unconditionally —
 *    the control-flow loop is a bounded `for` loop, never unbounded, so no
 *    adversarial input (a grader that never reports high confidence, an
 *    embedding function that never clears the heuristic-pass bar) can make
 *    it spin forever.
 *
 * The one property every caller should be able to prove: **a query whose
 * heuristic-gate score clears the pass threshold on iteration 0 makes zero
 * LLM calls end to end** — {@link runAgenticLoop} returns before
 * `graderFn`/`hypothesisFn` are ever invoked in that case, and
 * {@link LoopResult.llmCalls} stays `0` (see `rag-loop.test.ts`'s
 * call-count assertions).
 *
 * **Sub-agent fan-out + deterministic merge (#4526).** {@link runSubagentFanout}
 * runs 2-5 parallel retrieval strategies (distinct `searchMode`/
 * `embeddingSlot` combinations, #4514) and picks a winner by
 * **confidence-score comparison only** — a strict `argmax`, never a
 * meta-LLM arbitration call (verified live in the reference platform
 * system: threshold merge, explicitly no arbitration call). Each
 * strategy's confidence is its top hit's `relevance_confidence` (#4520's
 * non-LLM per-hit signal), so the whole merge path, like the cost ladder
 * above, never calls an LLM. {@link LOW_CONFIDENCE_FLOOR} (`0.20`)
 * discards a strategy as noise before the (cheap, still non-LLM) winner
 * comparison runs at all; {@link MERGE_THRESHOLD} (`0.50`) decides which of
 * the *non-winning* survivors get folded into the merged result as
 * supporting evidence (via {@link rrfMerge} from `./rag-understanding.ts`)
 * rather than discarded once a winner is picked. Sub-query fan-out runs
 * concurrently via `Promise.all` — the TypeScript equivalent of the Python
 * reference's thread-pool fan-out; JavaScript's single-threaded event loop
 * has no thread-pool-size knob to mirror the sync twin's `max_workers`.
 */

import type { RagClient, RagHit, RagQueryOptions, RagQueryResponse } from "./rag.ts";
import {
  type HypothesisGenerator,
  expandQueryHyde,
  rrfKForFanout,
  rrfMerge,
} from "./rag-understanding.ts";

// ---------------------------------------------------------------------------
// Verified defaults — the cost ladder's thresholds (#4525) + fan-out's
// (#4526). Do not change without a test-backed reason.
// ---------------------------------------------------------------------------

/**
 * Heuristic-gate auto-pass bar. Centroid cosine strictly greater than this
 * skips corrective grading entirely — zero LLM calls.
 */
export const HEURISTIC_PASS_THRESHOLD = 0.85;

/**
 * Heuristic-gate auto-retry floor. Centroid cosine strictly less than this
 * re-queries without ever reaching corrective grading either — still zero
 * LLM calls.
 */
export const HEURISTIC_RETRY_THRESHOLD = 0.6;

/**
 * Loop confidence threshold. Once corrective grading's `fractionCorrect`
 * reaches this, {@link runAgenticLoop} stops iterating.
 */
export const LOOP_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Hard cap on loop iterations, enforced unconditionally (a bounded `for`
 * loop, never unbounded) — no adversarial input can make
 * {@link runAgenticLoop} spin forever.
 */
export const MAX_ITERATIONS = 5;

/**
 * `fractionCorrect` floor below which corrective grading marks
 * {@link CorrectiveGradingResult.needsRequery}. Not one of the epic's three
 * named thresholds (the ticket describes the *behavior* — "low
 * fractionCorrect forces a re-query" — without pinning an exact number);
 * chosen as the natural "more wrong than right" boundary and isolated in
 * its own constant so a future RAG-quality-gate finding can retune it
 * without touching the three verified thresholds above.
 */
export const CORRECTIVE_FRACTION_CORRECT_FLOOR = 0.5;

/**
 * Below this per-strategy confidence, a sub-agent result is excluded
 * entirely as noise **before** the winner comparison runs at all —
 * verified default from the reference platform system.
 */
export const LOW_CONFIDENCE_FLOOR = 0.2;

/**
 * A non-winning survivor scoring at or above this confidence is folded into
 * the merged result as supporting evidence; below it, only the winner's
 * hits are returned. Deliberately below any implicit "clear winner" bar —
 * strong enough to merge, not strong enough to contend for winner on its
 * own — verified default from the reference platform system.
 */
export const MERGE_THRESHOLD = 0.5;

/**
 * {@link runSubagentFanout} requires at least 2 strategies (below that
 * there is nothing to fan out or merge) and at most 5 (the verified
 * reference-system range).
 */
export const MIN_FANOUT_STRATEGIES = 2;
export const MAX_FANOUT_STRATEGIES = 5;

// ---------------------------------------------------------------------------
// 1. Heuristic gate
// ---------------------------------------------------------------------------

/** Outcome of {@link heuristicGate}. */
export type GateDecision = "pass" | "retry" | "evaluate";

export const GateDecision = {
  /** Score > {@link HEURISTIC_PASS_THRESHOLD} — stop, synthesize from these hits. No LLM call. */
  PASS: "pass",
  /** Score < {@link HEURISTIC_RETRY_THRESHOLD} — issue another `/rag/query` call. No LLM call. */
  RETRY: "retry",
  /** Between the two thresholds — proceed to corrective retrieval grading ({@link gradeHits}), the loop's one LLM call per iteration. */
  EVALUATE: "evaluate",
} as const satisfies Record<string, GateDecision>;

/**
 * Caller-supplied embedding function — RelataDB computes no embeddings
 * itself (ADR-0298). Used only for the <5ms heuristic gate, never for an
 * LLM call. May return synchronously or a `Promise`, unlike the Python
 * reference's sync-only `Callable[[str], Sequence[float]]` — TypeScript has
 * no sync/async transport split to mirror, so this accepts either (same
 * convention as {@link HypothesisGenerator}).
 */
export type EmbeddingFn = (text: string) => readonly number[] | Promise<readonly number[]>;

function dotProduct(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

function vectorNorm(a: readonly number[]): number {
  return Math.sqrt(a.reduce((sum, x) => sum + x * x, 0));
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0.0;
  const normA = vectorNorm(a);
  const normB = vectorNorm(b);
  if (normA === 0.0 || normB === 0.0) return 0.0;
  return dotProduct(a, b) / (normA * normB);
}

function centroid(vectors: readonly (readonly number[])[]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const sums = new Array<number>(dim).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) sums[i] = (sums[i] ?? 0) + (vec[i] ?? 0);
  }
  const n = vectors.length;
  return sums.map((s) => s / n);
}

/** Result of {@link heuristicGate}. */
export interface HeuristicGateResult {
  /**
   * Centroid cosine similarity between the query embedding and the top-K
   * hit embeddings — `0.0` when there are no hits to compare against.
   */
  score: number;
  decision: GateDecision;
}

/**
 * Cheap pre-LLM gate: centroid cosine between `queryEmbedding` and the
 * top-K `/rag/query` hits' embeddings, <5ms, no LLM call either way.
 *
 * Zero hits scores `0.0` and decides {@link GateDecision.RETRY} — nothing
 * to be confident about.
 */
export function heuristicGate(
  queryEmbedding: readonly number[],
  hitEmbeddings: readonly (readonly number[])[],
): HeuristicGateResult {
  if (hitEmbeddings.length === 0) {
    return { score: 0.0, decision: GateDecision.RETRY };
  }
  const score = cosineSimilarity(queryEmbedding, centroid(hitEmbeddings));
  let decision: GateDecision;
  if (score > HEURISTIC_PASS_THRESHOLD) decision = GateDecision.PASS;
  else if (score < HEURISTIC_RETRY_THRESHOLD) decision = GateDecision.RETRY;
  else decision = GateDecision.EVALUATE;
  return { score, decision };
}

// ---------------------------------------------------------------------------
// 2. Corrective retrieval grading
// ---------------------------------------------------------------------------

/** Per-hit grade from {@link gradeHits}'s batched cheap-model call. */
export type HitGrade = "correct" | "ambiguous" | "incorrect";

export const HitGrade = {
  CORRECT: "correct",
  AMBIGUOUS: "ambiguous",
  INCORRECT: "incorrect",
} as const satisfies Record<string, HitGrade>;

/**
 * Caller-supplied batched grading call — RelataDB runs no LLM (ADR-013).
 * Called once per grading round with `(query, hits)`, must return exactly
 * one {@link HitGrade} per hit, same order — one batched call, never one
 * call per hit.
 */
export type GraderFn = (query: string, hits: RagHit[]) => HitGrade[] | Promise<HitGrade[]>;

/**
 * Result of {@link gradeHits}. A class (not a plain interface) so
 * {@link needsRequery} can be a derived getter, same pattern as
 * `./rag-understanding.ts`'s `LargeExportResult`/`SmartRagQueryResult`.
 */
export class CorrectiveGradingResult {
  /** One grade per hit, same order as the graded hit list. */
  readonly grades: HitGrade[];
  /** `count(CORRECT) / hits.length` — `0.0` when there were no hits to grade. */
  readonly fractionCorrect: number;

  constructor(grades: HitGrade[], fractionCorrect: number) {
    this.grades = grades;
    this.fractionCorrect = fractionCorrect;
  }

  /**
   * `true` when {@link fractionCorrect} is below
   * {@link CORRECTIVE_FRACTION_CORRECT_FLOOR} — the corrective-retrieval
   * signal that forces a re-query (refined via HyDE, or a web-search
   * fallback, or a plain retry — see {@link runAgenticLoop}).
   */
  get needsRequery(): boolean {
    return this.fractionCorrect < CORRECTIVE_FRACTION_CORRECT_FLOOR;
  }
}

/**
 * Run one batched corrective-retrieval grading call over `hits`.
 *
 * Throws `RangeError` if `graderFn` returns a different number of grades
 * than hits given — a caller bug, not a valid partial grading.
 */
export async function gradeHits(
  query: string,
  hits: RagHit[],
  graderFn: GraderFn,
): Promise<CorrectiveGradingResult> {
  if (hits.length === 0) return new CorrectiveGradingResult([], 0.0);
  const grades = await graderFn(query, hits);
  if (grades.length !== hits.length) {
    throw new RangeError(
      `graderFn must return exactly one grade per hit: got ${grades.length} grade(s) for ${hits.length} hit(s)`,
    );
  }
  const nCorrect = grades.filter((g) => g === HitGrade.CORRECT).length;
  return new CorrectiveGradingResult(grades, nCorrect / hits.length);
}

// ---------------------------------------------------------------------------
// 3. Loop confidence + orchestration
// ---------------------------------------------------------------------------

/**
 * Caller-supplied web-search fallback, invoked when corrective grading's
 * {@link CorrectiveGradingResult.needsRequery} trips and a fallback is
 * configured. Returns a full `{hits}`-shaped result — the loop does not
 * care whether it came from `/rag/query` or an external search API.
 */
export type WebSearchFallbackFn = (
  query: string,
) => RagQueryResponse | Promise<RagQueryResponse>;

/**
 * Record of one {@link runAgenticLoop} iteration — the reasoning trace a
 * caller writes back to its own answer/citation model is built from a
 * sequence of these.
 */
export interface LoopIteration {
  query: string;
  response: RagQueryResponse;
  gate: HeuristicGateResult | undefined;
  grading: CorrectiveGradingResult | undefined;
  /**
   * This iteration's confidence signal — the heuristic gate's score when no
   * grading ran, otherwise the grading's `fractionCorrect`.
   */
  confidence: number | undefined;
}

/**
 * Why {@link runAgenticLoop} stopped. `"fanout_complete"` is never produced
 * by {@link runAgenticLoop} itself — it's `./rag-answer.ts`'s marker for a
 * {@link LoopResult} synthesized from a {@link FanoutResult} (no
 * iteration/re-query ran), included here (rather than widening
 * `stoppedReason` to a bare `string`) so every consumer of a `LoopResult`
 * can still exhaustively switch over this union.
 */
export type LoopStoppedReason =
  | "heuristic_pass"
  | "confident"
  | "web_search_fallback"
  | "no_grader_configured"
  | "max_iterations"
  | "fanout_complete";

/** Final result of {@link runAgenticLoop}. */
export interface LoopResult {
  response: RagQueryResponse;
  iterations: LoopIteration[];
  /**
   * Total count of caller-supplied LLM-backed calls made across every
   * iteration (`graderFn` + HyDE-refinement `hypothesisFn` calls). `0` when
   * the heuristic gate passed on iteration 0 — see the module doc's
   * zero-LLM-calls property.
   */
  llmCalls: number;
  stoppedReason: LoopStoppedReason;
}

/**
 * `{ purpose }` when `purpose` is defined, `{}` otherwise.
 *
 * Under `exactOptionalPropertyTypes`, an object literal with `purpose:
 * possiblyUndefined` is a distinct (disallowed) type from the key being
 * absent — mirrors `./rag-understanding.ts`'s private helper of the same
 * name/shape (not exported from there, so duplicated here per-module).
 */
function purposeOpt(purpose: string | undefined): { purpose?: string } {
  return purpose !== undefined ? { purpose } : {};
}

interface LoopIterationsInput {
  queryFn: (text: string) => Promise<RagQueryResponse>;
  query: string;
  embeddingFn: EmbeddingFn;
  graderFn: GraderFn | undefined;
  hypothesisFn: HypothesisGenerator | undefined;
  webSearchFallback: WebSearchFallbackFn | undefined;
  maxIterations: number;
}

/**
 * Shared control flow behind {@link runAgenticLoop} — `queryFn` is the only
 * side-effecting call, so this function itself makes no other I/O
 * decisions.
 */
async function runLoopIterations(input: LoopIterationsInput): Promise<LoopResult> {
  const { queryFn, query, embeddingFn, graderFn, hypothesisFn, webSearchFallback, maxIterations } =
    input;
  if (maxIterations < 1) throw new RangeError("maxIterations must be >= 1");

  const iterations: LoopIteration[] = [];
  let llmCalls = 0;
  let currentQuery = query;

  for (let i = 0; i < maxIterations; i++) {
    const isLast = i === maxIterations - 1;
    const response = await queryFn(currentQuery);

    const queryEmbedding = await embeddingFn(currentQuery);
    const hitEmbeddings = await Promise.all(response.hits.map((hit) => embeddingFn(hit.text)));
    const gate = heuristicGate(queryEmbedding, hitEmbeddings);

    if (gate.decision === GateDecision.PASS) {
      iterations.push({ query: currentQuery, response, gate, grading: undefined, confidence: gate.score });
      return { response, iterations, llmCalls, stoppedReason: "heuristic_pass" };
    }

    if (gate.decision === GateDecision.RETRY) {
      iterations.push({ query: currentQuery, response, gate, grading: undefined, confidence: gate.score });
      if (isLast) return { response, iterations, llmCalls, stoppedReason: "max_iterations" };
      currentQuery = query;
      continue;
    }

    // GateDecision.EVALUATE — proceed to corrective retrieval grading.
    if (!graderFn) {
      iterations.push({ query: currentQuery, response, gate, grading: undefined, confidence: gate.score });
      return { response, iterations, llmCalls, stoppedReason: "no_grader_configured" };
    }

    const grading = await gradeHits(currentQuery, response.hits, graderFn);
    llmCalls += 1;
    iterations.push({ query: currentQuery, response, gate, grading, confidence: grading.fractionCorrect });

    if (grading.fractionCorrect >= LOOP_CONFIDENCE_THRESHOLD) {
      return { response, iterations, llmCalls, stoppedReason: "confident" };
    }

    if (isLast) {
      return { response, iterations, llmCalls, stoppedReason: "max_iterations" };
    }

    if (grading.needsRequery && webSearchFallback) {
      const fallbackResponse = await webSearchFallback(currentQuery);
      iterations.push({
        query: currentQuery,
        response: fallbackResponse,
        gate: undefined,
        grading: undefined,
        confidence: undefined,
      });
      return { response: fallbackResponse, iterations, llmCalls, stoppedReason: "web_search_fallback" };
    }

    if (grading.needsRequery && hypothesisFn) {
      currentQuery = await expandQueryHyde(query, hypothesisFn);
      llmCalls += 1;
    } else {
      currentQuery = query;
    }
  }

  // Unreachable: every branch above returns once `isLast` is true, and the
  // loop's final index always has `isLast === true`.
  throw new Error("runAgenticLoop: exhausted maxIterations without returning");
}

/** Options for {@link runAgenticLoop}. */
export interface RunAgenticLoopOptions {
  purpose?: string;
  /**
   * Caller-supplied embedding function for the heuristic gate
   * ({@link heuristicGate}) — not an LLM call, RelataDB computes no
   * embeddings itself (ADR-0298).
   */
  embeddingFn: EmbeddingFn;
  /**
   * Caller-supplied batched corrective-retrieval grader ({@link gradeHits}).
   * When absent, a query landing in the heuristic gate's
   * {@link GateDecision.EVALUATE} band stops immediately with
   * `stoppedReason: "no_grader_configured"` rather than silently skipping
   * grading.
   */
  graderFn?: GraderFn;
  /**
   * Caller-supplied HyDE hypothesis generator ({@link expandQueryHyde} from
   * `./rag-understanding.ts`), used only to refine the query when
   * corrective grading's `needsRequery` trips.
   */
  hypothesisFn?: HypothesisGenerator;
  /**
   * Caller-supplied web-search fallback, tried before HyDE refinement when
   * `needsRequery` trips.
   */
  webSearchFallback?: WebSearchFallbackFn;
  /**
   * Hard cap on loop iterations (default {@link MAX_ITERATIONS}). Enforced
   * unconditionally — the loop cannot spin forever regardless of what
   * `graderFn`/`embeddingFn` return.
   */
  maxIterations?: number;
  /**
   * Forwarded to `RagClient.query()` on every `/rag/query` call
   * (`topK`, `rerank`, `searchMode`, `embeddingSlot`, `filters`, `asOf`,
   * `expandWindow`, `graphHops`).
   */
  ragOptions?: Partial<Omit<RagQueryOptions, "type" | "purpose">>;
}

/**
 * Run the three-tier cost-ladder loop: heuristic gate -> (optionally)
 * corrective retrieval grading -> loop-confidence stop, up to
 * {@link MAX_ITERATIONS} (or `opts.maxIterations`, capped the same way).
 *
 * Returns the final response, the full iteration history, the total
 * LLM-call count ({@link LoopResult.llmCalls}, `0` when the heuristic gate
 * passed on iteration 0), and why the loop stopped.
 */
export async function runAgenticLoop(
  ragClient: RagClient,
  query: string,
  type: string,
  opts: RunAgenticLoopOptions,
): Promise<LoopResult> {
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
  const queryFn = (text: string): Promise<RagQueryResponse> =>
    ragClient.query(text, { ...opts.ragOptions, type, ...purposeOpt(opts.purpose) });

  return runLoopIterations({
    queryFn,
    query,
    embeddingFn: opts.embeddingFn,
    graderFn: opts.graderFn,
    hypothesisFn: opts.hypothesisFn,
    webSearchFallback: opts.webSearchFallback,
    maxIterations,
  });
}

// ---------------------------------------------------------------------------
// 4. Sub-agent fan-out + deterministic (non-LLM) merge (#4526)
// ---------------------------------------------------------------------------

/**
 * One parallel retrieval strategy for {@link runSubagentFanout} — a
 * distinct `/rag/query` parameterization, typically a `searchMode`/
 * `embeddingSlot` combination (#4514).
 */
export interface SubAgentStrategy {
  /** Human-readable label for this strategy, surfaced on {@link SubAgentResult} for tracing/logging — not sent over the wire. */
  name: string;
  /**
   * Forwarded to `RagClient.query()` on top of whatever
   * {@link runSubagentFanout}'s own `ragOptions` already set (e.g.
   * `{ searchMode: "lexical" }`, `{ embeddingSlot: "summary" }`).
   */
  ragOptions?: Partial<Omit<RagQueryOptions, "type" | "purpose">>;
}

/** One strategy's outcome from {@link runSubagentFanout}. */
export interface SubAgentResult {
  strategy: SubAgentStrategy;
  response: RagQueryResponse;
  /**
   * This strategy's confidence score — its top hit's
   * `relevance_confidence` (#4520), or `0.0` when there are no hits or the
   * server predates #4520 (field unset).
   */
  confidence: number;
}

/** Final result of {@link runSubagentFanout}. */
export interface FanoutResult {
  /**
   * The deterministically-chosen winner — strict `argmax` by
   * {@link SubAgentResult.confidence}, ties broken by strategy declaration
   * order. Never chosen via an LLM call (#4526's AC #1).
   */
  winner: SubAgentResult;
  /**
   * The winner's hits, merged (via `rrfMerge` from `./rag-understanding.ts`)
   * with any non-winning survivor scoring at or above
   * {@link MERGE_THRESHOLD}. Equals `winner.response` unchanged when no
   * other survivor cleared {@link MERGE_THRESHOLD}.
   */
  mergedResponse: RagQueryResponse;
  /**
   * Every {@link SubAgentResult} that cleared {@link LOW_CONFIDENCE_FLOOR}
   * (winner first, then any merged-in supporting evidence, in descending
   * confidence order).
   */
  included: SubAgentResult[];
  /**
   * Every {@link SubAgentResult} discarded as noise — below
   * {@link LOW_CONFIDENCE_FLOOR} (or, in the all-strategies-below-floor
   * fallback, everything except the single best-scoring strategy).
   */
  excluded: SubAgentResult[];
}

function validateFanoutStrategies(strategies: readonly SubAgentStrategy[]): void {
  if (strategies.length < MIN_FANOUT_STRATEGIES || strategies.length > MAX_FANOUT_STRATEGIES) {
    throw new RangeError(
      `runSubagentFanout requires ${MIN_FANOUT_STRATEGIES}-${MAX_FANOUT_STRATEGIES} strategies, got ${strategies.length}`,
    );
  }
}

/**
 * Deterministic per-strategy confidence: the top hit's
 * `relevance_confidence` (#4520), or `0.0` when there are no hits or the
 * field is unset (server predates #4520). A pure function of the response
 * already returned by `/rag/query` — no LLM/network call.
 */
function strategyConfidence(response: RagQueryResponse): number {
  if (response.hits.length === 0) return 0.0;
  const confidence = response.hits[0]!.relevance_confidence;
  return confidence ?? 0.0;
}

/**
 * Shared post-processing behind {@link runSubagentFanout}: `results` is the
 * (already-fetched) per-strategy outcome list; this function makes no I/O
 * decisions and every branch is a pure function of its inputs — the
 * deterministic winner-selection + merge invariant (#4526's AC #1) lives
 * entirely here.
 */
function mergeFanoutResults(results: SubAgentResult[], mergeThreshold: number): FanoutResult {
  let survivors = results.filter((r) => r.confidence >= LOW_CONFIDENCE_FLOOR);
  let excluded = results.filter((r) => r.confidence < LOW_CONFIDENCE_FLOOR);
  if (survivors.length === 0) {
    // Every strategy scored below the noise floor — fall back to the
    // single highest-scoring result rather than returning nothing.
    const winnerFallback = results.reduce((best, r) => (r.confidence > best.confidence ? r : best));
    survivors = [winnerFallback];
    excluded = results.filter((r) => r !== winnerFallback);
  }

  // Deterministic winner: strict argmax by confidence — no LLM call. `>`
  // (not `>=`) keeps the earliest-declared strategy on a tie.
  const winner = survivors.reduce((best, r) => (r.confidence > best.confidence ? r : best));
  const supporting = survivors
    .filter((r) => r !== winner && r.confidence >= mergeThreshold)
    .sort((a, b) => b.confidence - a.confidence);
  const included = [winner, ...supporting];

  let mergedResponse: RagQueryResponse;
  if (supporting.length > 0) {
    const merged = rrfMerge(
      included.map((r) => r.response),
      rrfKForFanout(included.length),
    );
    mergedResponse = { hits: merged.hits };
  } else {
    mergedResponse = winner.response;
  }

  return { winner, mergedResponse, included, excluded };
}

/** Options for {@link runSubagentFanout}. */
export interface RunSubagentFanoutOptions {
  purpose?: string;
  /** Confidence floor (default {@link MERGE_THRESHOLD}) for folding a non-winning survivor in as supporting evidence. */
  mergeThreshold?: number;
  /** Forwarded to every strategy's `/rag/query` call before that strategy's own `ragOptions` override on top. */
  ragOptions?: Partial<Omit<RagQueryOptions, "type" | "purpose">>;
}

/**
 * Run `strategies` (2-5 parallel `/rag/query` parameterizations,
 * concurrently via `Promise.all`) and deterministically pick + merge a
 * winner.
 *
 * Winner selection is a strict `argmax` over each strategy's confidence
 * ({@link strategyConfidence}) — **no LLM call anywhere in this function**,
 * matching the reference platform system's threshold-merge design
 * (explicitly no meta-LLM arbitration call).
 */
export async function runSubagentFanout(
  ragClient: RagClient,
  query: string,
  type: string,
  strategies: readonly SubAgentStrategy[],
  opts: RunSubagentFanoutOptions = {},
): Promise<FanoutResult> {
  validateFanoutStrategies(strategies);
  const mergeThreshold = opts.mergeThreshold ?? MERGE_THRESHOLD;

  const run = async (strategy: SubAgentStrategy): Promise<SubAgentResult> => {
    const response = await ragClient.query(query, {
      ...opts.ragOptions,
      ...strategy.ragOptions,
      type,
      ...purposeOpt(opts.purpose),
    });
    return { strategy, response, confidence: strategyConfidence(response) };
  };

  const results = await Promise.all(strategies.map(run));
  return mergeFanoutResults(results, mergeThreshold);
}
