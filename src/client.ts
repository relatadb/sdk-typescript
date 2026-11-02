/**
 * RelataClient — the primary entry point for the Relata TypeScript SDK.
 *
 * Handles authentication, request lifecycle, timeout, retry, RFC 7807
 * problem+json error mapping, and `X-Request-ID` propagation. Zero runtime
 * dependencies; uses the platform-native `fetch` API.
 *
 * ```typescript
 * import { createClient } from "@zysec-ai/relata-sdk";
 *
 * const relata = createClient("http://localhost:9090", {
 *   bearerToken: process.env.RELATA_TOKEN,
 *   defaultPurpose: "analytics",
 *   tenant: "org-acme",          // X-Relata-Tenant-Id
 *   maxRetries: 3,               // retry on 502/503/504 + network errors
 * });
 *
 * const result = await relata.query<{ name: string }>(
 *   "SELECT name FROM Person WHERE identity_index_match('+919876543210') LIMIT 5",
 * );
 * console.log(result.rows[0]?.name);
 * ```
 *
 * TypeScript is async-native, so every method returns a `Promise` — there is
 * no separate `AsyncClient` (that is the idiomatic parity with the Python
 * SDK's sync/async split).
 */

import {
  type AuditCountResponse,
  type EventAppendReceipt,
  type EventAppendRequest,
  type AlertSubmitRequest,
  type AlertSubmitReceipt,
  type HealthResponse,
  type IngestDocumentResponse,
  type IngestDocumentTaskStatus,
  type IngestResponse,
  type QueryOptions,
  type QueryResult,
  type ReadyReport,
  type RecallOptions,
  type RecallResponse,
  type RelataClientOptions,
  type RememberOptions,
  type RememberResponse,
  type SearchOptions,
  type SearchResponse,
  type Stats,
  type StatusResponse,
  type VersionInfo,
  type WireAuditCountResponse,
  type WireHealthResponse,
  type WireQueryResponse,
  type WireSearchResponse,
  type WireStatusResponse,
} from "./types.ts";
import {
  assertNotRedirected,
  ClientClosedError,
  mapHttpError,
  httpProblemMetadata,
  NetworkError,
  PurposeError,
  RelataError,
  ResponseTooLargeError,
  TimeoutError,
} from "./errors.ts";
import { type Logger, NoOpLogger, SafeLogger } from "./logger.ts";
import { Namespace } from "./namespace.ts";
import { QueryBuilder } from "./query.ts";
import {
  RETRYABLE_STATUS_CODES,
  isIdempotentMethod,
  DEFAULT_RETRY_BACKOFF_MS,
} from "./_retry.ts";

// ---------------------------------------------------------------------------
// Transport config
// ---------------------------------------------------------------------------

/**
 * @internal
 * Shared HTTP retry policy (retryable status codes, idempotency gate,
 * default backoff) — defined in `_retry.ts` and re-exported here so
 * `TypedClientBase` (`_typed-http.ts`, #2731) can share the exact same
 * policy instead of re-diverging it, without `_typed-http.ts` needing a
 * runtime import from this module (that edge used to close an ESM
 * circular-import cycle through `namespace.ts`/`ingest.ts` — see
 * `_retry.ts`'s module doc and #2879).
 */
export {
  RETRYABLE_STATUS_CODES,
  isIdempotentMethod,
  DEFAULT_RETRY_BACKOFF_MS,
};

// ---------------------------------------------------------------------------
// Multimedia operator builders (#2251)
// ---------------------------------------------------------------------------

// #3211: shared SQL-building guards live in `_sql.ts` so every SQL-building
// module shares one identifier allowlist, one metric allowlist, and one
// string-literal escaper without a runtime circular import.
import { escapeSqlString, injectMatcherHint, sqlLiteral } from "./_sql.ts";
import { readCappedResponseBody } from "./_body.ts";
import { dnsTunnelDetect as runDnsTunnelDetect, type DnsTunnelOptions } from "./dns-tunnel.ts";

/**
 * Percent-encode `s` for safe interpolation into a single URL path segment
 * (#3212). `encodeURIComponent` escapes `/`, `?`, `#`, and `&`, so `../`, `?`,
 * `#`, `&` payloads can neither traverse the path nor smuggle a query
 * parameter. Centralised so every `{id}` path site uses one encoder.
 */
export function pathSegment(s: string): string {
  return encodeURIComponent(s);
}

/**
 * Default response-body cap (#3214): 64 MiB. A (non-streaming) response larger
 * than this rejects with {@link ResponseTooLargeError} instead of being
 * buffered into memory.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Build a bare `SIMILAR_IMAGE(...)` ticket (#2840, PR #2859, #5492). Mirrors
 * the server operator in `relata_query::parser`: `SIMILAR_IMAGE('<media_ref>',
 * THRESHOLD => f, INDEX => '<index>')` (default THRESHOLD=0.9; `INDEX` is
 * omitted from the SQL entirely when not supplied, matching the parser's
 * `Option<String>` for the corpus/index scope). Bare top-level form only —
 * the engine only dispatches it as a bare top-level statement (#5492).
 * @internal
 */
export function buildSimilarImageSql(
  mediaRef: string,
  opts: { threshold?: number; index?: string } = {},
): string {
  const threshold = opts.threshold ?? 0.9;
  let sql = `SIMILAR_IMAGE(${sqlLiteral(mediaRef)}, THRESHOLD => ${threshold}`;
  if (opts.index !== undefined) sql += `, INDEX => ${sqlLiteral(opts.index)}`;
  sql += ")";
  return sql;
}

// ---------------------------------------------------------------------------
// RelataClient
// ---------------------------------------------------------------------------
// RelataClient
// ---------------------------------------------------------------------------

/**
 * HTTP client for the Relata data engine.
 *
 * Create via `new RelataClient(options)` or the convenience factory
 * `createClient(url, options?)`.
 */
export class RelataClient {
  readonly #baseUrl: string;
  readonly #adminBaseUrl: string | undefined;
  /**
   * #3214: mutable (not `readonly`) so {@link close} can zeroize it; never
   * exposed via a public accessor.
   */
  #bearerToken: string | undefined;
  readonly #defaultPurpose: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #tenant: string | undefined;
  readonly #actingAs: string | undefined;
  readonly #delegatedBy: string | undefined;
  readonly #maxRetries: number;
  readonly #retryBackoffMs: number;
  readonly #logger: Logger;
  /** Response-body cap in bytes (#3214). */
  readonly #maxResponseBytes: number;
  /** Set by {@link close}; further requests fail closed (#3214). */
  #destroyed = false;
  /**
   * Caller-pinned static header bag. Each per-request header bag is built by
   * cloning this and overlaying the per-attempt `X-Request-ID`.
   */
  readonly #extraHeaders: Record<string, string>;

  /**
   * Construct a new `RelataClient`.
   *
   * @param options - Either a full `RelataClientOptions` object or a bare URL
   *   string (useful for quick scripts where defaults are fine).
   *
   * @example
   * ```typescript
   * // Full options
   * const relata = new RelataClient({
   *   baseUrl: "http://localhost:9090",
   *   bearerToken: process.env.RELATA_TOKEN,
   *   defaultPurpose: "analytics",
   *   timeoutMs: 30_000,
   *   tenant: "org-acme",
   *   maxRetries: 3,
   * });
   *
   * // Convenience string shorthand
   * const relata = new RelataClient("http://localhost:9090");
   * ```
   */
  constructor(options: RelataClientOptions | string) {
    const opts: RelataClientOptions =
      typeof options === "string" ? { baseUrl: options } : options;

    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#adminBaseUrl = opts.adminBaseUrl?.replace(/\/+$/, "");
    this.#bearerToken = opts.bearerToken;
    this.#defaultPurpose = opts.defaultPurpose;
    this.#timeoutMs = opts.timeoutMs ?? 30000;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#tenant = opts.tenant;
    this.#actingAs = opts.actingAs;
    this.#delegatedBy = opts.delegatedBy;
    this.#maxRetries = opts.maxRetries ?? 0;
    this.#retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.#maxResponseBytes =
      opts.maxResponseBytes !== undefined && opts.maxResponseBytes > 0
        ? opts.maxResponseBytes
        : DEFAULT_MAX_RESPONSE_BYTES;
    // Wrap the caller-supplied logger (or the silent default) in SafeLogger
    // so a buggy custom logger can never take down an SDK-mediated request.
    this.#logger = new SafeLogger(opts.logger ?? new NoOpLogger());

    // Compose the static extra-headers bag: tenant/delegation first, then
    // caller-supplied headers win. Per-attempt X-Request-ID is overlaid in
    // #buildHeaders so each request gets a fresh id unless the caller pinned
    // one in `opts.headers`.
    const extra: Record<string, string> = {};
    if (opts.tenant !== undefined) extra["X-Relata-Tenant-Id"] = opts.tenant;
    if (opts.actingAs !== undefined) extra["X-Acting-As"] = opts.actingAs;
    if (opts.delegatedBy !== undefined) extra["X-Delegated-By"] = opts.delegatedBy;
    if (opts.headers !== undefined) {
      for (const [k, v] of Object.entries(opts.headers)) extra[k] = v;
    }
    this.#extraHeaders = extra;
  }

  // -------------------------------------------------------------------------
  // Public API — data queries
  // -------------------------------------------------------------------------

  /**
   * Execute a SQL query against Relata and return typed rows.
   *
   * Every query **must** have a `purpose` — either supplied here or set as
   * `defaultPurpose` on the client. The server rejects purposeless queries
   * with HTTP 400 (`PurposeError`).
   *
   * The wire shape returned by `POST /v1/query` is normalised so callers always
   * see `rows` as a list of row objects, regardless of whether the server
   * sent the rich `{"data": [...]}` shape or the legacy
   * `{"rows": <int count>}` shape.
   *
   * The SQL dialect extends ANSI SQL with Relata-specific extensions:
   * - `AS OF 'YYYY-MM-DDTHH:MM:SSZ'` — bi-temporal snapshot query
   * - `WITH PROVENANCE` — attach PROV-O provenance to each row
   * - `PATHS_BETWEEN(a, b, max_hops => 4)` — graph path operator
   * - `MATCH_FACE(image_bytes => ...)` — face-recognition operator
   * - `LOOKUP_IDENTITY(...)` — IdentityIndex universal lookup
   * - `HYBRID_SCORE(...)` — combined BM25 + vector similarity
   * - `NETWORK_EXPAND(seed_id => ..., hops => 3)` — network expansion
   *
    * Multi-hop Cypher `MATCH` patterns run on the server's VF3 subgraph
    * matcher, falling back to chained BFS for patterns VF3 cannot handle
    * (e.g. unbounded `*` paths). Pass `options.matcher` (`"vf3"` / `"bfs"`)
    * to force one; `"auto"` (default) lets the server choose (#1189).
    *
    * @typeParam T - Row shape. Defaults to `Record<string, unknown>`.
    * @param sql - The SQL string to execute.
    * @param options - Optional per-call overrides (purpose, timeout, matcher).
    * @returns Typed query result with `rows`, `queryId`, `elapsedMs`,
    *          `rowCount`, `columns`.
   *
   * @throws {PurposeError} No purpose declared or purpose not in PurposeRegistry.
   * @throws {AuthError} Bearer token missing or invalid.
   * @throws {ForbiddenError} Cedar ACL denies access to requested data.
   * @throws {NotFoundError} Requested resource does not exist (HTTP 404).
   * @throws {ConflictError} Version or uniqueness conflict (HTTP 409).
   * @throws {ValidationError} Request body failed validation (HTTP 422).
   * @throws {RateLimitedError} Per-principal cost quota or rate limit exhausted.
   * @throws {BadRequestError} SQL syntax error or invalid query parameter.
   * @throws {ServerError} Server-side error (HTTP 5xx).
   * @throws {TimeoutError} Request exceeded `timeoutMs`.
   * @throws {NetworkError} Network-level failure (DNS, connection refused).
   *
   * @example
   * ```typescript
   * // Untyped
   * const r = await relata.query("SELECT * FROM Person LIMIT 10");
   * r.rows; // Record<string, unknown>[]
   *
    * // Typed
    * interface Person { id: string; name: string; dob: string }
    * const r = await relata.query<Person>(
    *   "SELECT id, name, dob FROM Person LIMIT 10",
    * );
    * r.rows[0]?.name; // string | undefined
    *
    * // GQL (ISO/IEC 39075) — header-selected dialect (#3265)
    * const g = await relata.query(
    *   "MATCH (n:Person) WHERE n.age > 35 RETURN n.name ORDER BY n.age DESC LIMIT 5",
    *   { dialect: "gql" },
    * );
    * ```
    */
  async query<T = Record<string, unknown>>(
    sql: string,
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    const purpose = options?.purpose ?? this.#defaultPurpose;

    // Validate purpose client-side to give a helpful message before hitting the wire.
    if (!purpose) {
      throw new PurposeError(
        undefined,
        "purpose field is required",
      );
    }

    const wire = await this.#post<WireQueryResponse>(
      "/v1/query",
      {
        purpose,
        sql: injectMatcherHint(sql, options?.matcher),
        ...(options?.queryVector !== undefined ? { query_vector: options.queryVector } : {}),
        ...(options?.queryVectorModel !== undefined
          ? { query_vector_model: options.queryVectorModel }
          : {}),
      },
      options?.timeoutMs,
      options?.dialect ? { "x-query-dialect": options.dialect } : undefined,
    );

    // Normalise the wire shape. The server sends either:
    //   {"data": [...rows...], "query_id": "...", "elapsed_ms": N}  (rich)
    //   {"rows": <int count>, "query_id": "...", "elapsed_ms": N}   (legacy)
    // The Python `_normalise_wire_shape` model_validator does the same.
    let rows: unknown[];
    if (Array.isArray(wire.data)) {
      rows = wire.data;
    } else if (Array.isArray(wire.rows)) {
      rows = wire.rows;
    } else {
      rows = [];
    }
    const columns = Array.isArray(wire.columns) ? wire.columns : [];

    return {
      rows: rows as T[],
      queryId: wire.query_id ?? "",
      elapsedMs: wire.elapsed_ms ?? 0,
      ...(wire.processing_time_ms !== undefined ? { processingTimeMs: wire.processing_time_ms } : wire.elapsed_ms !== undefined ? { processingTimeMs: wire.elapsed_ms } : {}),
      rowCount: rows.length,
      columns,
      ...(Object.hasOwn(wire, "next_cursor") ? { nextCursor: wire.next_cursor ?? null } : {}),
      ...(typeof wire.graph_version === "string" ? { graphVersion: wire.graph_version } : {}),
      ...(typeof wire.truncated === "boolean" ? { truncated: wire.truncated } : {}),
      ...(typeof wire.partial === "boolean" ? { partial: wire.partial } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Public API — parameterized queries (#1162)
  // -------------------------------------------------------------------------

  /**
   * Execute a parameterized SQL query. Placeholders `$1`, `$2`, … in `sql`
   * are substituted server-side with the corresponding values from `params`.
   *
   * ```typescript
   * const r = await relata.queryWithParams(
   *   "SELECT * FROM Person WHERE age = $1 AND city = $2",
   *   [25, "Karachi"],
   *   { purpose: "analytics" },
   * );
   * r.rows[0]?.name;
   * ```
   *
   * @typeParam T - Row shape. Defaults to `Record<string, unknown>`.
   * @param sql - SQL string with `$N` positional placeholders.
   * @param params - Values to bind, in order. Null maps to SQL NULL.
   * @param options - Optional per-call overrides (purpose, timeout).
   */
  async queryWithParams<T = Record<string, unknown>>(
    sql: string,
    params: unknown[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>> {
    const purpose = options?.purpose ?? this.#defaultPurpose;
    if (!purpose) {
      throw new PurposeError(undefined, "purpose field is required");
    }
    const wire = await this.#post<WireQueryResponse>(
      "/v1/query",
      { purpose, sql: injectMatcherHint(sql, options?.matcher), params },
      options?.timeoutMs,
    );
    let rows: unknown[];
    if (Array.isArray(wire.data)) {
      rows = wire.data;
    } else if (Array.isArray(wire.rows)) {
      rows = wire.rows;
    } else {
      rows = [];
    }
    const columns = Array.isArray(wire.columns) ? wire.columns : [];
    return {
      rows: rows as T[],
      queryId: wire.query_id ?? "",
      elapsedMs: wire.elapsed_ms ?? 0,
      ...(wire.processing_time_ms !== undefined ? { processingTimeMs: wire.processing_time_ms } : wire.elapsed_ms !== undefined ? { processingTimeMs: wire.elapsed_ms } : {}),
      rowCount: rows.length,
      columns,
      ...(Object.hasOwn(wire, "next_cursor") ? { nextCursor: wire.next_cursor ?? null } : {}),
      ...(typeof wire.graph_version === "string" ? { graphVersion: wire.graph_version } : {}),
      ...(typeof wire.truncated === "boolean" ? { truncated: wire.truncated } : {}),
      ...(typeof wire.partial === "boolean" ? { partial: wire.partial } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Public API — full-text search (#670)
  // -------------------------------------------------------------------------

  /**
   * Full-text search over a governed object type (`POST /v1/search`).
   *
   * By default this is BM25-only — it never touches the vector channel. Pass
   * `metric` and/or `weights` to route through the server's real
   * HYBRID_SEARCH fusion (BM25 + vector reciprocal-rank fusion) instead;
   * either one alone is enough (#2672).
   *
   * ```typescript
   * const results = await relata.search({
   *   query: "alice smith",
   *   type: "Person",
   *   limit: 10,
   *   facets: ["tenant_id"],
   *   highlight: true,
   * });
   * console.log(results.hits[0]?.fields["name"]);
   *
   * // Real hybrid fusion (BM25 + vector RRF) — set metric/weights.
   * const hybrid = await relata.search({
   *   query: "alice smith",
   *   type: "Person",
   *   metric: "cosine",
   *   weights: [0, 0.5, 0.5],
   * });
   * ```
   */
  async search(params: { query: string; type: string } & SearchOptions): Promise<SearchResponse> {
    const body: Record<string, unknown> = {
      query: params.query,
      type: params.type,
      highlight: params.highlight ?? false,
    };
    if (params.limit !== undefined) body["limit"] = params.limit;
    if (params.facets?.length) body["facets"] = params.facets;
    if (params.filters && Object.keys(params.filters).length) body["filters"] = params.filters;
    if (params.matchingStrategy) body["matching_strategy"] = params.matchingStrategy;
    if (params.typoTolerance) {
      const tt = params.typoTolerance;
      const wireTt: Record<string, unknown> = {};
      if (tt.enabled !== undefined) wireTt["enabled"] = tt.enabled;
      if (tt.minWordSize !== undefined) wireTt["min_word_size"] = tt.minWordSize;
      if (tt.disableOnWords !== undefined) wireTt["disable_on_words"] = tt.disableOnWords;
      if (tt.disableOnAttributes !== undefined) {
        wireTt["disable_on_attributes"] = tt.disableOnAttributes;
      }
      body["typo_tolerance"] = wireTt;
    }
    if (params.metric) body["metric"] = params.metric;
    if (params.weights) body["weights"] = params.weights;

    const wire = await this.#post<WireSearchResponse>("/v1/search", body);
    return {
      // #4626: the wire response carries each hit's row under `data` and
      // never sets `object_type` — see `WireSearchResponse`'s doc comment.
      // `h.fields`/`h.object_type` are checked first for back-compat with a
      // non-standard server response using that legacy shape.
      hits: (wire.hits ?? []).map((h) => ({
        id: h.id,
        objectType: h.object_type ?? params.type,
        fields: h.fields ?? h.data ?? {},
        score: h.score,
        highlights: Array.isArray(h.highlights) ? {} : (h.highlights ?? {}),
        highlightSpans: Array.isArray(h.highlights) ? h.highlights : [],
        ...(h.snippet !== undefined ? { snippet: h.snippet } : {}),
        ...(h.definition ? { definition: h.definition } : {}),
      })),
      total: wire.total ?? wire.estimatedTotalHits ?? 0,
      estimatedTotalHits: wire.estimatedTotalHits ?? wire.total ?? 0,
      facets: wire.facets ?? {},
      ...(wire.facetStats ? { facetStats: wire.facetStats } : {}),
      processingTimeMs: wire.processing_time_ms ?? 0,
    };
  }

  /**
   * Federated multi-query search (#967). Runs N queries in one round-trip.
   *
   * ```ts
   * const resp = await client.multiSearch([
   *   { query: "alice", type: "Person", limit: 5 },
   *   { query: "transfer", type: "Transaction", limit: 10 },
   * ]);
   * ```
   */
  async multiSearch(
    queries: { query: string; type: string; limit?: number; matchingStrategy?: string }[],
  ): Promise<{ results: SearchResponse[]; processingTimeMs: number }> {
    // #4626: `multi_search_handler`'s per-query response shape
    // (`crates/relata-cli/src/serve/search.rs`) is `{hits: [{id, score,
    // snippet, data}], estimatedTotalHits, type, query}` — never `{hits,
    // total, facets, processingTimeMs}` (`SearchResponse`'s own shape) — a
    // failed sub-query is instead `{error: string}`. The previous `as
    // SearchResponse[]` cast skipped mapping entirely, so every result's
    // hits kept the wire's `data`/`snippet` fields instead of `SearchHit`'s
    // `fields`/`objectType`, and `total`/`facets`/`processingTimeMs` were
    // always `undefined`.
    interface WireMultiSearchHit {
      id: string;
      score: number;
      snippet?: string;
      data?: Record<string, unknown>;
    }
    interface WireMultiSearchResult {
      hits?: WireMultiSearchHit[];
      estimatedTotalHits?: number;
      type?: string;
      query?: string;
      error?: string;
    }
    const wire = await this.#post<{
      results: WireMultiSearchResult[];
      processing_time_ms: number;
    }>("/v1/search/multi", { queries });
    const results: SearchResponse[] = (wire.results ?? []).map((r) => ({
      hits: (r.hits ?? []).map((h) => ({
        id: h.id,
        objectType: r.type ?? "",
        fields: h.data ?? {},
        score: h.score,
        highlights: {},
        highlightSpans: [],
      })),
      total: r.estimatedTotalHits ?? 0,
      estimatedTotalHits: r.estimatedTotalHits ?? 0,
      facets: {},
      processingTimeMs: wire.processing_time_ms ?? 0,
    }));
    return {
      results,
      processingTimeMs: wire.processing_time_ms ?? 0,
    };
  }


  /**
   * Bind a {@link Namespace} handle to `name` — the search-developer surface
   * over a single object type (the retrieval-market word for which is
   * "namespace" / "index" / "collection"). Mirrors the Python
   * `client.namespace(name)` factory.
   *
   * The returned handle shares this client's transport, auth, tenant, and
   * purpose context — one pool, reused across every namespace.
   */
  namespace(name: string): Namespace {
    return new Namespace(this, name);
  }

  // -------------------------------------------------------------------------
  // Public API — types, ontology, rules, links, identity (#967)
  // -------------------------------------------------------------------------

  /** List all registered object types. */
  async listTypes(): Promise<Record<string, unknown>> {
    return this.#get("/v1/types");
  }

  /**
   * Return type and link names the authenticated principal may read.
   * This names-only context is intended for application-owned query
   * composition; generated SQL must still be sent through {@link query}.
   */
  async querySchema(purpose?: string): Promise<{
    purpose: string;
    object_types: string[];
    link_types: string[];
  }> {
    const params = new URLSearchParams();
    if (purpose ?? this.#defaultPurpose) {
      params.set("purpose", purpose ?? this.#defaultPurpose!);
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.#get(`/v1/query/schema${suffix}`);
  }

  /**
   * Register a custom object type at runtime (`POST /v1/types`). `spec` mirrors
   * the server's full `TypeDef` body (`crates/relata-cli/src/serve/types_routes.rs`):
   *
   * - `description`/`owner` — free-text, not schema-enforced.
   * - `properties` — `{ name, required?, stateMachine?: { initialState, transitions: [{ from, to }] } }[]`.
   * - `computedColumns` — `{ name, kind: "concat" | "static", fields?, separator?, value? }[]`.
   * - `graphTriggers` — `{ linkType, srcField, dstField }[]`: on every ingested row of this
   *   type, materialise a `LinkStore` edge from `srcField`'s value to `dstField`'s value,
   *   typed `linkType` — the mechanism behind automatic graph wiring on ingest.
   * - `bm25Params` — `{ k1, b }`, overrides the full-text scoring preset for this type only.
   * - `force` — required to redefine a `computedColumns` formula or `stateMachine` on a type
   *   that already has rows (otherwise 409); existing rows are never retroactively revalidated.
   *
   * `spec`'s keys are wire-cased (`graph_triggers`, `computed_columns`, `bm25_params`,
   * `src_field`/`dst_field`, `state_machine`, `initial_state`) — pass them exactly as the
   * server expects; this method does not camelCase-translate.
   */
  async registerType(
    name: string,
    spec?: Record<string, unknown> & {
      description?: string;
      owner?: string;
      properties?: Array<{
        name: string;
        required?: boolean;
        state_machine?: { initial_state: string; transitions?: Array<{ from: string; to: string }> };
      }>;
      computed_columns?: Array<{ name: string; kind: "concat" | "static"; fields?: string[]; separator?: string; value?: string }>;
      graph_triggers?: Array<{ link_type: string; src_field: string; dst_field: string }>;
      bm25_params?: { k1: number; b: number };
      force?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    return this.#post("/v1/types", { name, ...spec });
  }

  /** Deregister an empty custom type. Admin token required; types with history or protected data are rejected. */
  async deregisterType(name: string): Promise<Record<string, unknown>> {
    return this.#delete(`/v1/types/${pathSegment(name)}`);
  }

  /** Get type detail (properties, owner, row count). */
  async typeDetail(name: string): Promise<Record<string, unknown>> {
    return this.#get(`/v1/types/${pathSegment(name)}`);
  }

  /** Lifecycle progress of a type (#5724): recent register/alter/deregister outcomes plus derived-index progress. */
  async typeLifecycle(name: string): Promise<Record<string, unknown>> {
    return this.#get(`/v1/types/${pathSegment(name)}/lifecycle`);
  }

  /**
   * Online schema evolution — `PATCH /v1/types/:name/schema` (#1307). `action` is
   * "add_column" | "remove_column" | "rename_column" | "change_type"; `column`
   * is the target column; `newColumn` / `colType` / `optional` apply to the
   * relevant actions (see the engine's `types_routes.rs` for the exact
   * per-action requirements).
   */
  async schemaAlter(
    name: string,
    action: string,
    column: string,
    opts: {
      newColumn?: string;
      colType?: string;
      optional?: boolean;
      /** Compare-and-set against `typeDetail(name).schema_version` (#5724); stale -> 412. */
      expectedSchemaVersion?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { action, column };
    if (opts.newColumn !== undefined) body["new_column"] = opts.newColumn;
    if (opts.colType !== undefined) body["col_type"] = opts.colType;
    if (opts.optional !== undefined) body["optional"] = opts.optional;
    if (opts.expectedSchemaVersion !== undefined)
      body["expected_schema_version"] = opts.expectedSchemaVersion;
    return this.#patch(`/v1/types/${pathSegment(name)}/schema`, body);
  }

  // -------------------------------------------------------------------------
  // Schema-BRANCH CRUD + edge-type registry (#2497).
  //
  // Distinct from `schemaAlter` (online column evolution, #1307/#2476): this
  // surface governs the git-branched ontology — branch off `main`, drop a
  // stale experiment branch, and register/list edge (link) types within a
  // branch. Mirrors the Python client's schema-branch methods.
  // -------------------------------------------------------------------------

  /**
   * Create a schema branch — `POST /v1/schema/branches/:name` with a
   * `{"from": <source>}` body (#2497). The new branch is a copy-on-write
   * child of `fromBranch` (typically `"main"`).
   */
  async createSchemaBranch(
    name: string,
    fromBranch: string,
  ): Promise<Record<string, unknown>> {
    return this.#post(
      `/v1/schema/branches/${encodeURIComponent(name)}`,
      { from: fromBranch },
    );
  }

  /**
   * Delete a schema branch — `DELETE /v1/schema/branches/:name` (#2497).
   * Admin token required server-side.
   */
  async deleteSchemaBranch(name: string): Promise<Record<string, unknown>> {
    return this.#delete(`/v1/schema/branches/${encodeURIComponent(name)}`);
  }

  /**
   * List registered edge (link) types — `GET /v1/types/edges` (#2497).
   * Returns the registry of `(from_type, to_type, label)` triples the
   * planner uses to resolve governed links.
   */
  async listEdgeTypes(): Promise<Record<string, unknown>> {
    return this.#get("/v1/types/edges");
  }

  /** List per-type SmartIngest detector-pack configs — `GET /v1/types/detect-config`. */
  async listTypeDetectConfigs(): Promise<Record<string, unknown>> {
    return this.#get("/v1/types/detect-config");
  }

  /**
   * Configure SmartIngest detector packs for a type (admin token required) —
   * `POST /v1/types/detect-config` with `{type, packs}`. `packs` takes the
   * `RELATA_DETECT_PACKS` grammar (`["all"]`, `["none"]`, `[]`, or pack names).
   */
  async setTypeDetectConfig(
    typeName: string,
    packs: string[],
  ): Promise<Record<string, unknown>> {
    return this.#post("/v1/types/detect-config", { type: typeName, packs });
  }

  /**
   * Register an edge (link) type — `POST /v1/types/edges` with a
   * `{"from_type", "to_type", "label"}` body (#2497). Mirrors the Rust flat
   * client's `register_edge_type`.
   */
  async registerEdgeType(
    fromType: string,
    toType: string,
    label: string,
  ): Promise<Record<string, unknown>> {
    // The server stores the edge label under `relation` (an unknown `label` key is
    // dropped, so the edge is listed with relation ""); `label` is kept for older servers.
    return this.#post("/v1/types/edges", { from_type: fromType, to_type: toType, relation: label, label });
  }

  /** SHACL schema migration — type specs, link types, property constraints. */
  async ontologyMigrate(schema: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#post("/v1/ontology/migrate", schema);
  }

  /** Register identity enrichment rules for SmartIngest. */
  async enrichmentRules(rules: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#post("/v1/ontology/enrichment-rules", rules);
  }

  /** Create a typed governed link (edge) between two objects. */
  async createLink(params: {
    linkName: string;
    sourceId: string;
    sourceType: string;
    targetId: string;
    targetType: string;
  }): Promise<Record<string, unknown>> {
    return this.#post("/v1/links", {
      link_name: params.linkName,
      source_id: params.sourceId,
      source_type: params.sourceType,
      target_id: params.targetId,
      target_type: params.targetType,
    });
  }

  /**
   * Bulk-create up to 5000 edges in one idempotent, durable request
   * (`POST /v1/links/batch`). Edges are keyed by `(linkName, sourceId, targetId)`
   * within the tenant: an existing current edge is reported as
   * `already_present` and never written twice, so retrying after a timeout or
   * crash cannot duplicate. `idempotencyKey` additionally replays the first
   * response; `durability` is `"sync"` (server default when persistent) or
   * `"async"`.
   */
  async createLinks(
    edges: Array<{
      linkName: string;
      sourceId: string;
      sourceType: string;
      targetId: string;
      targetType: string;
      weight?: number;
    }>,
    opts: { idempotencyKey?: string; durability?: "sync" | "async" } = {},
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {};
    if (opts.idempotencyKey !== undefined) headers["Idempotency-Key"] = opts.idempotencyKey;
    if (opts.durability !== undefined) headers["X-Relata-Durability"] = opts.durability;
    return this.#post(
      "/v1/links/batch",
      {
        edges: edges.map((e) => ({
          link_name: e.linkName,
          source_id: e.sourceId,
          source_type: e.sourceType,
          target_id: e.targetId,
          target_type: e.targetType,
          ...(e.weight !== undefined ? { weight: e.weight } : {}),
        })),
      },
      undefined,
      headers,
    );
  }

  /** Close matching current native edges in the caller's tenant; preserves history. */
  async deleteLink(params: { linkName: string; sourceId: string; targetId: string }): Promise<Record<string, unknown>> {
    return this.#send("DELETE", "/v1/links", {
      link_name: params.linkName, source_id: params.sourceId, target_id: params.targetId,
    }, undefined);
  }

  /** List detection rules. */
  async listRules(): Promise<Record<string, unknown>> {
    return this.#get("/v1/rules");
  }

  /**
   * Create a detection rule.
   *
   * `purpose` is mandatory server-side (`POST /v1/rules?purpose=<p>`) — pass it
   * here or set `defaultPurpose` on the client.
   */
  async createRule(
    rule: Record<string, unknown>,
    opts?: { purpose?: string },
  ): Promise<Record<string, unknown>> {
    const purpose = opts?.purpose ?? this.#defaultPurpose;
    if (!purpose) {
      throw new PurposeError(undefined, "purpose field is required");
    }
    return this.#post(`/v1/rules?purpose=${encodeURIComponent(purpose)}`, rule);
  }

  /** Disable (logically delete) a rule. */
  async disableRule(ruleId: string): Promise<Record<string, unknown>> {
    return this.#delete(`/v1/rules/${pathSegment(ruleId)}`);
  }

  /** Snooze a rule for ``durationSecs``. */
  async snoozeRule(ruleId: string, durationSecs: number): Promise<Record<string, unknown>> {
    return this.#post(`/v1/rules/${pathSegment(ruleId)}/snooze`, { duration_secs: durationSecs });
  }

  /**
   * Suppress future matches of the rule for one entity, for `durationSecs`
   * (admin-only; the server answers 400 without a positive `duration_secs`
   * because suppressions expire, #3197). `reason` is recorded with the audit
   * entry; `condition` is an optional informational note.
   */
  async suppressRule(
    ruleId: string,
    entityId: string,
    opts?: { condition?: string; durationSecs?: number; reason?: string },
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { entity_id: entityId };
    if (opts?.condition !== undefined) body["condition"] = opts.condition;
    if (opts?.durationSecs !== undefined) body["duration_secs"] = opts.durationSecs;
    if (opts?.reason !== undefined) body["reason"] = opts.reason;
    return this.#post(`/v1/rules/${pathSegment(ruleId)}/suppress`, body);
  }

  /** Add an exception entry so specific matches are ignored. */
  async addRuleException(ruleId: string, exception: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#post(`/v1/rules/${pathSegment(ruleId)}/exceptions`, exception);
  }

  /** Retrieve tuning state (snoozes, suppressions, exceptions). */
  async getRuleTuning(ruleId: string): Promise<Record<string, unknown>> {
    return this.#get(`/v1/rules/${pathSegment(ruleId)}/tuning`);
  }

  /**
   * Resolve an identity value to all known objects/clusters via SQL.
   *
   * `mode` selects the resolution strategy: `"canonical"` (single best
   * match), `"cluster"` (server default — same as {@link identityCluster}),
   * or `"fuse"` (merge overlapping clusters). Omit to use the server
   * default (`cluster`).
   */
  async resolveIdentity(
    value: string,
    purpose?: string,
    mode?: "canonical" | "cluster" | "fuse",
  ): Promise<Record<string, unknown>> {
    const escaped = escapeSqlString(value);
    const sql =
      mode === undefined
        ? `RESOLVE_IDENTITY('${escaped}')`
        : `RESOLVE_IDENTITY('${escaped}', MODE => '${mode}')`;
    return this.#post("/v1/query", { purpose: purpose ?? "analytics", sql });
  }

  /** Detect identities in free text via SmartIngest. */
  async detectIdentities(text: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `DETECT_IDENTITIES('${escapeSqlString(text)}')`;
    return this.#post("/v1/query", { purpose: purpose ?? "analytics", sql });
  }

  /** Request scoped GDPR erasure. Controller access revocation is not certified cryptographic erasure; inspect receipt_scope and incomplete copy states. */
  async eraseSubject(subject: string, reason?: string): Promise<Record<string, unknown>> {
    const s = escapeSqlString(subject);
    const r = escapeSqlString(reason ?? "gdpr-art17-request");
    const sql = `ERASE SUBJECT '${s}' REASON '${r}' CERTIFY`;
    return this.#post("/v1/query", { purpose: "gdpr-erasure", sql });
  }

  // ── Sessions (#967 Tier 2d) ────────────────────────────

  /**
   * Bulk export all rows of a type (#967 Tier 5c). The type and format are
   * routed through URLSearchParams so a caller-supplied '&', '?', or '#'
   * cannot smuggle extra query params (#3212).
   */
  async exportData(objectType: string, format?: string): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({
      type: objectType,
      format: format ?? "json",
      purpose: "export",
    });
    return this.#get(`/v1/export?${params.toString()}`);
  }

  /** View uncommitted session changes. */
  async sessionDiff(sessionId: string): Promise<Record<string, unknown>> {
    return this.#get(`/v1/sessions/${pathSegment(sessionId)}/diff`);
  }

  /** Commit a session's draft writes. */
  async sessionCommit(sessionId: string): Promise<Record<string, unknown>> {
    return this.#post(`/v1/sessions/${pathSegment(sessionId)}/commit`, {});
  }

  /** Discard uncommitted session changes. */
  async sessionDiscard(sessionId: string): Promise<Record<string, unknown>> {
    return this.#delete(`/v1/sessions/${pathSegment(sessionId)}/draft`);
  }

  // ── Entity merge, dedup & identity (#967) ────────────────────────────────

  /** Resolve an identity to its full cluster of linked identifiers. */
  async identityCluster(value: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `RESOLVE_IDENTITY('${escapeSqlString(value)}', MODE => 'cluster')`;
    return this.#post("/v1/query", { purpose: purpose ?? "analytics", sql });
  }

  /**
   * Predicate: do two identifiers resolve to the same entity? Executes
   * `SAME_IDENTITY('<a>', '<b>')` via `POST /v1/query` and decodes the `match`
   * verdict as a boolean (#2246).
   */
  async sameIdentity(a: string, b: string, purpose?: string): Promise<boolean> {
    const ca = escapeSqlString(a);
    const cb = escapeSqlString(b);
    const sql = `SAME_IDENTITY('${ca}', '${cb}')`;
    const wire = await this.#post<{ data?: Array<Record<string, unknown>> }>(
      "/v1/query",
      { purpose: purpose ?? "analytics", sql },
    );
    return Boolean(Array.isArray(wire.data) && wire.data[0]?.["match"]);
  }

  /** Ontological merge of two identities (#967). */
  async fuseIdentities(idA: string, idB: string, purpose?: string): Promise<Record<string, unknown>> {
    const a = escapeSqlString(idA);
    const b = escapeSqlString(idB);
    const sql = `FUSE_IDENTITIES('${a}', '${b}')`;
    return this.#post("/v1/query", { purpose: purpose ?? "analytics", sql });
  }

  /** Ontological unmerge — inverse of fuseIdentities (#967). */
  async splitIdentities(idA: string, idB: string, purpose?: string): Promise<Record<string, unknown>> {
    const a = escapeSqlString(idA);
    const b = escapeSqlString(idB);
    const sql = `SPLIT_IDENTITIES('${a}', '${b}')`;
    return this.#post("/v1/query", { purpose: purpose ?? "analytics", sql });
  }

  // ── Graph algorithm operators (#967) ─────────────────────────────────────

  async graphDijkstra(objectType: string, fromId: string, toId: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `GRAPH_DIJKSTRA(${sqlLiteral(objectType)}, FROM => ${sqlLiteral(fromId)}, TO => ${sqlLiteral(toId)})`;
    return this.#post("/v1/query", { purpose: purpose ?? "analytics", sql });
  }

  /**
   * Shortest path via the governed `GET /v1/graph/shortest-path` door (#2344).
   * Unlike `graphDijkstra` (a SQL operator), this exposes the HTTP door's
   * `maxHops` ceiling.
   */
  async graphShortestPath(
    fromId: string,
    toId: string,
    opts: { maxHops?: number } = {},
  ): Promise<Record<string, unknown>> {
    const p = new URLSearchParams({ from: fromId, to: toId });
    if (opts.maxHops !== undefined) p.set("max_hops", String(opts.maxHops));
    return this.#get(`/v1/graph/shortest-path?${p.toString()}`);
  }

  /**
   * Breadth-first traversal via the governed `GET /v1/graph/traverse` door.
   * `direction` is "out" | "in" | "both" (server default out).
   */
  async graphTraverse(
    fromId: string,
    opts: { direction?: string; maxDepth?: number; limit?: number } = {},
  ): Promise<Record<string, unknown>> {
    const p = new URLSearchParams({ from: fromId });
    if (opts.direction !== undefined) p.set("direction", opts.direction);
    if (opts.maxDepth !== undefined) p.set("max_depth", String(opts.maxDepth));
    if (opts.limit !== undefined) p.set("limit", String(opts.limit));
    return this.#get(`/v1/graph/traverse?${p.toString()}`);
  }

  async graphPageRank(objectType: string, opts?: { damping?: number; maxIter?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const parts = [`GRAPH_PAGERANK(${sqlLiteral(objectType)}`];
    if (opts?.damping !== undefined) parts.push(`, DAMPING => ${opts.damping}`);
    if (opts?.maxIter !== undefined) parts.push(`, MAX_ITER => ${opts.maxIter}`);
    parts.push(")");
    return this.#post("/v1/query", { purpose: opts?.purpose ?? "analytics", sql: parts.join("") });
  }

  async graphSCC(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/v1/query", { purpose: purpose ?? "analytics", sql: `GRAPH_SCC(${sqlLiteral(objectType)})` });
  }

  async graphCycles(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/v1/query", { purpose: purpose ?? "analytics", sql: `GRAPH_CYCLES(${sqlLiteral(objectType)})` });
  }

  async graphCommunity(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/v1/query", { purpose: purpose ?? "analytics", sql: `GRAPH_COMMUNITY(${sqlLiteral(objectType)})` });
  }

  async graphNodeSimilarity(objectType: string, node: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `GRAPH_NODE_SIMILARITY(${sqlLiteral(objectType)}, NODE => ${sqlLiteral(node)})`;
    return this.#post("/v1/query", { purpose: purpose ?? "analytics", sql });
  }

  /**
   * Link prediction between two nodes (#4615). The engine requires both
   * `FROM =>` and `TO =>` — mirrors `graphDijkstra`'s FROM/TO shape.
   */
  async graphLinkPredict(objectType: string, from: string, to: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `GRAPH_LINK_PREDICT(${sqlLiteral(objectType)}, FROM => ${sqlLiteral(from)}, TO => ${sqlLiteral(to)})`;
    return this.#post("/v1/query", { purpose: purpose ?? "analytics", sql });
  }

  async graphTriangleCount(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/v1/query", { purpose: purpose ?? "analytics", sql: `TRIANGLE_COUNT(${sqlLiteral(objectType)})` });
  }

  // ── Intelligence operators (#967) ────────────────────────────────────────

  async convoyDetect(opts?: { radiusM?: number; timeTolSecs?: number; minPoints?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const parts: string[] = [];
    if (opts?.radiusM !== undefined) parts.push(`RADIUS => ${opts.radiusM}`);
    if (opts?.timeTolSecs !== undefined) parts.push(`TIME_TOL => ${opts.timeTolSecs * 1_000_000_000}`);
    if (opts?.minPoints !== undefined) parts.push(`MIN_POINTS => ${opts.minPoints}`);
    const sql = `CONVOY(${parts.join(", ")})`;
    return this.#post("/v1/query", { purpose: opts?.purpose ?? "analytics", sql });
  }

  /**
   * DNS-tunnelling / exfil-channel detection (#4637). The server operator
   * (`crates/relata-query/src/parser/wireup.rs`) has no entity-scoping
   * capability — it discards any positional argument and only reads the
   * named `MIN_ENTROPY`/`MIN_QUERIES` tunables over the whole `DnsLog`
   * table — so this method takes those, not a misleading `entity` filter.
   */
  async dnsTunnelDetect(opts?: DnsTunnelOptions) {
    const purpose = opts?.purpose ?? "security";
    return runDnsTunnelDetect(
      async (selectedPurpose) => this.querySchema(selectedPurpose),
      (sql, queryOptions) => this.query(sql, queryOptions),
      { ...opts, purpose },
    );
  }

  /**
   * Geofence — flag entities of `targetType` inside/near `fence` (#4635).
   * The server operator hard-requires `TARGET_TYPE`
   * (`crates/relata-query/src/parser.rs`, `"GEOFENCE requires TARGET_TYPE arg"`),
   * so it is a required parameter here rather than an optional `opts` field.
   */
  async geofence(fence: string, targetType: string, opts?: { purpose?: string }): Promise<Record<string, unknown>> {
    const sql = `GEOFENCE(${sqlLiteral(fence)}, TARGET_TYPE => ${sqlLiteral(targetType)})`;
    return this.#post("/v1/query", { purpose: opts?.purpose ?? "analytics", sql });
  }

  // Domain workflows such as vessel-track reconstruction are solution code.
  // Use governed SQL over the package-authored VesselPositionReport schema.

  // ── Multimedia operators (#2251, epic #655 — ADR-030) ───────────────────
  //
  // Biometric / perceptual-hash search via the governed SQL operator door.
  // Both route through `POST /v1/query` so PURPOSE / ACL / cell-masking / tenant
  // isolation apply identically to a hand-written query. The server operators
  // are registered in `relata_query::parser`:
  //  - SIMILAR_IMAGE('<media_ref>', THRESHOLD => f, INDEX => '<corpus>')
  // FACE_SEARCH / MATCH_PDQ were retired from core (#5935).

  /**
   * Near-duplicate/similar-image search against a media reference (#2840,
   * PR #2859).
   *
   * Executes `SIMILAR_IMAGE(...)` through the governed `/v1/query` door.
   *
   * @param mediaRef - Reference media identifier to find near-duplicates of.
   * @param opts - `threshold` (minimum similarity 0–1, default 0.9), `index`
   *   (optional corpus/index scope; omitted from the SQL entirely when not
   *   supplied), `purpose` override.
   *
   * @example
   * ```typescript
   * const r = await relata.similarImage("media-42",
   *   { threshold: 0.6, index: "ncmec", purpose: "investigation" });
   * ```
   */
  async similarImage<T = Record<string, unknown>>(
    mediaRef: string,
    opts?: { threshold?: number; index?: string; purpose?: string },
  ): Promise<QueryResult<T>> {
    const sql = buildSimilarImageSql(mediaRef, opts ?? {});
    const queryOpts: { purpose?: string } = {};
    if (opts?.purpose !== undefined) queryOpts.purpose = opts.purpose;
    return this.query<T>(sql, queryOpts);
  }

  /**
   * Execute a GraphQL query against the governed query path (ADR-220).
   *
   * @param query GraphQL query string.
   * @param variables Optional variables map. `$var` references in `limit` and
   *   `where` are bound server-side (#3260). A referenced variable that is
   *   missing, null, or wrong-typed is a hard server error (raised as
   *   {@link RelataError}) — never silently dropped. String values are bound
   *   as quoted literals, so variable content cannot inject SQL.
   * @param operationName Optional operation name (multi-operation documents).
   * @returns The `data` field — an array of row objects for a query, or the
   *   `__schema` object for an introspection request.
   * @throws {RelataError} if the server returns a non-empty `errors` array.
   */
  async graphql(
    query: string,
    variables?: Record<string, unknown>,
    operationName?: string,
  ): Promise<unknown> {
    const body: Record<string, unknown> = { query };
    if (variables !== undefined) body["variables"] = variables;
    if (operationName !== undefined) body["operationName"] = operationName;
    const wire = await this.#post<{ data?: unknown; errors?: { message?: string }[] }>("/v1/graphql", body);
    if (wire.errors && wire.errors.length > 0) {
      const msg = wire.errors[0]?.message ?? "graphql error";
      throw new RelataError(`graphql: ${msg}`, 200, msg);
    }
    return wire.data;
  }

  // -------------------------------------------------------------------------
  // Public API — Namespace handle (T9 flagship retrieval surface, #1991/#2491)
  // -------------------------------------------------------------------------


  // -------------------------------------------------------------------------
  // Public API — fluent QueryBuilder
  // -------------------------------------------------------------------------

  /**
   * Begin a fluent `QueryBuilder` for the given object type (table).
   *
   * ```typescript
   * const results = await relata
   *   .select("Person")
   *   .purpose("analytics")
   *   .where("name LIKE 'Ahmed%'")
   *   .asOf("2025-01-01T00:00:00Z")
   *   .withProvenance()
   *   .limit(20)
   *   .execute<{ id: string; name: string }>();
   * ```
   *
   * @param type - Ontology object type name (e.g. `"Person"`, `"BankAccount"`).
   */
  select(type: string): QueryBuilder {
    return new QueryBuilder(this, type);
  }

  // -------------------------------------------------------------------------
  // Public API — management endpoints
  // -------------------------------------------------------------------------

  /**
   * Fetch the server health status.
   *
   * Does **not** require authentication or a purpose declaration.
   * Use this for liveness probes.
   *
   * @throws {NetworkError} Server unreachable.
   * @throws {ServerError} Server is unhealthy (HTTP 5xx).
   */
  async health(): Promise<HealthResponse> {
    const wire = await this.#get<WireHealthResponse>("/health");
    return {
      status: wire.status,
      profile: wire.profile,
      nodeId: wire.node_id,
    };
  }

  /**
   * Fetch the server deployment status.
   *
   * Returns the deployment profile, node role, and per-principal query quota.
   *
   * @throws {AuthError} Server requires auth and token is invalid.
   * @throws {NetworkError} Server unreachable.
   */
  async status(): Promise<StatusResponse> {
    const wire = await this.#get<WireStatusResponse>("/v1/system/status");
    return {
      profile: wire.profile,
      role: wire.role,
      queryQuota: wire.query_quota,
    };
  }

  /**
   * Fetch the audit log entry count and tamper-evidence chain validity.
   *
   * A `chainValid: false` result indicates the hash chain may have been
   * tampered with and must be investigated immediately.
   *
   * @throws {AuthError} Token missing or invalid.
   * @throws {NetworkError} Server unreachable.
   */
  async auditCount(): Promise<AuditCountResponse> {
    const wire = await this.#get<WireAuditCountResponse>("/v1/audit/count");
    return {
      entries: wire.entries,
      chainValid: wire.chain_valid,
    };
  }

  /**
   * Return engine-wide counts for health dashboards.
   *
   * Wraps `GET /v1/system/stats`. The shape mirrors the storage-backend contract
   * §9 — `records`, `states`, `snapshotRows`, `logLeaves`, `tokens` — to the
   * extent the server currently distinguishes them. Fields the server does
   * not yet emit come back as `undefined`; the full server payload is on
   * `raw` for forward-compat.
   *
   * @throws {AuthError} Token missing or invalid.
   * @throws {NetworkError} Server unreachable.
   */
  async stats(): Promise<Stats> {
    const wire = await this.#get<WireStatsResponse>("/v1/system/stats");
    return {
      records: numOrUndefined(wire.records),
      states: numOrUndefined(wire.states),
      snapshotRows: numOrUndefined(wire.snapshot_rows),
      logLeaves: numOrUndefined(wire.log_leaves),
      tokens: numOrUndefined(wire.tokens),
      raw: wire as Record<string, unknown>,
    };
  }

  /**
   * Return runtime build-info.
   *
   * Wraps `GET /version`. Useful for migration checks and capability
   * negotiation.
   *
   * @throws {NetworkError} Server unreachable.
   */
  async version(): Promise<VersionInfo> {
    const wire = await this.#get<WireVersionInfo>("/version");
    return {
      version: wire.version,
      commit: wire.commit,
      profile: wire.profile,
      schemaVersion: wire.schema_version,
      features: Array.isArray(wire.features) ? wire.features : [],
    };
  }

  /**
   * Return the 9-condition readiness report.
   *
   * Wraps `GET /health/ready`. Returns `isReady === true` on HTTP 200; on
   * HTTP 503 the SDK raises {@link ServerError} carrying the shed reason.
   *
   * @throws {ServerError} When the server is shedding load (HTTP 503).
   * @throws {NetworkError} Server unreachable.
   */
  async ready(): Promise<ReadyReport> {
    const wire = await this.#get<WireReadyReport>("/health/ready");
    const status = wire.status ?? "ok";
    return {
      isReady: wire.is_ready ?? status.toLowerCase() === "ok",
      status,
      reason: wire.reason,
      detail: wire.detail,
    };
  }

  /**
   * Queue a prepared document batch through the generic mixed-type HTTP
   * contract. Extractors and document mapping belong in application adapters;
   * this helper sends already-prepared governed rows to `/v1/ingest/bulk`.
   *
   * The batch should include its `DocumentSource`, `DocumentChunk` rows and
   * any linked evidence rows, each with `_type` and stable `_pk` identity.
   * The server admits all object types together under one local task
   * receipt and applies normal auth, tenant, purpose, validation and write
   * governance. Queued source payloads remain volatile. Configured local
   * authority records durable intent and confirmed progress; explicit volatile
   * profiles retain RAM-only status. Poll the originating node with the same
   * authenticated tenant. Recovered unfinished work is uncertain and never
   * automatically reingested; local receipts do not certify indexing or replication.
   */
  async ingestDocument(
    objects: Array<Record<string, unknown>>,
    purpose?: string,
  ): Promise<IngestDocumentResponse> {
    const body = {
      objects,
      queued: true,
      ...(purpose ?? this.#defaultPurpose
        ? { purpose: purpose ?? this.#defaultPurpose }
        : {}),
    };
    const wire = await this.#send<WireIngestDocumentResponse>(
      "POST", "/v1/ingest/bulk", body, undefined, undefined, stringifyIngestBody(body),
    );
    const known = new Set(["task_id", "rows_queued", "rows_rejected", "errors", "queue_depth"]);
    const extensions = Object.fromEntries(
      Object.entries(wire).filter(([key]) => !known.has(key)),
    );
    return {
      taskId: wire.task_id ?? "",
      rowsQueued: wire.rows_queued ?? 0,
      rowsRejected: wire.rows_rejected ?? 0,
      errors: Array.isArray(wire.errors) ? wire.errors : [],
      queueDepth: wire.queue_depth ?? 0,
      ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    };
  }

  /**
   * Atomically apply 1..64 create/update/delete operations (`POST /v1/commit`,
   * #5767). All-or-nothing: every `expectedVersion` is checked before anything
   * is written and the bundle is one durable record. A failed precondition
   * throws `PreconditionFailedError` (`currentVersion`, `failedOperation`) and
   * changes nothing; a retry with the same `idempotencyKey` returns the
   * original result (`replayed: true`).
   */
  async commit(
    operations: Array<{
      op: "create" | "update" | "delete";
      type: string;
      id: string;
      expectedVersion?: number;
      data?: Record<string, unknown>;
    }>,
    opts: { idempotencyKey?: string; purpose?: string } = {},
  ): Promise<{
    commitId: string;
    operations: Array<{ op: "create" | "update" | "delete"; type: string; id: string; version: number }>;
    replayed: boolean;
  }> {
    const purpose = opts.purpose ?? this.#defaultPurpose;
    return this.#post("/v1/commit", {
      operations,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(purpose !== undefined ? { purpose } : {}),
    });
  }

  /**
   * Poll generic mixed-type ingest task progress at `/v1/ingest/tasks/:task_id`.
   * Persistent local receipts survive restart; unresolved work becomes uncertain
   * without automatic reingestion. Volatile profiles remain process-local.
   * Inspect receipt_durability/recovered in extensions; counters are confirmed
   * outcomes, not queue acceptance or global index/replica completion.
   */
  async ingestDocumentStatus(taskId: string): Promise<IngestDocumentTaskStatus> {
    const wire = await this.#get<WireIngestDocumentTaskStatus>(
      `/v1/ingest/tasks/${encodeURIComponent(taskId)}`,
    );
    const known = new Set([
      "task_id", "status", "rows_total", "rows_written", "rows_dropped",
      "drop_reasons", "outcome_uncertain", "code", "derived_error", "retryable", "_relata_write_token",
    ]);
    const extensions = Object.fromEntries(
      Object.entries(wire).filter(([key]) => !known.has(key)),
    );
    return {
      taskId: wire.task_id ?? taskId,
      // Preserve partial/failed (and future server states); only absent status
      // falls back for older servers.
      status: wire.status ?? "pending",
      rowsTotal: wire.rows_total ?? 0,
      rowsWritten: wire.rows_written ?? 0,
      rowsDropped: wire.rows_dropped ?? 0,
      dropReasons: Array.isArray(wire.drop_reasons) ? wire.drop_reasons : [],
      ...(wire.outcome_uncertain !== undefined ? { outcomeUncertain: wire.outcome_uncertain } : {}),
      ...(wire.code !== undefined ? { code: wire.code } : {}),
      ...(wire.derived_error !== undefined ? { derivedError: wire.derived_error } : {}),
      ...(wire.retryable !== undefined ? { retryable: wire.retryable } : {}),
      ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
      ...(wire._relata_write_token
        ? {
            writeToken: {
              wallNs: wire._relata_write_token.wall_ns,
              counter: wire._relata_write_token.counter,
            },
          }
        : {}),
    };
  }

  /** Submit an application alert on a single persistent node.
   * Exact retries preserve identity without replaying best-effort notifications.
   */
  async submitAlert(request: AlertSubmitRequest): Promise<AlertSubmitReceipt> {
    const wire = await this.#post<{
      alert_id: string;
      status: "accepted" | "duplicate";
      durability: "local_wal_sync";
    }>("/v1/alerts", { ...request });
    return { alertId: wire.alert_id, status: wire.status, durability: wire.durability };
  }

  /**
   * Append a schema-governed event with an explicit idempotency key.
   * The server returns the original receipt on an exact retry and rejects a
   * key reused with a different payload. Requires local persistent WAL.
   */
  async appendEvent(request: EventAppendRequest): Promise<EventAppendReceipt> {
    const wire = await this.#post<WireEventAppendReceipt>("/v1/ingest/events", { ...request });
    return {
      eventId: wire.event_id,
      objectType: wire.object_type,
      status: wire.status,
      durability: wire.durability,
    };
  }

  // -------------------------------------------------------------------------
  // Public API — ingest + memory verbs (#751)
  // -------------------------------------------------------------------------

  /**
   * Ingest an array of objects into Relata (`POST /v1/ingest?object_type=<T>`).
   *
   * The server requires the target type as the `object_type` query parameter.
   * Pass `opts.objectType`, or omit it when every object carries the same
   * non-empty `_type` (which is then used). Mixed or missing types throw a
   * client-side error naming the problem instead of a bare server 400; use
   * `ingestDocument` for mixed-type batches. The body is a bare JSON array: the
   * server stores a `{"objects": [...]}` envelope as ONE junk row with a single
   * `objects` text column and answers 200. The write is queued: the receipt
   * carries `task_id`, `rows_queued` and `rows_rejected`, not a stored-row count.
   */
  async ingest(
    objects: object[],
    opts: { objectType?: string; purpose?: string } = {},
  ): Promise<IngestResponse> {
    let objectType = opts.objectType;
    if (objectType === undefined) {
      const types = new Set(
        objects.map((o) => (o as Record<string, unknown>)["_type"]),
      );
      const only = types.size === 1 ? [...types][0] : undefined;
      if (typeof only !== "string" || only === "") {
        throw new Error(
          "ingest: pass opts.objectType, or give every object the same non-empty _type " +
            "(use ingestDocument for mixed-type batches)",
        );
      }
      objectType = only;
    }
    const params = new URLSearchParams({ object_type: objectType });
    const purpose = opts.purpose ?? this.#defaultPurpose;
    if (purpose !== undefined) params.set("purpose", purpose);
    return this.#send<IngestResponse>(
      "POST", `/v1/ingest?${params}`, { objects }, undefined, undefined, JSON.stringify(objects),
    );
  }

  /**
   * Stream rows from an async iterable into batched `POST /v1/ingest` calls
   * with backpressure. Memory is O(batchSize), not O(totalRows). Returns the
   * number of input rows in batches whose request returned without throwing.
   * `/v1/ingest` is queued, so this is not a writer-confirmed count. The helper
   * discards batch receipts/task IDs and does not inspect row-level errors in
   * a successful response. Call `IngestClient.bulk` per batch and poll each
   * task when completion or per-row error accounting is required. Stops when
   * a request throws. Python helpers likewise raise on a failed request; Go
   * returns the count from earlier completed calls with the error, excluding
   * the failing batch.
   *
   * ```ts
   * async function* gen() { yield { name: "Alice" }; yield { name: "Bob" }; }
   * const total = await client.ingestIter("Person", "onboarding", gen(), 500);
   * ```
   */
  async ingestIter(
    objectType: string,
    purpose: string,
    source: AsyncIterable<object> | Iterable<object>,
    batchSize = 500,
  ): Promise<number> {
    const iter = Symbol.asyncIterator in source
      ? source as AsyncIterable<object>
      : (async function* () { for (const x of source as Iterable<object>) yield x; })();
    let total = 0;
    let batch: object[] = [];
    for await (const row of iter) {
      batch.push(row);
      if (batch.length >= batchSize) {
        await this.#ingestBatch(objectType, purpose, batch);
        total += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await this.#ingestBatch(objectType, purpose, batch);
      total += batch.length;
    }
    return total;
  }

  /** Send a batch of objects to the ingest endpoint. */
  async #ingestBatch(objectType: string, purpose: string, batch: object[]): Promise<void> {
    const params = new URLSearchParams({ object_type: objectType, purpose });
    await this.#send(
      "POST", `/v1/ingest?${params}`, { objects: batch }, undefined, undefined, JSON.stringify(batch),
    );
  }

  /** Store a memory item (`POST /v1/memory/remember`). */
  async remember(content: string, opts?: RememberOptions): Promise<RememberResponse> {
    return this.#post<RememberResponse>("/v1/memory/remember", { content, ...opts });
  }

  /** Recall memory items matching a query (`POST /v1/memory/recall`). */
  async recall(query: string, opts?: RecallOptions): Promise<RecallResponse> {
    const body: Record<string, unknown> = { q: query };
    if (opts?.session_id !== undefined) body["session_id"] = opts.session_id;
    if (opts?.top_k !== undefined) body["top_k"] = opts.top_k;
    if (opts?.as_of !== undefined) body["as_of"] = opts.as_of;
    if (opts?.purpose !== undefined) body["purpose"] = opts.purpose;
    return this.#post<RecallResponse>("/v1/memory/recall", body);
  }

  /** Delete a memory item (`DELETE /v1/memory/forget/:id`). */
  async forget(id: string): Promise<void> {
    await this.#delete<unknown>(`/v1/memory/forget/${encodeURIComponent(id)}`);
  }

  // -------------------------------------------------------------------------
  // Public accessors — context inherited by typed clients via fromClient()
  // -------------------------------------------------------------------------

  /** Base URL of the Relata server (trailing slash stripped). */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /**
   * Base URL of the loopbound admin control-plane listener, if configured
   * (`adminBaseUrl` constructor option, #2321/ADR-0261). `undefined` when
   * unset — admin/platform-only typed-client methods then fall back to
   * `baseUrl`, unchanged from before this option existed.
   */
  get adminBaseUrl(): string | undefined {
    return this.#adminBaseUrl;
  }

  /**
   * @internal Bearer token, for the SDK's own sub-clients (S3, streaming,
   * pool) to inherit auth. NOT part of the stable public API — the documented
   * `bearerToken` getter was removed in #3214 so the credential is not
   * reachable via a public accessor. Do not depend on this; it may change or
   * disappear without notice.
   */
  get internalBearerToken(): string | undefined {
    return this.#bearerToken;
  }

  /** Configured response-body cap in bytes (#3214). */
  get maxResponseBytes(): number {
    return this.#maxResponseBytes;
  }

  /**
   * Zeroize the bearer token and mark the client closed (#3214). Every
   * subsequent request fails closed with {@link ClientClosedError}. Call this
   * when the client is no longer needed so the credential does not linger in
   * memory. Safe to call more than once; not safe to call concurrently with
   * in-flight requests.
   */
  close(): void {
    this.#bearerToken = undefined;
    this.#destroyed = true;
  }

  /**
   * Configured request timeout in milliseconds (default 30000, #2494).
   * Inherited by typed clients via `fromClient()` (#2731) so they no longer
   * silently default to an unbounded `0`.
   */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * Configured retry ceiling for idempotent verbs on `{502,503,504}` and
   * network errors (default 0 — no retry). Inherited by typed clients via
   * `fromClient()` (#2731).
   */
  get maxRetries(): number {
    return this.#maxRetries;
  }

  /**
   * Base exponential backoff (ms) for the retry loop. Inherited by typed
   * clients via `fromClient()` (#2731).
   */
  get retryBackoffMs(): number {
    return this.#retryBackoffMs;
  }

  /** Default purpose declared on the client, if any. */
  get defaultPurpose(): string | undefined {
    return this.#defaultPurpose;
  }

  /** Tenant / `X-Relata-Tenant-Id` declared on the client, if any. */
  get tenant(): string | undefined {
    return this.#tenant;
  }

  /** `X-Acting-As` delegation principal declared on the client, if any. */
  get actingAs(): string | undefined {
    return this.#actingAs;
  }

  /** `X-Delegated-By` delegation root declared on the client, if any. */
  get delegatedBy(): string | undefined {
    return this.#delegatedBy;
  }

  /** Caller-supplied static header bag (excluding auth / SDK defaults). */
  get extraHeaders(): Record<string, string> {
    return { ...this.#extraHeaders };
  }

  /**
   * @internal
   * Expose the configured `fetch` implementation for sibling clients
   * (streaming, raw bytes). Callers should not depend on this — it exists so
   * the streaming helper can reuse the same fetch override / mock the
   * constructor received.
   */
  get fetchImpl(): typeof globalThis.fetch {
    return this.#fetch;
  }

  // -------------------------------------------------------------------------
  // Internal HTTP helpers
  // ---------------------------------------------------------------------------

  /** @internal */
  async #get<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.#send<T>("GET", path, undefined, timeoutMs);
  }

  /** @internal */
  async #post<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
    callHeaders?: Record<string, string>,
  ): Promise<T> {
    return this.#send<T>("POST", path, body, timeoutMs, callHeaders);
  }

  /** @internal */
  async #patch<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    return this.#send<T>("PATCH", path, body, timeoutMs);
  }

  /** @internal */
  async #delete<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.#send<T>("DELETE", path, undefined, timeoutMs);
  }

  /**
   * Generic request for internal SDK modules (e.g. VectorClient.embed).
   *
   * @internal — not a stable public surface; used by typed sub-clients.
   */
  async request<T = unknown>(
    method: "POST" | "GET" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    return this.#send<T>(method, path, body, timeoutMs);
  }

  /**
   * @internal
   * Core request dispatcher: timeout, retry, X-Request-ID, error mapping.
   *
   * Mirrors the Python `_http._send_with_retry` loop and Go idempotency gate
   * (#2489):
   * - Generate a per-attempt `X-Request-ID` (unless the caller pinned one in
   *   the static header bag).
   * - Retry **idempotent** verbs (`GET`/`HEAD`/`OPTIONS`) on `{502, 503, 504}`
   *   and on network errors, up to `maxRetries`. POST/PUT/PATCH/DELETE are
   *   never retried — a gateway timeout after commit would double-execute
   *   irreversible operations (`sdks/go/relata/client.go::isIdempotent`).
   * - Exponential backoff: `retryBackoffMs * 2^attempt`.
   */
  async #send<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body: Record<string, unknown> | undefined,
    timeoutMs: number | undefined,
    callHeaders?: Record<string, string>,
    serializedBody?: string,
  ): Promise<T> {
    if (this.#destroyed) {
      throw new ClientClosedError();
    }
    const url = `${this.#baseUrl}${path}`;
    const effectiveTimeout = timeoutMs ?? this.#timeoutMs;
    // Does the caller's static header bag already pin X-Request-ID? If so,
    // respect it — only generate a per-attempt UUID when no default exists.
    const hasPinnedRequestId = Object.keys(this.#extraHeaders).some(
      (k) => k.toLowerCase() === "x-request-id",
    );

    const maxAttempts = Math.max(1, this.#maxRetries + 1);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Per-attempt AbortController so a retry gets a fresh timer.
      const controller = new AbortController();
      const timer =
        effectiveTimeout > 0
          ? setTimeout(() => controller.abort(), effectiveTimeout)
          : undefined;
      const signal = controller.signal;

      try {
        const headers = this.#buildHeaders(!hasPinnedRequestId);
        if (callHeaders) {
          for (const [k, v] of Object.entries(callHeaders)) {
            headers[k] = v;
          }
        }
        const init: RequestInit = {
          method,
          headers,
          signal,
          redirect: "manual",
        };
        if (method !== "GET" && body !== undefined) {
          (init as RequestInit & { body: string }).body = serializedBody ?? JSON.stringify(body);
        }
        const response = await this.#fetch(url, init);
        assertNotRedirected(response, url);
        const result = await this.#parseResponse<T>(
          response,
          body?.["purpose"] as string | undefined,
        );
        return result;
      } catch (err) {
        lastError = err;
        // Timeout — never retry (the operation may have side-effects).
        if (this.#isAbortError(err)) {
          this.#logger.warn("request timed out", {
            method,
            path,
            timeoutMs: effectiveTimeout,
          });
          throw new TimeoutError(effectiveTimeout);
        }
        // Already-classified RelataError (any subclass) — retry only on the
        // retryable set AND only for idempotent verbs; otherwise rethrow as-is.
        // POST/PUT/PATCH/DELETE are never retried (#2489): a 502/503/504 after
        // commit risks double-execution of irreversible operations.
        if (err instanceof RelataError) {
          const status = err.statusCode;
          const canRetryStatus =
            isIdempotentMethod(method) && RETRYABLE_STATUS_CODES.has(status);
          if (attempt + 1 < maxAttempts && canRetryStatus) {
            const backoffMs = this.#retryBackoffMs * 2 ** attempt;
            this.#logger.warn("retrying after retryable HTTP status", {
              method,
              path,
              status,
              attempt: attempt + 1,
              maxAttempts,
              backoffMs,
              requestId: err.requestId,
            });
            await this.#sleep(backoffMs);
            continue;
          }
          if (canRetryStatus) {
            this.#logger.error("retries exhausted on retryable HTTP status", {
              method,
              path,
              status,
              maxAttempts,
              requestId: err.requestId,
            });
          }
          throw err;
        }
        // Raw network failure — wrap + retry, but only for idempotent verbs
        // (same double-execution hazard as status-code retries, #2489).
        if (err instanceof Error) {
          const wrapped = new NetworkError(
            `Failed to reach Relata at ${url}: ${err.message}`,
            err,
          );
          lastError = wrapped;
          if (attempt + 1 < maxAttempts && isIdempotentMethod(method)) {
            const backoffMs = this.#retryBackoffMs * 2 ** attempt;
            this.#logger.warn("retrying after network error", {
              method,
              path,
              attempt: attempt + 1,
              maxAttempts,
              backoffMs,
              cause: err.message,
            });
            await this.#sleep(backoffMs);
            continue;
          }
          this.#logger.error("retries exhausted on network error", {
            method,
            path,
            maxAttempts,
            cause: err.message,
          });
          throw wrapped;
        }
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    // Defensive: the loop above always throws on the final attempt. If we
    // ever reach here (no exception in the last iteration), surface it.
    this.#logger.error("retries exhausted without final error", {
      method,
      path,
      maxAttempts,
    });
    throw lastError;
  }

  /** @internal Parse response, map HTTP errors to typed errors. */
  async #parseResponse<T>(
    response: Response,
    purpose: string | undefined,
  ): Promise<T> {
    // Read the body subject to the response cap (#3214) so an oversized body
    // rejects with ResponseTooLargeError instead of exhausting memory.
    const bytes = await this.#readCappedBody(response);
    const text = new TextDecoder().decode(bytes);
    const contentType = response.headers.get("content-type") ?? "";

    // Attempt to parse the body as JSON regardless of status so we can surface
    // the server's error message when present.
    let body: unknown;
    if (
      contentType.includes("application/json") ||
      contentType.includes("application/problem+json")
    ) {
      try { body = text ? JSON.parse(text) : {}; }
      catch (error) {
        if (response.ok) throw error;
        body = { error: text };
      }
    } else {
      // Non-JSON bodies (e.g., plain text errors from reverse proxies)
      body = text ? { error: text } : {};
    }

    if (!response.ok) {
      const err: Record<string, unknown> = body !== null && typeof body === "object" && !Array.isArray(body)
        ? body as Record<string, unknown> : { error: typeof body === "string" ? body : `HTTP ${response.status}` };
      const serverMessage = [err["detail"], err["error"], err["message"]]
        .find((value): value is string => typeof value === "string" && value.length > 0) ?? `HTTP ${response.status}`;
      const metadata = httpProblemMetadata(err, response.headers);
      // #1321: surface the X-RateLimit-* quota headers to the caller.
      const parseRateLimit = (h: string): number | undefined => {
        const v = response.headers.get(h);
        const n = v ? parseInt(v, 10) : NaN;
        return Number.isFinite(n) ? n : undefined;
      };
      const rateLimitLimit = parseRateLimit("X-RateLimit-Limit");
      const rateLimitRemaining = parseRateLimit("X-RateLimit-Remaining");
      const rateLimitReset = parseRateLimit("X-RateLimit-Reset");
      const costUnitsUnknown = (err as Record<string, unknown>)["cost_units"];
      const costUnits =
        typeof costUnitsUnknown === "number" ? costUnitsUnknown : undefined;

      throw mapHttpError(response.status, serverMessage, {
        purpose,
        ...metadata,
        costUnits,
        rateLimitLimit,
        rateLimitRemaining,
        rateLimitReset,
      });
    }

    return body as T;
  }

  /** @internal Build common request headers. */
  #buildHeaders(generateRequestId: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...this.#extraHeaders,
    };
    if (this.#bearerToken !== undefined) {
      headers["Authorization"] = `Bearer ${this.#bearerToken}`;
    }
    if (generateRequestId) {
      // crypto.randomUUID() is available in Node 19+, all modern browsers,
      // Deno, and Bun. Guard for the rare runtime that lacks it.
      headers["X-Request-ID"] =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `relata-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    return headers;
  }

  /** @internal Detect AbortError across runtimes (Node, Deno, Bun, browser). */
  #isAbortError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.name === "AbortError" || err.message.includes("aborted");
  }

  /**
   * @internal Read a response body up to the response cap (#3214). A body
   * larger than `#maxResponseBytes` rejects with {@link ResponseTooLargeError}
   * instead of being buffered into memory.
   */
  async #readCappedBody(response: Response): Promise<Uint8Array> {
    return readCappedResponseBody(response, this.#maxResponseBytes);
  }

  /** @internal Promise-based sleep for the retry backoff. */
  async #sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Wire shapes that are private to the client module
// ---------------------------------------------------------------------------

/** @internal Wire shape for queued `POST /v1/ingest/bulk`. */
interface WireIngestDocumentResponse {
  task_id?: string;
  rows_queued?: number;
  rows_rejected?: number;
  errors?: string[];
  queue_depth?: number;
  /** Additive receipt fields from newer servers. */
  [extra: string]: unknown;
}

/** @internal Wire shape for `GET /v1/ingest/tasks/:task_id`. */
interface WireIngestDocumentTaskStatus {
  task_id?: string;
  status?: string;
  rows_total?: number;
  rows_written?: number;
  rows_dropped?: number;
  drop_reasons?: string[];
  outcome_uncertain?: boolean;
  code?: string;
  derived_error?: string;
  retryable?: boolean;
  _relata_write_token?: { wall_ns: number; counter: number };
}

/** Serialize prepared rows with exact JSON integer tokens for JavaScript bigint values. */
function stringifyIngestBody(value: unknown, ancestors = new Set<object>()): string {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("ingest JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("ingest payload must not contain a cycle");
    ancestors.add(value);
    const result = `[${value.map((item) => item === undefined ? "null" : stringifyIngestBody(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (ancestors.has(object)) throw new TypeError("ingest payload must not contain a cycle");
    ancestors.add(object);
    const fields = Object.entries(object)
      .filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol")
      .map(([key, item]) => `${JSON.stringify(key)}:${stringifyIngestBody(item, ancestors)}`);
    ancestors.delete(object);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError(`unsupported ingest JSON value: ${typeof value}`);
}

/** @internal Wire shape for `POST /v1/ingest/events`. */
interface WireEventAppendReceipt {
  event_id: string;
  object_type: string;
  status: "accepted" | "duplicate";
  durability: "local_wal_sync";
}

/** @internal Wire shape for `GET /version`. */
interface WireVersionInfo {
  version: string;
  commit?: string;
  profile?: string;
  schema_version?: string;
  features?: string[];
}

/** @internal Wire shape for `GET /v1/system/stats`. */
interface WireStatsResponse {
  records?: number;
  states?: number;
  snapshot_rows?: number;
  log_leaves?: number;
  tokens?: number;
  [k: string]: unknown;
}

/** @internal Wire shape for `GET /health/ready`. */
interface WireReadyReport {
  is_ready?: boolean;
  status?: string;
  reason?: string;
  detail?: string;
}

/**
 * @internal
 * Coerce a possibly-undefined / possibly-string wire value to a number or
 * undefined. Used by `stats()` where the server may omit fields.
 */
function numOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
