/**
 * Typed vector / hybrid-search SDK (#88).
 *
 * The server does not expose dedicated `/similar` / `/hybrid_search` HTTP
 * routes today — vector search is reachable via the `HYBRID_SEARCH` and
 * `SIMILAR TO` SQL operators. This module wraps those operators as a typed
 * client surface so a TypeScript caller does not have to hand-build SQL.
 *
 * When (or if) dedicated HTTP routes ship, this module is the natural place
 * to migrate to them; the public API stays stable.
 */

import { RelataClient } from "./client.ts";
import { PurposeError } from "./errors.ts";

/** Row shape returned by vector-search helpers. */
export type VectorRow = Record<string, unknown>;

/**
 * Build a `HYBRID_SEARCH FROM <type> QUERY '<text>' LIMIT <n>` ticket — the
 * **statement** grammar `relata_query::parser` actually accepts (with optional
 * `RERANK` / `METRIC <m>` / `WEIGHTS <g> <b> <v>`). The previous
 * `SELECT * FROM HYBRID_SEARCH(from => …, query_text => …)` TVF shape was
 * never accepted by the server (named args aren't a real grammar).
 *
 * Caller-supplied query embeddings are not supported by the `/query` SQL
 * surface (no vector-literal grammar); the server embeds `queryText`
 * server-side. Exported for unit testing parity with Python/Go.
 */
export function buildHybridSearchSql(
  objectType: string,
  queryText: string,
  opts: {
    k?: number;
    rerank?: boolean;
    metric?: string;
    weights?: [number, number, number];
  } = {},
): string {
  const k = opts.k ?? 10;
  const escaped = queryText.replace(/'/g, "''");
  let sql = `HYBRID_SEARCH FROM ${objectType} QUERY '${escaped}' LIMIT ${k}`;
  if (opts.rerank) sql += " RERANK";
  if (opts.metric) sql += ` METRIC ${opts.metric}`;
  if (opts.weights !== undefined) {
    if (opts.weights.length !== 3) {
      throw new Error("weights must be a 3-tuple [graph, bm25, vector]");
    }
    sql += ` WEIGHTS ${opts.weights[0]} ${opts.weights[1]} ${opts.weights[2]}`;
  }
  return sql;
}

/** Typed vector client — backs onto `RelataClient.query`. */
export class VectorClient {
  readonly #client: RelataClient;

  constructor(client: RelataClient) {
    this.#client = client;
  }

  /** Inherit the parent client (the SQL executes under its auth/tenant). */
  static fromClient(client: RelataClient): VectorClient {
    return new VectorClient(client);
  }

  /** @internal Resolve the effective purpose or throw. */
  #purpose(purpose: string | undefined): string {
    const eff = purpose ?? this.#client.defaultPurpose;
    if (!eff) {
      throw new PurposeError(
        undefined,
        "Vector operations require a purpose. Pass `purpose` to the call " +
          "or set `defaultPurpose` on the RelataClient.",
      );
    }
    return eff;
  }

  /**
   * Pure KNN search over a named embedding slot.
   *
   * Emits
   * `SELECT * FROM <Type> ORDER BY <slot> <=> '[...]' LIMIT k` — the
   * pgvector cosine form the server understands natively. `<=>` is cosine,
   * `<->` is L2, `<#>` is negative inner product; this helper uses cosine
   * because the HNSW index is cosine-trained.
   */
  async knnSearch(
    objectType: string,
    embeddingSlot: string,
    queryEmbedding: number[],
    opts: {
      k?: number;
      efSearch?: number;
      purpose?: string;
    } = {},
  ): Promise<VectorRow[]> {
    const embStr = JSON.stringify(queryEmbedding);
    const sql =
      `SELECT * FROM ${objectType} ` +
      `ORDER BY ${embeddingSlot} <=> '${embStr}' LIMIT ${opts.k ?? 10}`;
    const result = await this.#client.query<VectorRow>(sql, {
      purpose: this.#purpose(opts.purpose),
    });
    return result.rows;
  }

  /**
   * Hybrid BM25 + vector search via the `HYBRID_SEARCH` operator.
   *
   * Executes `HYBRID_SEARCH FROM <type> QUERY '<text>' LIMIT <k>` through the
   * governed `/query` door so PURPOSE / ACL / cell-masking / tenant isolation
   * apply identically to a hand-written query. The server embeds `queryText`
   * server-side; caller-supplied embeddings are **not** accepted by the
   * `/query` SQL surface (no vector-literal grammar — use `embed()` for
   * text→vector instead).
   *
   * @param objectType - Type to search.
   * @param opts.queryText - BM25 + vector query text (required).
   * @param opts.k - Max results (server default 10).
   * @param opts.purpose - Purpose override.
   * @param opts.rerank - Re-score top-K via the sidecar cross-encoder (#611).
   * @param opts.metric - Distance metric for the vector channel (#1330).
   * @param opts.weights - Per-query fusion weights `[graph, bm25, vector]` (#1338).
   */
  async hybridSearch(
    objectType: string,
    opts: {
      queryText: string;
      k?: number;
      purpose?: string;
      rerank?: boolean;
      metric?: string;
      weights?: [number, number, number];
    },
  ): Promise<VectorRow[]> {
    const sql = buildHybridSearchSql(objectType, opts.queryText, opts);
    const result = await this.#client.query<VectorRow>(sql, {
      purpose: this.#purpose(opts.purpose),
    });
    return result.rows;
  }

  /**
   * Multi-vector similarity (`SIMILAR TO`) — ranks by max-pool cosine over
   * every `_emb_*` slot on the reference row (#1013).
   */
  async similarTo(
    objectType: string,
    referenceId: string,
    opts: {
      k?: number;
      purpose?: string;
    } = {},
  ): Promise<VectorRow[]> {
    const escaped = referenceId.replace(/'/g, "''");
    const sql =
      `SELECT * FROM SIMILAR TO ${objectType} ` +
      `WHERE id = '${escaped}' LIMIT ${opts.k ?? 10}`;
    const result = await this.#client.query<VectorRow>(sql, {
      purpose: this.#purpose(opts.purpose),
    });
    return result.rows;
  }

  // ── #1172: direct embedding via /embed ────────────────────────────────────

  /**
   * Embed a single text string via `POST /embed`.
   *
   * Uses the server's built-in CPU lexical embedder when no sidecar is
   * configured, or the GPU sidecar (`RELATA_ACCEL_ENDPOINT`) when set.
   *
   * ```typescript
   * const { embedding, model, dim } = await vectors.embed("Alice Smith");
   * ```
   *
   * @param text - Text to embed.
   * @param opts - Optional model hint passed through to the server.
   * @returns `{ embedding: number[], model: string, dim: number }`
   */
  async embed(
    text: string,
    opts: { model?: string } = {},
  ): Promise<{ embedding: number[]; model: string; dim: number }> {
    return this.#client.request<{ embedding: number[]; model: string; dim: number }>(
      "POST",
      "/embed",
      { text, ...(opts.model !== undefined ? { model: opts.model } : {}) },
    );
  }

  /**
   * Embed multiple texts in one call via `POST /embed/batch`.
   *
   * ```typescript
   * const { embeddings, dim, count } = await vectors.embedBatch(["Alice", "Bob"]);
   * ```
   *
   * @param texts - Array of texts to embed.
   * @param opts - Optional model hint.
   * @returns `{ embeddings: number[][], model: string, dim: number, count: number }`
   */
  async embedBatch(
    texts: string[],
    opts: { model?: string } = {},
  ): Promise<{ embeddings: number[][]; model: string; dim: number; count: number }> {
    return this.#client.request<{
      embeddings: number[][];
      model: string;
      dim: number;
      count: number;
    }>(
      "POST",
      "/embed/batch",
      { texts, ...(opts.model !== undefined ? { model: opts.model } : {}) },
    );
  }

  // ── #2444 (ADR-0276): per-modality data-plane media embed routes ─────────

  /** @internal Shared POST for the four per-modality media-embed routes. */
  async #embedMedia(
    modality: "image" | "face" | "audio" | "video",
    bytesB64: string,
    opts: { model?: string } = {},
  ): Promise<{ embedding: number[]; model: string; dim: number }> {
    return this.#client.request<{ embedding: number[]; model: string; dim: number }>(
      "POST",
      `/embed/${modality}`,
      { bytes_b64: bytesB64, ...(opts.model !== undefined ? { model: opts.model } : {}) },
    );
  }

  /**
   * Embed a single image via `POST /embed/image` (#2444, ADR-0276).
   *
   * Uses the server's configured embedder's sidecar (`RELATA_ACCEL_ENDPOINT`,
   * ADR-177); the request rejects with a 503 when the active embedder does
   * not support media (the built-in CPU lexical default does not).
   *
   * @param bytesB64 - Base64-encoded image bytes.
   * @param opts - Optional model hint passed through to the server.
   * @returns `{ embedding: number[], model: string, dim: number }`
   */
  async embedImage(
    bytesB64: string,
    opts: { model?: string } = {},
  ): Promise<{ embedding: number[]; model: string; dim: number }> {
    return this.#embedMedia("image", bytesB64, opts);
  }

  /**
   * Embed a single face crop via `POST /embed/face` (#2444, ADR-0276).
   *
   * @param bytesB64 - Base64-encoded face-crop bytes.
   * @param opts - Optional model hint.
   * @returns `{ embedding: number[], model: string, dim: number }`
   */
  async embedFace(
    bytesB64: string,
    opts: { model?: string } = {},
  ): Promise<{ embedding: number[]; model: string; dim: number }> {
    return this.#embedMedia("face", bytesB64, opts);
  }

  /**
   * Embed a single audio clip via `POST /embed/audio` (#2444, ADR-0276).
   *
   * @param bytesB64 - Base64-encoded audio bytes.
   * @param opts - Optional model hint.
   * @returns `{ embedding: number[], model: string, dim: number }`
   */
  async embedAudio(
    bytesB64: string,
    opts: { model?: string } = {},
  ): Promise<{ embedding: number[]; model: string; dim: number }> {
    return this.#embedMedia("audio", bytesB64, opts);
  }

  /**
   * Embed a single video clip/keyframe via `POST /embed/video` (#2444, ADR-0276).
   *
   * @param bytesB64 - Base64-encoded video bytes.
   * @param opts - Optional model hint.
   * @returns `{ embedding: number[], model: string, dim: number }`
   */
  async embedVideo(
    bytesB64: string,
    opts: { model?: string } = {},
  ): Promise<{ embedding: number[]; model: string; dim: number }> {
    return this.#embedMedia("video", bytesB64, opts);
  }
}
