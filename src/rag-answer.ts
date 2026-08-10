/**
 * The composed end-to-end RAG answer pipeline — the missing piece found
 * during a post-epic alignment audit of #4529.
 *
 * Faithful TS port of `sdks/python/relata/rag_answer.py` (#4584, epic
 * #4576) — closing the epic's own validation criterion ("an end-to-end
 * query through the SDK loop produces a cited, faithfulness-checked answer
 * with its reasoning trace recorded as governed rows"). This is the last
 * module in the epic: it composes every other TS/Go-ported stage —
 * `./rag-understanding.ts` (#4577), `./rag-loop.ts` (#4582), `./synthesis.ts`
 * (#4579), `./rag-trace.ts` (#4583) — none of them reimplemented here.
 *
 * **Design note — why this doesn't call {@link smartRagQuery} directly.**
 * `smartRagQuery` bundles its front-door gate (content-safety + SQL-shape
 * routing) together with a single-pass retrieval call it makes itself. This
 * module needs the *gate* but not that single retrieval pass — retrieval
 * here is handled by {@link runAgenticLoop} (iteration) or
 * {@link runSubagentFanout} (breadth), neither of which `smartRagQuery` can
 * delegate to. So this module calls the same gate primitives `smartRagQuery`
 * calls internally ({@link checkContentSafety}, {@link classifyQueryShape} +
 * the `route*Query` functions) directly, once, up front — not a second,
 * divergent gate implementation, the identical functions, just not wrapped
 * in `smartRagQuery`'s own retrieval call.
 *
 * **Design note — content-safety/SQL-routing runs once, not per loop
 * iteration.** A corrective-grading re-query is a HyDE-refined variant of
 * the *same already-vetted query text* (see `./rag-loop.ts`'s
 * `needsRequery` handling), not new untrusted input — so gating it again
 * per iteration would be redundant, not safer.
 *
 * **Design note — fan-out and the loop are alternate retrieval strategies,
 * not layered.** When `fanoutStrategies` is given, {@link runSubagentFanout}
 * provides the one and only retrieval pass (breadth: several parallel
 * strategies, deterministically merged) and the cost-ladder loop's iteration
 * machinery does not run — its result is wrapped as a single-iteration
 * {@link LoopResult} (`stoppedReason: "fanout_complete"`) purely so
 * {@link storeReasoningTrace} has the shape it expects; no iteration/re-query
 * happens in this path. Omit `fanoutStrategies` for the loop's
 * iteration/re-query behavior (depth) instead.
 *
 * **Known limitation, not solved here.** A `clarification` (#4534, entity
 * disambiguation) surfacing mid-loop is not specially handled — the loop's
 * zero-hits heuristic (`heuristicGate` scores empty hits `0.0` -> `RETRY`)
 * means it will retry to `maxIterations` and give up, a bounded and honest
 * failure rather than a silent wrong answer, but not a resolution. Resolving
 * a clarification is a separate, multi-turn caller decision by design
 * (#4534's own resume flow) — not something one call should auto-resolve.
 *
 * One structural adaptation from the Python source, required by language
 * shape rather than a deliberate behavior change: Python exposes separate
 * sync (`run_rag_answer`) and async (`arun_rag_answer`) twins because its
 * `RelataClient` has two transports; TypeScript's `RelataClient` is
 * async-only, so both collapse to the single {@link runRagAnswer} here — the
 * same collapse every other RAG-epic TS module already made. Python's
 * `run_rag_answer` takes a `RagClient` and reaches into its private
 * `_client` attribute for SQL routing; TypeScript's `RagClient` (`./rag.ts`)
 * holds no such back-reference (its transport fields are true `#private`),
 * so — mirroring `./rag-understanding.ts`'s `smartRagQuery` — this module
 * takes the `RelataClient` directly and builds a `RagClient` internally via
 * `RagClient.fromClient()` for the loop/fan-out calls.
 *
 * A second shape difference, forced by `./rag.ts`'s `RagQueryResponse`
 * carrying only `hits` (unlike Python's `RagQueryResponse`, which also
 * carries `refused`/`sql_result`/`low_confidence`/`low_confidence_reason`):
 * {@link RagAnswerResult.response} is typed as `./rag-understanding.ts`'s
 * {@link SmartRagQueryResult} — the exact same shape `smartRagQuery` itself
 * returns — rather than a second, duplicate wrapper type invented here.
 */

import type { RelataClient } from "./client.ts";
import type { McpClient } from "./mcp.ts";
import { RagClient, type RagQueryOptions } from "./rag.ts";
import {
  MAX_ITERATIONS,
  runAgenticLoop,
  runSubagentFanout,
  type EmbeddingFn,
  type FanoutResult,
  type GraderFn,
  type LoopResult,
  type SubAgentStrategy,
  type WebSearchFallbackFn,
} from "./rag-loop.ts";
import { storeReasoningTrace } from "./rag-trace.ts";
import {
  QueryShape,
  SQL_ROUTABLE_SHAPES,
  SmartRagQueryResult,
  checkContentSafety,
  classifyQueryShape,
  routeAggregationQuery,
  routeAttributeFilterQuery,
  routeBooleanQuery,
  routeNegationQuery,
  routeRankingQuery,
  type HypothesisGenerator,
  type RouteQueryOptions,
} from "./rag-understanding.ts";
import { synthesize, type EntailmentFn, type LlmFn, type SynthesisResult } from "./synthesis.ts";
import type { QueryResult } from "./types.ts";

/**
 * Final result of {@link runRagAnswer}.
 *
 * `loopResult`/`fanoutResult`/`synthesisResult`/`trace` are `undefined` when
 * the query was refused or SQL-routed before any retrieval happened — check
 * `response.refused`/`response.sqlResult` (or `response.isRefused`/
 * `response.isSqlRouted`) first.
 */
export interface RagAnswerResult {
  query: string;
  response: SmartRagQueryResult;
  loopResult: LoopResult | undefined;
  fanoutResult: FanoutResult | undefined;
  synthesisResult: SynthesisResult | undefined;
  trace: Record<string, unknown> | undefined;
}

/**
 * `{ purpose }` when `purpose` is defined, `{}` otherwise — duplicated here
 * per-module, same pattern as every other RAG-epic TS module (see
 * `./rag-loop.ts`'s copy of the same helper).
 */
function purposeOpt(purpose: string | undefined): { purpose?: string } {
  return purpose !== undefined ? { purpose } : {};
}

/**
 * Strip every `undefined`-valued key from `obj` — same
 * `exactOptionalPropertyTypes` reason as {@link purposeOpt} but for a
 * multi-field options object built from several independently-optional
 * inputs at once. Duplicated here per-module (see
 * `./rag-understanding.ts`'s copy of the same helper).
 */
function stripUndefined<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v !== undefined) out[key] = v;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

interface DispatchSqlShapeOpts {
  purpose: string | undefined;
  structuredFieldMap: Readonly<Record<string, string>> | undefined;
  structuredKnownFields: Iterable<string> | undefined;
  attributeFieldMap: Readonly<Record<string, string>> | undefined;
  attributeKnownFields: Iterable<string> | undefined;
}

/**
 * Mirrors `smartRagQuery`'s SQL-shape dispatch switch exactly — same
 * functions, same field-map contract, not a reimplementation.
 */
async function dispatchSqlShape(
  client: RelataClient,
  query: string,
  type: string,
  shape: QueryShape,
  opts: DispatchSqlShapeOpts,
): Promise<QueryResult | undefined> {
  const routeOpts: RouteQueryOptions = stripUndefined({
    purpose: opts.purpose,
    fieldMap:
      shape === QueryShape.ATTRIBUTE_FILTER ? opts.attributeFieldMap : opts.structuredFieldMap,
    knownFields:
      shape === QueryShape.ATTRIBUTE_FILTER
        ? opts.attributeKnownFields
        : opts.structuredKnownFields,
  });
  switch (shape) {
    case QueryShape.ATTRIBUTE_FILTER:
      return routeAttributeFilterQuery(client, query, type, routeOpts);
    case QueryShape.AGGREGATION:
      return routeAggregationQuery(client, query, type, routeOpts);
    case QueryShape.NEGATION:
      return routeNegationQuery(client, query, type, routeOpts);
    case QueryShape.BOOLEAN:
      return routeBooleanQuery(client, query, type, routeOpts);
    default: // QueryShape.RANKING
      return routeRankingQuery(client, query, type, routeOpts);
  }
}

/**
 * Wrap a {@link FanoutResult} as a single-iteration {@link LoopResult}
 * purely so {@link storeReasoningTrace} (which requires a `LoopResult`) has
 * the shape it expects. No iteration/re-query happened — this is
 * bookkeeping, not a claim that the loop ran.
 */
function fanoutAsLoopResult(fanoutResult: FanoutResult, query: string): LoopResult {
  return {
    response: fanoutResult.mergedResponse,
    iterations: [
      {
        query,
        response: fanoutResult.mergedResponse,
        gate: undefined,
        grading: undefined,
        confidence: fanoutResult.winner.confidence,
      },
    ],
    llmCalls: 0,
    stoppedReason: "fanout_complete",
  };
}

/** Options for {@link runRagAnswer}. */
export interface RunRagAnswerOptions {
  purpose?: string;
  /**
   * Caller-supplied embedding function for the heuristic gate ({@link
   * runAgenticLoop}'s `embeddingFn`) — not an LLM call, RelataDB computes no
   * embeddings itself (ADR-0298). Required (matches `runAgenticLoop`'s own
   * required `embeddingFn`, even on the fan-out path where it goes unused).
   */
  embeddingFn: EmbeddingFn;
  /** Text-completion callable used for the synthesis pass ({@link synthesize}'s `llm`). Required. */
  llm: LlmFn;
  /** Caller-supplied batched corrective-retrieval grader, forwarded to {@link runAgenticLoop}. */
  graderFn?: GraderFn;
  /** Caller-supplied HyDE hypothesis generator, forwarded to {@link runAgenticLoop}. */
  hypothesisFn?: HypothesisGenerator;
  /** Caller-supplied web-search fallback, forwarded to {@link runAgenticLoop}. */
  webSearchFallback?: WebSearchFallbackFn;
  /** Hard cap on loop iterations (default {@link MAX_ITERATIONS}), forwarded to {@link runAgenticLoop}. Unused on the fan-out path. */
  maxIterations?: number;
  /**
   * When given, replaces the cost-ladder loop with {@link runSubagentFanout}
   * (breadth instead of depth) — see the module doc's fan-out-vs-loop design
   * note.
   */
  fanoutStrategies?: readonly SubAgentStrategy[];
  /** Runs the post-synthesis entailment pass by default — forwarded to {@link synthesize}. */
  faithfulnessCheck?: boolean;
  /** Forwarded to {@link synthesize}. */
  faithfulnessLlm?: LlmFn;
  /** Forwarded to {@link synthesize}. */
  entailmentFn?: EntailmentFn;
  /** Category-label -> pattern mapping for {@link checkContentSafety}. `undefined` disables the gate entirely. */
  contentSafetyPatterns?: Readonly<Record<string, string | RegExp>>;
  /** Keyword -> canonical field name for #4535's aggregation/negation/boolean/ranking SQL routing. */
  structuredFieldMap?: Readonly<Record<string, string>>;
  /** Restricts #4535's routing to fields actually present on `type`'s schema. */
  structuredKnownFields?: Iterable<string>;
  /** Overrides/extends `./rag-understanding.ts`'s built-in keyword map for #4536's structured-attribute-filter routing. */
  attributeFieldMap?: Readonly<Record<string, string>>;
  /** Restricts attribute-filter routing to fields actually present on `type`'s schema. */
  attributeKnownFields?: Iterable<string>;
  /** Forwarded to {@link storeReasoningTrace}. */
  caseId?: string;
  /** Forwarded to {@link storeReasoningTrace}. */
  durationMs?: number;
  /**
   * Forwarded to every `/rag/query` call made by {@link runAgenticLoop} or
   * {@link runSubagentFanout} (`topK`, `rerank`, `searchMode`,
   * `embeddingSlot`, `filters`, `asOf`, `expandWindow`, `graphHops`).
   */
  ragOptions?: Partial<Omit<RagQueryOptions, "type" | "purpose">>;
}

/**
 * Run the full RAG-epic pipeline end to end: gate -> retrieve (iterate or
 * fan out) -> synthesize + cite + faithfulness-check -> write the reasoning
 * trace back as governed rows.
 *
 * Returns immediately after the gate, with `loopResult`/`fanoutResult`/
 * `synthesisResult`/`trace` all `undefined`, when the query was refused
 * ({@link SmartRagQueryResult.refused}) or answered via SQL instead of
 * retrieval ({@link SmartRagQueryResult.sqlResult}) — see the module doc for
 * why gating happens once, not per iteration.
 */
export async function runRagAnswer(
  client: RelataClient,
  mcpClient: McpClient,
  query: string,
  type: string,
  opts: RunRagAnswerOptions,
): Promise<RagAnswerResult> {
  const refusal = checkContentSafety(query, opts.contentSafetyPatterns);
  if (refusal !== undefined) {
    const response = new SmartRagQueryResult({ hits: [], refused: refusal });
    return {
      query,
      response,
      loopResult: undefined,
      fanoutResult: undefined,
      synthesisResult: undefined,
      trace: undefined,
    };
  }

  const shape = classifyQueryShape(query);
  if (SQL_ROUTABLE_SHAPES.has(shape)) {
    const sqlResult = await dispatchSqlShape(client, query, type, shape, {
      purpose: opts.purpose,
      structuredFieldMap: opts.structuredFieldMap,
      structuredKnownFields: opts.structuredKnownFields,
      attributeFieldMap: opts.attributeFieldMap,
      attributeKnownFields: opts.attributeKnownFields,
    });
    if (sqlResult !== undefined) {
      const response = new SmartRagQueryResult({ hits: [], sqlResult });
      return {
        query,
        response,
        loopResult: undefined,
        fanoutResult: undefined,
        synthesisResult: undefined,
        trace: undefined,
      };
    }
    // Shape was SQL-routable but no predicate could be built (unknown
    // vocabulary/fields) — fall through to retrieval, flagged low-confidence
    // on the eventual response, exactly as smartRagQuery does.
  }

  const ragClient = RagClient.fromClient(client);

  let fanoutResult: FanoutResult | undefined;
  let loopResult: LoopResult;
  if (opts.fanoutStrategies !== undefined) {
    fanoutResult = await runSubagentFanout(
      ragClient,
      query,
      type,
      opts.fanoutStrategies,
      stripUndefined({ purpose: opts.purpose, ragOptions: opts.ragOptions }),
    );
    loopResult = fanoutAsLoopResult(fanoutResult, query);
  } else {
    loopResult = await runAgenticLoop(ragClient, query, type, {
      embeddingFn: opts.embeddingFn,
      maxIterations: opts.maxIterations ?? MAX_ITERATIONS,
      ...stripUndefined({
        purpose: opts.purpose,
        graderFn: opts.graderFn,
        hypothesisFn: opts.hypothesisFn,
        webSearchFallback: opts.webSearchFallback,
        ragOptions: opts.ragOptions,
      }),
    });
  }

  let response: SmartRagQueryResult;
  if (SQL_ROUTABLE_SHAPES.has(shape)) {
    response = new SmartRagQueryResult({
      hits: loopResult.response.hits,
      lowConfidence: true,
      lowConfidenceReason:
        `${shape}-shaped query could not be routed to SQL ` +
        `(no matching canonical field on ${JSON.stringify(type)}); fell back to retrieval (#4536/#4535)`,
    });
  } else {
    response = new SmartRagQueryResult({ hits: loopResult.response.hits });
  }

  const synthesisResult = await synthesize(query, response, {
    llm: opts.llm,
    ...stripUndefined({
      faithfulnessCheck: opts.faithfulnessCheck,
      faithfulnessLlm: opts.faithfulnessLlm,
      entailmentFn: opts.entailmentFn,
    }),
  });

  const trace = await storeReasoningTrace(
    mcpClient,
    query,
    loopResult,
    synthesisResult,
    stripUndefined({
      fanoutResult,
      caseId: opts.caseId,
      purpose: opts.purpose,
      durationMs: opts.durationMs,
    }),
  );

  return { query, response, loopResult, fanoutResult, synthesisResult, trace };
}
