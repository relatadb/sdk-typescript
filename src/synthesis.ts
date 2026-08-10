/**
 * Citation-injected synthesis + post-synthesis faithfulness scoring —
 * highest-priority SDK ticket in the RAG epic (#4527), ported from the
 * canonical `sdks/python/relata/synthesis.py` reference implementation
 * (#4579 — read that file in full before changing this one).
 *
 * Mechanism (mirrors the toolkit's confirmed-live pattern — **not** the
 * platform system's dead `services/rag/` code, which is never referenced or
 * ported here):
 *
 * 1. **Inline citation injection** — the synthesis LLM call is prompted to
 *    attach a `[chunk_id]` marker to each claim *as it writes it* (not
 *    appended afterward as a separate pass), grounded in the citation-grade
 *    fields `/rag/query` (#4514, ADR-0299) already returns on every
 *    `RagHit`: `chunk_id`, `section_path`, `page_start`/`page_end`. Every
 *    marker in the raw completion is resolved against the actual hit set the
 *    answer was synthesized from — a marker that doesn't match a real
 *    `chunk_id` is stripped and never surfaced as a `Citation`, so a
 *    fabricated citation cannot reach the caller **by construction**.
 * 2. **Post-synthesis faithfulness pass** — a second, independent LLM call
 *    splits the synthesized answer into sentences and entailment-checks each
 *    one against the chunk(s) it cites (or the full retrieved set, for an
 *    uncited sentence). A sentence that fails entailment is marked with
 *    `unsupportedMarker` (default `"[unsupported]"`) rather than silently
 *    returned as fact. This runs **by default** (`faithfulnessCheck: true`),
 *    not as an opt-in.
 *
 * RelataDB has no server-side agent loop (ADR-013) — orchestration,
 * including both LLM calls above, lives in the SDK and is supplied by the
 * caller via `llm`/`faithfulnessLlm`/`entailmentFn`. This module owns only
 * the prompting, citation resolution, sentence splitting, and faithfulness
 * bookkeeping around those calls; it is provider-agnostic by design.
 */

import type { RagHit, RagQueryResponse } from "./rag.ts";

/**
 * A single free-text completion call: prompt in, raw text out. The SDK is
 * intentionally provider-agnostic (ADR-013) — callers wire in
 * OpenAI/Anthropic/local models etc.
 */
export type LlmFn = (prompt: string) => string | Promise<string>;

/**
 * Sentence-level entailment check: `(sentence, evidenceChunkTexts) =>
 * supported`. Defaults to an LLM-backed check built from `llm` (or
 * `faithfulnessLlm` when given) — see `synthesize`.
 */
export type EntailmentFn = (
  sentence: string,
  evidence: string[],
) => boolean | Promise<boolean>;

/** Default marker appended to a sentence that fails the faithfulness check. */
export const DEFAULT_UNSUPPORTED_MARKER = "[unsupported]";

const CITATION_RE = /\[([A-Za-z0-9_\-:.]+)\]/g;

// Good-enough sentence splitter for synthesis output: split on
// sentence-terminal punctuation followed by whitespace and an
// uppercase/digit/citation-marker start. Not a full NLP tokenizer — this
// module never claims linguistic precision, only enough granularity for
// per-claim faithfulness marking.
const SENTENCE_RE = /(?<=[.!?])\s+(?=[A-Z0-9[])/;

/**
 * A citation that traced back to a real retrieved chunk.
 *
 * Only ever constructed from an actual `RagHit` in the response a
 * `synthesize` call was given — never from an unresolved `[marker]` in raw
 * LLM output. This is what makes a fabricated citation impossible by
 * construction (#4527 acceptance criterion).
 */
export interface Citation {
  chunkId: string;
  reportId: string;
  sectionPath: string[];
  pageStart: number;
  pageEnd: number;
}

/** One sentence of the synthesized answer, with its resolved citations and
 * faithfulness verdict. */
export interface SynthesizedSentence {
  /** Rendered sentence, incl. `unsupportedMarker` if flagged. */
  text: string;
  citations: Citation[];
  /** `false` when the post-synthesis faithfulness pass rejected this
   * sentence. */
  supported: boolean;
}

/** Result of `synthesize` — a citation-injected answer plus per-sentence
 * faithfulness verdicts. */
export interface SynthesisResult {
  /** Full rendered answer, unsupported sentences marked. */
  answer: string;
  sentences: SynthesizedSentence[];
  /** Deduplicated citations across the whole answer. */
  citations: Citation[];
  /** Number of sentences that failed entailment. */
  unsupportedCount: number;
  /** `true` when at least one sentence failed the faithfulness pass. */
  hasUnsupportedClaims: boolean;
}

function hitIndex(hits: RagHit[]): Map<string, RagHit> {
  const idx = new Map<string, RagHit>();
  for (const hit of hits) idx.set(hit.chunk_id, hit);
  return idx;
}

/**
 * Build the synthesis LLM prompt: retrieved chunks + inline-citation
 * instructions grounded in #4514's citation-grade fields.
 *
 * Mirrors the toolkit's live pattern — citations are requested *inline*,
 * attached to each claim as the model writes it, not appended afterward as a
 * separate pass.
 */
export function buildSynthesisPrompt(query: string, hits: RagHit[]): string {
  const contextBlocks = hits.map((hit) => {
    const section = hit.section_path.length > 0 ? hit.section_path.join(" > ") : "n/a";
    return `[${hit.chunk_id}] (section ${section}, p.${hit.page_start}-${hit.page_end})\n${hit.text}`;
  });
  const context = contextBlocks.join("\n\n");
  // `hits[0]` types as `RagHit | undefined` under `noUncheckedIndexedAccess`
  // regardless of the `.length` check above — TS doesn't narrow array
  // index access from a separate length comparison.
  const exampleId = hits[0]?.chunk_id ?? "chunk-id";
  return (
    "Answer the question using ONLY the evidence chunks below. Every " +
    "factual claim MUST be immediately followed by the bracketed chunk " +
    "id it came from, e.g. 'RelataDB fuses BM25 and vector retrieval " +
    `natively [${exampleId}]'. Never invent a chunk id that is not ` +
    "listed below. If the evidence does not answer the question, say so " +
    "plainly instead of guessing.\n\n" +
    `Question: ${query}\n\nEvidence:\n${context}\n\nAnswer:`
  );
}

function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed
    .split(SENTENCE_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Rewrite every `[marker]` in `sentence`: a marker matching a real
 * `chunk_id` becomes a resolved `Citation`; anything else is stripped from
 * the visible text so it can never masquerade as one.
 */
function resolveCitationsInSentence(
  sentence: string,
  index: Map<string, RagHit>,
): { text: string; citations: Citation[] } {
  const citations: Citation[] = [];
  const resolved = sentence.replace(CITATION_RE, (_match, token: string) => {
    const hit = index.get(token);
    if (!hit) return "";
    citations.push({
      chunkId: hit.chunk_id,
      reportId: hit.report_id,
      sectionPath: hit.section_path,
      pageStart: hit.page_start,
      pageEnd: hit.page_end,
    });
    return `[${hit.chunk_id}]`;
  });
  const text = resolved.replace(/\s+/g, " ").trim();
  return { text, citations };
}

/**
 * Build an `EntailmentFn` that asks `llm` a yes/no entailment question — the
 * default second LLM call for the faithfulness pass.
 */
function defaultEntailmentFn(llm: LlmFn): EntailmentFn {
  return async (sentence: string, evidence: string[]): Promise<boolean> => {
    if (evidence.length === 0) {
      // Nothing to check the claim against at all: it cannot be entailed by
      // an empty evidence set, so it is unsupported by definition rather
      // than trivially "passing".
      return false;
    }
    const evidenceBlock = evidence.map((e) => `- ${e}`).join("\n\n");
    const prompt =
      "Evidence:\n" +
      `${evidenceBlock}\n\n` +
      `Claim: ${sentence}\n\n` +
      "Does the evidence above support this claim? Answer with a " +
      "single word, YES or NO.";
    const raw = (await llm(prompt)).trim().toLowerCase();
    return raw.startsWith("yes");
  };
}

/** Options for `synthesize`. */
export interface SynthesizeOptions {
  /**
   * Text-completion callable used for the synthesis pass. Called once with
   * the citation-injection prompt built by `buildSynthesisPrompt`.
   */
  llm: LlmFn;
  /**
   * Runs the post-synthesis entailment pass by default — matches the
   * toolkit's live pattern; this is not an opt-in flag (#4527 acceptance
   * criterion). Defaults to `true`.
   */
  faithfulnessCheck?: boolean;
  /**
   * Completion callable for the entailment pass; defaults to `llm` when
   * unset (same model, a different prompt — still a second, independent
   * call per sentence).
   */
  faithfulnessLlm?: LlmFn;
  /**
   * Override the entailment check entirely (e.g. to use a purpose-built
   * classifier instead of an LLM prompt). Takes precedence over
   * `faithfulnessLlm`/`llm` when given.
   */
  entailmentFn?: EntailmentFn;
  /** Suffix appended to a sentence that fails the faithfulness check. */
  unsupportedMarker?: string;
}

/**
 * Synthesize a governed, citation-injected answer from a `/rag/query`
 * response (#4514), then faithfulness-check it (#4527).
 */
export async function synthesize(
  query: string,
  response: RagQueryResponse,
  opts: SynthesizeOptions,
): Promise<SynthesisResult> {
  const {
    llm,
    faithfulnessCheck = true,
    faithfulnessLlm,
    entailmentFn,
    unsupportedMarker = DEFAULT_UNSUPPORTED_MARKER,
  } = opts;

  const hits = response.hits;
  const index = hitIndex(hits);
  const prompt = buildSynthesisPrompt(query, hits);
  const rawAnswer = await llm(prompt);

  const checkFn = entailmentFn ?? defaultEntailmentFn(faithfulnessLlm ?? llm);

  const sentences: SynthesizedSentence[] = [];
  const renderedSentences: string[] = [];
  const seenChunkIds = new Set<string>();
  const dedupedCitations: Citation[] = [];
  let unsupported = 0;

  for (const rawSentence of splitSentences(rawAnswer)) {
    const { text: resolvedText, citations } = resolveCitationsInSentence(rawSentence, index);
    if (!resolvedText) continue;

    let supported = true;
    let text = resolvedText;
    if (faithfulnessCheck) {
      const evidence =
        citations.length > 0
          ? citations.map((c) => index.get(c.chunkId)!.text)
          : hits.map((h) => h.text);
      supported = await checkFn(text, evidence);
      if (!supported) {
        unsupported += 1;
        text = `${text} ${unsupportedMarker}`;
      }
    }

    sentences.push({ text, citations, supported });
    renderedSentences.push(text);
    for (const citation of citations) {
      if (!seenChunkIds.has(citation.chunkId)) {
        seenChunkIds.add(citation.chunkId);
        dedupedCitations.push(citation);
      }
    }
  }

  return {
    answer: renderedSentences.join(" "),
    sentences,
    citations: dedupedCitations,
    unsupportedCount: unsupported,
    hasUnsupportedClaims: unsupported > 0,
  };
}
