/**
 * Reasoning-trace write-back — #4528, the final SDK-side stage of the RAG
 * epic's agentic loop.
 *
 * Faithful TS port of `sdks/python/relata/rag_trace.py` (#4583, epic
 * #4576), depended on by nothing else — it consumes the already-ported
 * {@link LoopResult}/{@link FanoutResult} (`./rag-loop.ts`, #4582) and
 * {@link SynthesisResult} (`./synthesis.ts`, #4579) result types.
 *
 * **The gap this closes.** `POST /rag/query` (#4514) already returns
 * governed, citable rows, and the write path this module calls
 * (`rag_store_answer`, `crates/relata-cli/src/serve/mcp/doc_writes.rs`)
 * already turns a final answer into an auditable `RagAnswer` + `RagSource`
 * row pair. But an agentic loop's *decisions* — why it re-queried (#4525's
 * heuristic gate + corrective grading), what it discarded (a hit graded
 * ambiguous/incorrect, a #4526 fan-out strategy excluded as noise), and how
 * its confidence moved iteration to iteration — lived entirely in the SDK,
 * never reaching RelataDB's audit log or provenance chain. Today you could
 * prove *what was read*; you could not prove *how the answer was reached*.
 * This module is purely the bridge: it takes the real objects a completed
 * loop already produced and writes the full trace back via the existing
 * `rag_store_answer` MCP tool — no new write path, two small additive
 * fields on it (`iteration_trace`, `evidence_gaps`, both JSON-encoded text
 * server-side; see the handler's #4528 doc comment).
 *
 * RelataDB has no server-side agent loop (ADR-013): this module makes no
 * LLM call and issues no `/rag/query` call of its own — it is pure
 * bookkeeping over results the caller already produced.
 *
 * One structural adaptation from the Python source, required by language
 * shape rather than a deliberate behavior change: Python exposes separate
 * sync (`store_reasoning_trace`) and async (`astore_reasoning_trace`)
 * twins because its `McpClient` has two transports. TypeScript's
 * `McpClient` (`./mcp.ts`) is async-only, so both collapse to the single
 * {@link storeReasoningTrace} here — the same collapse `./rag-loop.ts` and
 * `./rag-understanding.ts` already made.
 */

import type { McpClient } from "./mcp.ts";
import type { FanoutResult, GateDecision, HitGrade, LoopResult } from "./rag-loop.ts";
import type { Citation, SynthesisResult } from "./synthesis.ts";
import { HitGrade as HitGradeValues } from "./rag-loop.ts";

/**
 * One entry per loop iteration in the `iteration_trace` payload sent to
 * `rag_store_answer` — field names are the literal wire keys (snake_case),
 * not the SDK's camelCase convention, since this object is the MCP tool
 * argument map itself, not a TS-only intermediate.
 */
export interface IterationTraceEntry {
  iteration: number;
  query: string;
  /**
   * This iteration's confidence signal — the heuristic gate's score when
   * no grading ran, else corrective grading's `fractionCorrect`. Always a
   * key on the entry (possibly `undefined`), never conditionally omitted —
   * matches {@link LoopIteration.confidence}'s own always-present-but-
   * possibly-undefined shape.
   */
  confidence: number | undefined;
  hit_count: number;
  gate_decision?: GateDecision;
  gate_score?: number;
  fraction_correct?: number;
  graded_hit_count?: number;
}

/** A discarded hit from a corrective-grading round. */
export interface CorrectiveGradingGap {
  iteration: number;
  chunk_id: string;
  grade: HitGrade;
  reason: "corrective_grading";
}

/** A #4526 fan-out strategy excluded as noise below `LOW_CONFIDENCE_FLOOR`. */
export interface FanoutExclusionGap {
  strategy: string;
  confidence: number;
  reason: "fanout_low_confidence";
}

/** One entry in the `evidence_gaps` payload — see {@link evidenceGapsFor}. */
export type EvidenceGap = CorrectiveGradingGap | FanoutExclusionGap;

/** One entry in the `sources` payload sent to `rag_store_answer`. */
export interface SourceEntry {
  id: string;
  source: string;
  score: number;
  page: number;
  /** Wire key is literally `sectionPath` (camelCase) — matches the
   * `rag_store_answer` handler's source-row field, not this module's own
   * snake_case convention for the rest of the payload. */
  sectionPath: string[];
}

/**
 * One entry per loop iteration: query text, this iteration's confidence
 * signal ({@link LoopIteration.confidence} — the heuristic gate's score
 * when no grading ran, else corrective grading's `fractionCorrect`), and,
 * when available, the raw gate/grading signals behind it. This is #4528's
 * "per-iteration confidence" acceptance criterion.
 */
function iterationTraceFor(loopResult: LoopResult): IterationTraceEntry[] {
  const trace: IterationTraceEntry[] = [];
  loopResult.iterations.forEach((iteration, i) => {
    const entry: IterationTraceEntry = {
      iteration: i,
      query: iteration.query,
      confidence: iteration.confidence,
      hit_count: iteration.response.hits.length,
    };
    if (iteration.gate !== undefined) {
      entry.gate_decision = iteration.gate.decision;
      entry.gate_score = iteration.gate.score;
    }
    if (iteration.grading !== undefined) {
      entry.fraction_correct = iteration.grading.fractionCorrect;
      entry.graded_hit_count = iteration.grading.grades.length;
    }
    trace.push(entry);
  });
  return trace;
}

/**
 * Discarded evidence: hits corrective retrieval grading marked
 * ambiguous/incorrect in any iteration, plus — when a #4526 sub-agent
 * fan-out ran — every strategy it excluded as noise below
 * `LOW_CONFIDENCE_FLOOR`. This is #4528's "discarded evidence" acceptance
 * criterion; it stays empty (not absent — an empty array, same as a loop
 * with nothing to discard) when neither source has anything.
 */
function evidenceGapsFor(
  loopResult: LoopResult,
  fanoutResult: FanoutResult | undefined,
): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  loopResult.iterations.forEach((iteration, i) => {
    if (iteration.grading === undefined) return;
    const hits = iteration.response.hits;
    const grades = iteration.grading.grades;
    const n = Math.min(hits.length, grades.length);
    for (let j = 0; j < n; j++) {
      const hit = hits[j]!;
      const grade = grades[j]!;
      if (grade !== HitGradeValues.CORRECT) {
        gaps.push({
          iteration: i,
          chunk_id: hit.chunk_id,
          grade,
          reason: "corrective_grading",
        });
      }
    }
  });
  if (fanoutResult !== undefined) {
    for (const excluded of fanoutResult.excluded) {
      gaps.push({
        strategy: excluded.strategy.name,
        confidence: excluded.confidence,
        reason: "fanout_low_confidence",
      });
    }
  }
  return gaps;
}

/**
 * The loop's final confidence signal — the last iteration's
 * {@link LoopIteration.confidence}, or `0.0` for the degenerate case of a
 * loop result with no iterations recorded.
 */
function finalConfidenceFor(loopResult: LoopResult): number {
  if (loopResult.iterations.length > 0) {
    const confidence = loopResult.iterations[loopResult.iterations.length - 1]!.confidence;
    if (confidence !== undefined) return confidence;
  }
  return 0.0;
}

/**
 * `1 - (unsupported sentence count / total)`, matching the
 * `RagAnswer.faithfulness` field's documented 0-1 scale — or the server's
 * own `-1` "not computed" sentinel when there were no sentences to score
 * (see `doc_writes.rs`'s `faith` default).
 */
function faithfulnessScoreFor(synthesisResult: SynthesisResult): number {
  const total = synthesisResult.sentences.length;
  if (total === 0) return -1.0;
  return 1.0 - synthesisResult.unsupportedCount / total;
}

/**
 * Look up `citation.chunkId`'s `relevance_confidence` (#4520) from
 * whichever iteration's hits it came from — searched newest iteration
 * first, since a re-query's hit set is the more relevant provenance for a
 * repeated chunk id. `0.0` when the id is not found in any iteration
 * (should not happen for a citation resolved from a real hit, but this
 * function never throws on it) or the field is unset.
 */
function sourceConfidenceFor(citation: Citation, loopResult: LoopResult): number {
  for (let i = loopResult.iterations.length - 1; i >= 0; i--) {
    const iteration = loopResult.iterations[i]!;
    for (const hit of iteration.response.hits) {
      if (hit.chunk_id === citation.chunkId) {
        return hit.relevance_confidence ?? 0.0;
      }
    }
  }
  return 0.0;
}

/**
 * Build the `rag_store_answer` `sources` array from the synthesis result's
 * deduplicated, by-construction-real citations (#4579) — never from raw
 * LLM output, so a fabricated source cannot reach this payload any more
 * than it can reach {@link SynthesisResult.citations} itself.
 */
function sourcesPayloadFor(
  synthesisResult: SynthesisResult,
  loopResult: LoopResult,
): SourceEntry[] {
  return synthesisResult.citations.map((citation) => ({
    id: citation.chunkId,
    source: citation.reportId,
    score: sourceConfidenceFor(citation, loopResult),
    page: citation.pageStart,
    sectionPath: citation.sectionPath,
  }));
}

/** Options for {@link buildReasoningTrace}/{@link storeReasoningTrace}. */
export interface BuildReasoningTraceOptions {
  /** The #4526 sub-agent fan-out result, when one ran. */
  fanoutResult?: FanoutResult;
  caseId?: string;
  purpose?: string;
  durationMs?: number;
}

/**
 * Build the full `rag_store_answer` argument map from a completed #4525
 * loop + #4579 synthesis result (and, when a #4526 fan-out ran, its
 * {@link FanoutResult}): iteration count, per-iteration confidence,
 * discarded evidence, and final citations — not just the final answer
 * text.
 *
 * Exposed separately from {@link storeReasoningTrace} so a caller can
 * inspect or log the exact payload before it goes over the wire.
 */
export function buildReasoningTrace(
  query: string,
  loopResult: LoopResult,
  synthesisResult: SynthesisResult,
  opts: BuildReasoningTraceOptions = {},
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    question: query,
    answer: synthesisResult.answer,
    confidence: finalConfidenceFor(loopResult),
    num_iterations: loopResult.iterations.length,
    faithfulness: faithfulnessScoreFor(synthesisResult),
    sources: sourcesPayloadFor(synthesisResult, loopResult),
    iteration_trace: iterationTraceFor(loopResult),
    evidence_gaps: evidenceGapsFor(loopResult, opts.fanoutResult),
  };
  // Truthy checks (not merely `!== undefined`) mirror the Python
  // reference's `if case_id:`/`if purpose:` — an empty string is omitted
  // the same as `undefined`. `duration_ms` is the one exception: `0` is a
  // valid duration, so it uses a presence check instead.
  if (opts.caseId) args["case_id"] = opts.caseId;
  if (opts.purpose) args["purpose"] = opts.purpose;
  if (opts.durationMs !== undefined) args["duration_ms"] = opts.durationMs;
  return args;
}

/**
 * Write the full reasoning trace back via the existing `rag_store_answer`
 * MCP tool (`crates/relata-cli/src/serve/mcp/doc_writes.rs`) — the SDK-side
 * half of #4528. Call this at the end of the loop (#4525/#4526's call
 * site, after #4579's `synthesize`), not mocked: the written row carries
 * the real iteration/confidence/evidence trail this specific run produced.
 *
 * Returns the unwrapped MCP result dict — e.g. `{"stored": "RagAnswer",
 * "source_rows": N, "has_iteration_trace": true, "evidence_gap_count": M,
 * ...}`.
 */
export async function storeReasoningTrace(
  mcpClient: McpClient,
  query: string,
  loopResult: LoopResult,
  synthesisResult: SynthesisResult,
  opts: BuildReasoningTraceOptions = {},
): Promise<Record<string, unknown>> {
  const args = buildReasoningTrace(query, loopResult, synthesisResult, opts);
  return mcpClient.callTool("rag_store_answer", args);
}
