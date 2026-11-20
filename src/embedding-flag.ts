/**
 * Query-embedding flag on search / RAG / recall results (#5726).
 *
 * Under the server default `RELATA_QUERY_EMBED_POLICY=lenient`, a
 * `HYBRID_SEARCH`, `SIMILAR`, `RAG_RETRIEVE` or agent-memory recall can fall
 * back to lexical search. The server marks every such result with an
 * `embedding` object; this module parses it and warns through the SDK logger
 * when `semantic` is `false`.
 */

import type { Logger } from "./logger.ts";

/** How the query side of a result was embedded (#5726). */
export interface EmbeddingFlag {
  /** `"semantic"`, `"lexical-fallback"` or `"caller-vector"`. */
  mode: "semantic" | "lexical-fallback" | "caller-vector" | string;
  /** `false` when the result is a lexical fallback. */
  semantic: boolean;
  /** Model tag of the query vector, when one exists. */
  model: string | null;
  /** `"no endpoint"`, `"endpoint error"`, `"model mismatch"` or `null`. */
  reason: string | null;
}

/** Parse the wire `embedding` object; `undefined` when absent or malformed. */
export function parseEmbeddingFlag(wire: unknown): EmbeddingFlag | undefined {
  if (wire === null || typeof wire !== "object") return undefined;
  const o = wire as Record<string, unknown>;
  if (typeof o["mode"] !== "string" || typeof o["semantic"] !== "boolean") return undefined;
  return {
    mode: o["mode"],
    semantic: o["semantic"],
    model: typeof o["model"] === "string" ? o["model"] : null,
    reason: typeof o["reason"] === "string" ? o["reason"] : null,
  };
}

/** Log a warning when `flag` says the result is not semantic. */
export function warnIfLexical(flag: EmbeddingFlag | undefined, logger: Logger | undefined): void {
  if (flag === undefined || flag.semantic || logger === undefined) return;
  logger.warn(
    "result is a lexical fallback, not semantic search; set RELATA_EMBED_URL, or " +
      "RELATA_QUERY_EMBED_POLICY=strict to refuse instead",
    { mode: flag.mode, reason: flag.reason, model: flag.model },
  );
}
