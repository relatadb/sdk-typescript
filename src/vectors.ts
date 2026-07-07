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
   * Caller must supply at least one of `queryText` (BM25 leg) or
   * `queryEmbedding` (vector leg, requires `embeddingSlot`). When both are
   * supplied the server fuses via reciprocal rank fusion (ADR-175).
   */
  async hybridSearch(
    objectType: string,
    opts: {
      queryText?: string;
      queryEmbedding?: number[];
      embeddingSlot?: string;
      k?: number;
      purpose?: string;
    } = {},
  ): Promise<VectorRow[]> {
    if (opts.queryText === undefined && opts.queryEmbedding === undefined) {
      throw new Error(
        "hybridSearch requires queryText or queryEmbedding",
      );
    }
    const args: string[] = [
      `from => '${objectType}'`,
      `limit => ${opts.k ?? 10}`,
    ];
    if (opts.queryText !== undefined) {
      args.push(`query_text => '${opts.queryText.replace(/'/g, "''")}'`);
    }
    if (opts.queryEmbedding !== undefined && opts.embeddingSlot !== undefined) {
      const embStr = JSON.stringify(opts.queryEmbedding).replace(/'/g, "''");
      args.push(`query_embedding => '${embStr}'`);
      args.push(`embedding_slot => '${opts.embeddingSlot}'`);
    }
    const sql = `SELECT * FROM HYBRID_SEARCH(${args.join(", ")})`;
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
}
