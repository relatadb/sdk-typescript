/**
 * Thin typed pass-through for `POST /rag/query` (#4523, #4514/ADR-0299).
 *
 * Per ADR-0298, `sdks/python` carries the canonical agentic-RAG
 * implementation (the SDK-side iterative retrieve→evaluate→refine loop);
 * this module stays a thin typed wrapper over the frozen `/rag/query`
 * contract — no client-side agentic loop lives here, not full parity with
 * `sdks/python`'s `relata.rag`.
 *
 * **Frozen contract — do not deviate without re-opening ADR-0299 (#4514):**
 * request fields `query`, `type`, `topK` (default 8, matches
 * `RAG_RETRIEVE_DEFAULT_TOP_K`), `rerank` (default `false`), `searchMode`
 * (`"lexical" | "dense" | "hybrid" | "structural"`, default `"hybrid"` —
 * `"structural"` added by #4542: retrieval via the persisted
 * `DocumentStructureNode` table-of-contents index; the SDK-side multi-hop
 * agentic descent loop over that tree is Python-only, per the same
 * ADR-0298 split as the rest of this module's header note), `embeddingSlot`
 * (`"text" | "summary" | "keyword" | "question"`, default `"text"`),
 * `filters`, `asOf`, `purpose` (required), `expandWindow` (default `false`),
 * `graphHops` (default `0`). The response carries `bm25_score`/
 * `vector_score` separately per hit — never fused into one number
 * client-side.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";
import { PurposeError } from "./errors.ts";

/** Matches `RAG_RETRIEVE_DEFAULT_TOP_K` (crates/relata-query/src/parser.rs:2854). */
export const RAG_DEFAULT_TOP_K = 8;

export type RagSearchMode = "lexical" | "dense" | "hybrid" | "structural";
export type RagEmbeddingSlot = "text" | "summary" | "keyword" | "question";

/** A single `[{field, op, value}]` filter clause (standard `WHERE`-equivalent). */
export interface RagFilter {
  field: string;
  op: string;
  value: unknown;
}

/** Typed `/rag/query` request parameters (#4514's exact table). */
export interface RagQueryOptions {
  /** Object type to search (e.g. `"DocumentChunk"`). */
  type: string;
  /** Max hits (server default 8, `RAG_RETRIEVE_DEFAULT_TOP_K`). */
  topK?: number;
  /** Dispatch to the sidecar cross-encoder. */
  rerank?: boolean;
  /** `"lexical" | "dense" | "hybrid" | "structural"` (default `"hybrid"`). */
  searchMode?: RagSearchMode;
  /** `"text" | "summary" | "keyword" | "question"` (default `"text"`). */
  embeddingSlot?: RagEmbeddingSlot;
  /** Standard `WHERE`-equivalent filter list. */
  filters?: RagFilter[];
  /** Bi-temporal point-in-time query (`undefined`/`null` = latest). */
  asOf?: string | null;
  /** PURPOSE token — required (falls back to the client's `defaultPurpose`). */
  purpose?: string;
  /** Sentence-window expansion via adjacency links. */
  expandWindow?: boolean;
  /** Graph-augmented expansion depth. */
  graphHops?: number;
}

/** A single hit from `POST /rag/query` (#4514's per-hit contract table). */
export interface RagHit {
  /** Lexical (BM25) channel score — always present, never fused away. */
  bm25_score: number;
  /** Dense (vector) channel score — always present, never fused away. */
  vector_score: number;
  /** Sidecar cross-encoder score — present only when `rerank: true` was set. */
  rerank_score: number | null;
  chunk_id: string;
  /** Source document id (expected rename to `document_source_id` post-#4495). */
  report_id: string;
  text: string;
  section_path: string[];
  page_start: number;
  page_end: number;
  prev_chunk_id: string | null;
  next_chunk_id: string | null;
  entity_ids: string[];
  /**
   * Non-LLM per-hit confidence signal (#4520): a pure function of
   * `bm25_score`/`vector_score` channel agreement and entity-overlap
   * fraction — no network or LLM call. `null` for a server that predates
   * #4520; `./rag-rank.ts`'s `defaultRelevance` falls back to the
   * `bm25_score`/`vector_score` average in that case.
   */
  relevance_confidence: number | null;
}

/** Response from `POST /rag/query`. */
export interface RagQueryResponse {
  hits: RagHit[];
}

/** Build the `POST /rag/query` JSON body per #4514's exact table. */
export function buildRagPayload(
  query: string,
  opts: RagQueryOptions,
  effectivePurpose: string,
): Record<string, unknown> {
  if (!query) throw new Error("query is required");
  if (!opts.type) throw new Error("type is required");
  return {
    query,
    type: opts.type,
    top_k: opts.topK ?? RAG_DEFAULT_TOP_K,
    rerank: opts.rerank ?? false,
    search_mode: opts.searchMode ?? "hybrid",
    embedding_slot: opts.embeddingSlot ?? "text",
    filters: opts.filters ?? [],
    as_of: opts.asOf ?? null,
    purpose: effectivePurpose,
    expand_window: opts.expandWindow ?? false,
    graph_hops: opts.graphHops ?? 0,
  };
}

/**
 * Typed `/rag/query` client. Obtain via `RagClient.fromClient(client)` so
 * calls run under the parent client's auth/tenant context and inherit its
 * `defaultPurpose`.
 */
export class RagClient extends TypedClientBase {
  readonly #defaultPurpose: string | undefined;

  constructor(opts: TypedClientCtor, defaultPurpose?: string) {
    super(opts);
    this.#defaultPurpose = defaultPurpose;
  }

  /** Inherit the parent client's auth, tenant, headers, and default purpose. */
  static fromClient(client: RelataClient): RagClient {
    return new RagClient(TypedClientBase.clientToCtor(client), client.defaultPurpose);
  }

  /** Run a governed retrieval via `POST /rag/query` (#4514). */
  async query(query: string, opts: RagQueryOptions): Promise<RagQueryResponse> {
    const purpose = opts.purpose ?? this.#defaultPurpose;
    if (!purpose) {
      throw new PurposeError(
        undefined,
        "ragQuery requires a purpose. Pass `purpose` in the options or set " +
          "`defaultPurpose` on the RelataClient.",
      );
    }
    return this._post<RagQueryResponse>("/rag/query", buildRagPayload(query, opts, purpose));
  }
}
