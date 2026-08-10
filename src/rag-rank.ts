/**
 * MMR (Maximal Marginal Relevance) diversity selection — RAG epic (#4526),
 * TS/Go parity port of `sdks/python/relata/rag_rank.py` (#4578).
 *
 * Greedy selection maximizing
 * `lambdaMult * relevance - (1 - lambdaMult) * maxSimilarityToSelected`
 * over the candidate set, verified live in the reference retrieval toolkit
 * studied for ADR-0299. Both terms are pure functions of what
 * `POST /rag/query` already returned — RelataDB's wire contract carries
 * per-channel scores (`bm25_score`/`vector_score`, #4514) and the non-LLM
 * `relevance_confidence` signal (#4520), never raw embedding vectors, so
 * `mmrSelect` needs no embedding call, no LLM call, and no network I/O: it
 * is deterministic given its inputs.
 *
 * - Relevance (`defaultRelevance`) defaults to a hit's
 *   `relevance_confidence` when the server provides it, falling back to
 *   the plain average of `bm25_score`/`vector_score` for a server that
 *   predates #4520.
 * - Similarity (`defaultTextSimilarity`) defaults to Jaccard token-set
 *   overlap over each hit's `text` — the one per-hit field that can stand
 *   in for "how similar are these two chunks" without a vector. Callers
 *   with a real embedding function available can pass a smarter
 *   `similarityFn` instead; `mmrSelect` takes both as plain callables so
 *   neither default is load-bearing.
 *
 * lambda is domain-configurable, not a single global constant (#4526's AC
 * #3): `MMR_LAMBDA_BY_PURPOSE` keys the verified reference-toolkit
 * defaults by RelataDB's existing `purpose` governance dimension via
 * `mmrLambdaForPurpose`.
 */

import type { RagHit } from "./rag.ts";

// ---------------------------------------------------------------------------
// Domain-configurable lambda (verified defaults from the reference toolkit)
// ---------------------------------------------------------------------------

/**
 * Purpose-keyed MMR lambda defaults (case-insensitive lookup via
 * `mmrLambdaForPurpose`). Higher lambda weights relevance over diversity —
 * legal/clinical/medical domains want the most-relevant chunks even if
 * similar; code retrieval wants the most diverse set even at some
 * relevance cost.
 */
export const MMR_LAMBDA_BY_PURPOSE: Record<string, number> = {
  legal: 0.7,
  clinical: 0.7,
  medical: 0.7,
  finance: 0.65,
  research: 0.6,
  general: 0.5,
  code: 0.4,
};

/**
 * Fallback lambda for a `purpose` not present in `MMR_LAMBDA_BY_PURPOSE`
 * (including `undefined`/`null`) — the "general" value, an even
 * relevance/diversity split.
 *
 * A literal, not `MMR_LAMBDA_BY_PURPOSE["general"]`: under
 * `noUncheckedIndexedAccess` every indexed lookup on `Record<string,
 * number>` types as `number | undefined`, even for a key the object
 * literal guarantees is present — kept a plain literal to avoid that,
 * must stay in sync with the `general` entry above.
 */
export const DEFAULT_MMR_LAMBDA = 0.5;

/**
 * Return the verified MMR lambda for `purpose` (case-insensitive), or
 * `DEFAULT_MMR_LAMBDA` when `purpose` is `undefined`/`null` or not one of
 * `MMR_LAMBDA_BY_PURPOSE`'s keys.
 */
export function mmrLambdaForPurpose(purpose: string | null | undefined): number {
  if (purpose == null) return DEFAULT_MMR_LAMBDA;
  return MMR_LAMBDA_BY_PURPOSE[purpose.toLowerCase()] ?? DEFAULT_MMR_LAMBDA;
}

// ---------------------------------------------------------------------------
// Pure default relevance/similarity terms
// ---------------------------------------------------------------------------

/** Signature for MMR's relevance term: one score per candidate hit. */
export type RelevanceFn = (hit: RagHit) => number;

/** Signature for MMR's diversity term: similarity between two hits. */
export type SimilarityFn = (a: RagHit, b: RagHit) => number;

const TOKEN_RE = /[a-z0-9]+/g;

/**
 * Pure relevance term: `hit.relevance_confidence` (#4520) when present,
 * otherwise the average of `bm25_score`/`vector_score` (#4514) — always a
 * function of sub-scores already on the hit, never a new call.
 */
export function defaultRelevance(hit: RagHit): number {
  if (hit.relevance_confidence != null) return hit.relevance_confidence;
  return (hit.bm25_score + hit.vector_score) / 2.0;
}

function tokenSet(text: string): Set<string> {
  const matches = text.toLowerCase().match(TOKEN_RE);
  return new Set(matches ?? []);
}

/**
 * Pure diversity term: Jaccard token-set overlap of `a.text`/`b.text`.
 * `0.0` when either hit's `text` has no tokens.
 */
export function defaultTextSimilarity(a: RagHit, b: RagHit): number {
  const tokensA = tokenSet(a.text);
  const tokensB = tokenSet(b.text);
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection++;
  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union;
}

// ---------------------------------------------------------------------------
// Greedy MMR selection
// ---------------------------------------------------------------------------

/** Options for `mmrSelect`. */
export interface MmrSelectOptions {
  /** Relevance/diversity trade-off in `[0.0, 1.0]` (default `DEFAULT_MMR_LAMBDA`). */
  lambdaMult?: number;
  /** Max hits to return (default: all of `hits`, reordered). */
  topN?: number;
  /** Per-hit relevance term (default `defaultRelevance`). */
  relevanceFn?: RelevanceFn;
  /** Pairwise diversity term (default `defaultTextSimilarity`). */
  similarityFn?: SimilarityFn;
}

/**
 * Greedily select from `hits` by Maximal Marginal Relevance.
 *
 * Repeatedly picks the candidate maximizing
 * `lambdaMult * relevanceFn(candidate) - (1 - lambdaMult) *
 * max(similarityFn(candidate, s) for s in alreadySelected)` (`0.0`
 * similarity for the first pick, nothing selected yet) until `topN` hits
 * have been chosen or `hits` is exhausted.
 *
 * A pure function: no LLM call, no embedding call, no network I/O —
 * deterministic given the same `hits`/`relevanceFn`/`similarityFn`. Ties
 * are broken by `hits`' original order (candidates are scanned in that
 * order and only a strictly greater score replaces the current best).
 *
 * @throws if `lambdaMult` is outside `[0.0, 1.0]`.
 */
export function mmrSelect(hits: readonly RagHit[], opts: MmrSelectOptions = {}): RagHit[] {
  const lambdaMult = opts.lambdaMult ?? DEFAULT_MMR_LAMBDA;
  const relevanceFn = opts.relevanceFn ?? defaultRelevance;
  const similarityFn = opts.similarityFn ?? defaultTextSimilarity;

  if (!(lambdaMult >= 0.0 && lambdaMult <= 1.0)) {
    throw new Error(`lambdaMult must be within [0.0, 1.0], got ${lambdaMult}`);
  }

  const pool = hits.slice();
  const limit =
    opts.topN === undefined ? pool.length : Math.max(0, Math.min(opts.topN, pool.length));
  const selectedIdx: number[] = [];
  const available = pool.map((_, i) => i);

  while (available.length > 0 && selectedIdx.length < limit) {
    let bestI: number | null = null;
    let bestScore: number | null = null;
    for (const i of available) {
      const candidate = pool[i]!;
      const relevance = relevanceFn(candidate);
      let maxSim = 0.0;
      for (const j of selectedIdx) {
        const sim = similarityFn(candidate, pool[j]!);
        if (sim > maxSim) maxSim = sim;
      }
      const score = lambdaMult * relevance - (1.0 - lambdaMult) * maxSim;
      if (bestScore === null || score > bestScore) {
        bestScore = score;
        bestI = i;
      }
    }
    selectedIdx.push(bestI as number);
    available.splice(available.indexOf(bestI as number), 1);
  }

  return selectedIdx.map((i) => pool[i]!);
}

/** Options for `mmrSelectForPurpose` — same as `MmrSelectOptions` minus `lambdaMult`. */
export interface MmrSelectForPurposeOptions {
  topN?: number;
  relevanceFn?: RelevanceFn;
  similarityFn?: SimilarityFn;
}

/**
 * `mmrSelect` with `lambdaMult` resolved from `purpose` via
 * `mmrLambdaForPurpose` — the convenience entry point for callers who
 * already have RelataDB's governance `purpose` in hand and want the
 * domain-tuned default rather than picking a lambda themselves.
 */
export function mmrSelectForPurpose(
  hits: readonly RagHit[],
  purpose: string | null | undefined,
  opts: MmrSelectForPurposeOptions = {},
): RagHit[] {
  // Built conditionally, not `topN: opts.topN`: under `exactOptionalPropertyTypes`,
  // an optional field being *present with value `undefined`* is a distinct,
  // disallowed state from the key being *absent* — spreading only when the
  // caller actually supplied a value keeps the key genuinely absent otherwise.
  return mmrSelect(hits, {
    lambdaMult: mmrLambdaForPurpose(purpose),
    ...(opts.topN !== undefined && { topN: opts.topN }),
    ...(opts.relevanceFn !== undefined && { relevanceFn: opts.relevanceFn }),
    ...(opts.similarityFn !== undefined && { similarityFn: opts.similarityFn }),
  });
}
