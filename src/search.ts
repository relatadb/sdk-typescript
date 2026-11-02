/**
 * Typed search client — the retrieval-native surface over the governed
 * `POST /v1/search` typed JSON door (#1983, #2169). Mirrors the Python
 * `relata.search.SearchClient`: no SQL on the client side — the door compiles
 * the typed body to a governed plan (PURPOSE / ACL / cell-masking / tenant
 * isolation apply identically to a hand-written query).
 *
 * ```typescript
 * const results = await relata.search.query({
 *   from: "Document",
 *   text: "fraud pattern",          // → rank_by ["bm25","*","fraud pattern"]
 *   filters: [{ field: "status", op: "eq", value: "open" }],
 *   limit: 20,
 * });
 * ```
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";
import type { QueryResult } from "./types.ts";

/**
 * `rank_by` directive. BM25/text full-text, BM25F per-field weighting
 * (`["field_weight", {field: weight, ...}, text]` — compiles to
 * `MATCH(*, ...)` + `RANK BY FIELD_WEIGHT(...)`, #2676), or vector
 * HYBRID_SEARCH.
 */
export type SearchRankBy =
  | ["bm25" | "text", string, string]
  | ["field_weight", Record<string, number>, string]
  | ["vector", "ann", string];

/** A single filter clause (`op` defaults to `"eq"`). */
export interface SearchFilter {
  field: string;
  op:
    | "eq" | "ne" | "gt" | "gte" | "lt" | "lte"
    | "like" | "ilike" | "in" | "between";
  value: unknown;
}

/** Typed search parameters. `from` is the object type; `text` is BM25 shorthand. */
export interface SearchQuery {
  from: string;
  /** BM25 shorthand — compiles to `rank_by = ["bm25", matchColumn, text]`. */
  text?: string;
  /** Column for the `text` BM25 match (default `"*"` = whole-row). */
  matchColumn?: string;
  /** Explicit ranking directive (overrides `text`). */
  rankBy?: SearchRankBy;
  /** Filter clauses, or an equality dict `{ field: value }`. */
  filters?: SearchFilter[] | Record<string, unknown>;
  /** Max hits (server clamps to [1, 10000]); default 20. */
  limit?: number;
  /** Column projection (default `*`). */
  includeAttributes?: string[];
  /** `"strong"` (default) | `"eventual"`. */
  consistency?: "strong" | "eventual";
  /**
   * Side-output ranking signals per hit, `{ label: expr }` — e.g.
   * `{ bm25_score: "BM25()", snippet: "HIGHLIGHT(bio)" }` — compiled to a
   * trailing `COMPUTE` clause (#1985 T3, #2465). Purely additive: never
   * affects which rows match or their order.
   */
  computeAttributes?: Record<string, string>;
  /**
   * Caller-supplied query embedding for a `["vector","ann",text]` `rankBy`
   * (ADR-0309, #5941). Sent as the top-level `query_vector` field; the server
   * then makes no embedding call.
   */
  queryVector?: number[];
  /** Model tag `queryVector` was produced by; requires `queryVector`. */
  queryVectorModel?: string;
  /** Optional purpose override. */
  purpose?: string;
}

/** Build the server's `JsonSearchRequest` body from the typed params. */
export function buildSearchPayload(q: SearchQuery): Record<string, unknown> {
  const body: Record<string, unknown> = { from: q.from, limit: q.limit ?? 20 };
  const rankBy = q.rankBy ??
    (q.text ? (["bm25", q.matchColumn ?? "*", q.text] as SearchRankBy) : undefined);
  if (rankBy) body["rank_by"] = rankBy;
  if (q.filters) body["filters"] = normaliseFilters(q.filters);
  if (q.includeAttributes) body["include_attributes"] = q.includeAttributes;
  if (q.consistency) body["consistency"] = q.consistency;
  if (q.computeAttributes) body["compute_attributes"] = q.computeAttributes;
  if (q.queryVector !== undefined) {
    if (
      q.queryVector.length === 0 ||
      !q.queryVector.every((x) => typeof x === "number" && Number.isFinite(x))
    ) {
      throw new Error("queryVector must be a non-empty array of finite numbers");
    }
    body["query_vector"] = q.queryVector;
  }
  if (q.queryVectorModel) {
    if (q.queryVector === undefined) {
      throw new Error("queryVectorModel requires queryVector");
    }
    body["query_vector_model"] = q.queryVectorModel;
  }
  if (q.purpose) body["purpose"] = q.purpose;
  return body;
}

function normaliseFilters(
  f: SearchFilter[] | Record<string, unknown>,
): SearchFilter[] {
  if (Array.isArray(f)) return f;
  return Object.entries(f).map(([field, value]) => ({
    field,
    op: "eq" as const,
    value,
  }));
}

/**
 * Map the `/v1/search` wire body onto {@link QueryResult}. The wire `rows` is the
 * hit COUNT (a number) and the row objects arrive under `data`, so passing the
 * body through unchanged left `result.rows` a number rather than an array.
 */
export function normaliseSearchResult<T>(wire: Record<string, unknown>): QueryResult<T> {
  const rows = (Array.isArray(wire["data"])
    ? wire["data"]
    : Array.isArray(wire["rows"])
      ? wire["rows"]
      : []) as T[];
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const processing = num(wire["processing_time_ms"]) ?? num(wire["elapsed_ms"]);
  return {
    rows,
    queryId: typeof wire["query_id"] === "string" ? wire["query_id"] : "",
    elapsedMs: num(wire["elapsed_ms"]) ?? 0,
    ...(processing !== undefined ? { processingTimeMs: processing } : {}),
    rowCount: rows.length,
    columns: Array.isArray(wire["columns"]) ? (wire["columns"] as string[]) : [],
    ...(Object.hasOwn(wire, "next_cursor")
      ? { nextCursor: (wire["next_cursor"] as string | null | undefined) ?? null }
      : {}),
    ...(typeof wire["truncated"] === "boolean" ? { truncated: wire["truncated"] } : {}),
    ...(Array.isArray(wire["provenance"]) ? { provenance: wire["provenance"] } : {}),
  };
}

/**
 * Typed search client. Obtain via `relataClient.search` so calls run under the
 * parent client's auth, tenant, and purpose context.
 */
export class SearchClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): SearchClient {
    return new SearchClient(TypedClientBase.clientToCtor(client));
  }

  /** Run a typed search against `q.from` (an object type). Wraps `POST /v1/search`. */
  async query<T = Record<string, unknown>>(q: SearchQuery): Promise<QueryResult<T>> {
    const wire = await this._post<Record<string, unknown>>("/v1/search", buildSearchPayload(q));
    return normaliseSearchResult<T>(wire);
  }
}
