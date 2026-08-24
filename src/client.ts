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
  type ClusterNode,
  type DocumentUsageResponse,
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
  type WireClusterNodesResponse,
  type WireErrorResponse,
  type WireHealthResponse,
  type WireQueryResponse,
  type WireSearchResponse,
  type WireStatusResponse,
} from "./types.ts";
import {
  assertNotRedirected,
  ClientClosedError,
  mapHttpError,
  NetworkError,
  PurposeError,
  RelataError,
  ResponseTooLargeError,
  TimeoutError,
} from "./errors.ts";
import { type Logger, NoOpLogger, SafeLogger } from "./logger.ts";
import { Namespace } from "./namespace.ts";
import { QueryBuilder } from "./query.ts";
import { createArrowFlightTransport } from "./flight.ts";
import { createGrpcQueryTransport, type GrpcQueryResult } from "./grpc-query.ts";
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
// Multimedia operator + Arrow Flight builders (#2251, #2253)
// ---------------------------------------------------------------------------

// #3211: shared SQL-building guards live in `_sql.ts` so every SQL-building
// module shares one identifier allowlist, one metric allowlist, and one
// string-literal escaper without a runtime circular import.
import { escapeSqlString, injectMatcherHint, sqlLiteral } from "./_sql.ts";

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
 * Build a `SELECT * FROM FACE_SEARCH(...)` ticket (#2251). Mirrors the server
 * operator in `relata_query::parser`: `FACE_SEARCH('<csv floats>', '<gallery>',
 * K => n, THRESHOLD => f)` (defaults K=10, THRESHOLD=0.7).
 * @internal
 */
export function buildFaceSearchSql(
  galleryId: string,
  embedding: number[] | string,
  opts: { k?: number; threshold?: number } = {},
): string {
  const csv = typeof embedding === "string" ? embedding : embedding.map((x) => Number(x)).join(",");
  const k = opts.k ?? 10;
  const threshold = opts.threshold ?? 0.7;
  return `SELECT * FROM FACE_SEARCH(${sqlLiteral(csv)}, ${sqlLiteral(galleryId)}, K => ${k}, THRESHOLD => ${threshold})`;
}

/**
 * Build a `SELECT * FROM MATCH_PDQ(...)` ticket (#2251). Mirrors
 * `MATCH_PDQ('<hash>', '<corpus>', THRESHOLD => f)` (default 0.9).
 * @internal
 */
export function buildMatchPdqSql(
  corpusId: string,
  queryHash: string,
  threshold = 0.9,
): string {
  return `SELECT * FROM MATCH_PDQ(${sqlLiteral(queryHash)}, ${sqlLiteral(corpusId)}, THRESHOLD => ${threshold})`;
}

/**
 * Build a `SELECT * FROM SIMILAR_IMAGE(...)` ticket (#2840, PR #2859). Mirrors
 * the server operator in `relata_query::parser`: `SIMILAR_IMAGE('<media_ref>',
 * THRESHOLD => f, INDEX => '<index>')` (default THRESHOLD=0.9; `INDEX` is
 * omitted from the SQL entirely when not supplied, matching the parser's
 * `Option<String>` for the corpus/index scope).
 * @internal
 */
export function buildSimilarImageSql(
  mediaRef: string,
  opts: { threshold?: number; index?: string } = {},
): string {
  const threshold = opts.threshold ?? 0.9;
  let sql = `SELECT * FROM SIMILAR_IMAGE(${sqlLiteral(mediaRef)}, THRESHOLD => ${threshold}`;
  if (opts.index !== undefined) sql += `, INDEX => ${sqlLiteral(opts.index)}`;
  sql += ")";
  return sql;
}

/**
 * Assemble an Arrow Flight `do_get` ticket from SQL + optional PURPOSE (#2253).
 *
 * The Flight door (`crates/relata-cli/src/flight_server.rs::do_get`) reads the
 * ticket as raw UTF-8 SQL and extracts the purpose from a leading
 * `PURPOSE '<id>'` SQL comment, defaulting to `"flight_query"` when absent.
 * @internal
 */
export function buildFlightTicket(sql: string, purpose?: string): string {
  if (!purpose) return sql;
  return `/* PURPOSE '${purpose.replace(/'/g, "''")}' */ ${sql}`;
}

/**
 * Resolve the Arrow Flight gRPC endpoint. Defaults to
 * `grpc://<baseUrl host>:8815` (the server's default Flight port,
 * `RELATA_FLIGHT_PORT`). @internal
 */
export function deriveFlightEndpoint(baseUrl: string, flightEndpoint?: string): string {
  if (flightEndpoint) return flightEndpoint;
  try {
    const host = new URL(baseUrl).hostname || "localhost";
    return `grpc://${host}:8815`;
  } catch {
    return "grpc://localhost:8815";
  }
}

/**
 * Resolve the plain gRPC `RelataQuery` service endpoint (#4090). Defaults to
 * `grpc://<baseUrl host>:50051` — the server's default gRPC port
 * (`RELATA_GRPC_PORT`, distinct from the Flight door's 8815).
 * @internal
 */
export function deriveGrpcQueryEndpoint(baseUrl: string, grpcEndpoint?: string): string {
  if (grpcEndpoint) return grpcEndpoint;
  try {
    const host = new URL(baseUrl).hostname || "localhost";
    return `grpc://${host}:50051`;
  } catch {
    return "grpc://localhost:50051";
  }
}

/**
 * Adapter contract for `RelataClient.queryFlight()` (#2253). Performs the
 * Arrow Flight `do_get` RPC against `endpoint` using `ticketSql` (UTF-8 bytes,
 * PURPOSE comment already injected) as the ticket and `bearer` for the
 * `authorization` metadata, returning the decoded columnar result.
 *
 * `headers` (#3213) carries the tenant / acting-as / delegated-by / request-id
 * scope as gRPC metadata so the Flight door resolves the caller's tenant
 * instead of falling back to the default tenant. Transports that pre-date this
 * parameter simply ignore it (a 3-arg function is assignable to this type).
 *
 * Optional since #2492: `queryFlight()` now uses the SDK's built-in first-party
 * {@link createArrowFlightTransport} adapter by default, so most callers never
 * need to supply a `transport`. Pass one only if you operate your own Arrow
 * Flight stack (e.g. a grpc-web client for the browser, or a bespoke Arrow
 * build) and want it driven instead of the built-in gRPC + apache-arrow path.
 */
export type FlightTransport<T = unknown> = (
  endpoint: string,
  ticketSql: string,
  bearer: string | undefined,
  headers?: Record<string, string>,
) => Promise<T>;

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
   * The wire shape returned by `POST /query` is normalised so callers always
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
      "/query",
      { purpose, sql: injectMatcherHint(sql, options?.matcher) },
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
      "/query",
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
    };
  }

  // -------------------------------------------------------------------------
  // Public API — full-text search (#670)
  // -------------------------------------------------------------------------

  /**
   * Full-text search over a governed object type (`POST /search`).
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

    const wire = await this.#post<WireSearchResponse>("/search", body);
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
        highlights: h.highlights ?? {},
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
    }>("/multi-search", { queries });
    const results: SearchResponse[] = (wire.results ?? []).map((r) => ({
      hits: (r.hits ?? []).map((h) => ({
        id: h.id,
        objectType: r.type ?? "",
        fields: h.data ?? {},
        score: h.score,
        highlights: {},
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
    const wire = await this.#post<{ data?: unknown; errors?: { message?: string }[] }>("/graphql", body);
    if (wire.errors && wire.errors.length > 0) {
      const msg = wire.errors[0]?.message ?? "graphql error";
      throw new RelataError(`graphql: ${msg}`, 200, msg);
    }
    return wire.data;
  }

  // -------------------------------------------------------------------------
  // Public API — Namespace handle (T9 flagship retrieval surface, #1991/#2491)
  // -------------------------------------------------------------------------

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
    return this.#get("/types");
  }

  /** Register a custom object type at runtime. */
  async registerType(name: string, spec?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#post("/types", { name, ...spec });
  }

  /** Deregister a custom type. Admin token required. */
  async deregisterType(name: string): Promise<Record<string, unknown>> {
    return this.#delete(`/types/${pathSegment(name)}`);
  }

  /** Get type detail (properties, owner, row count). */
  async typeDetail(name: string): Promise<Record<string, unknown>> {
    return this.#get(`/types/${pathSegment(name)}`);
  }

  /**
   * Online schema evolution — `PATCH /types/:name/schema` (#1307). `action` is
   * "add" | "drop" | "rename" | "retype"; `column` is the target column;
   * `newColumn` / `colType` / `optional` apply to the relevant actions.
   */
  async schemaAlter(
    name: string,
    action: string,
    column: string,
    opts: { newColumn?: string; colType?: string; optional?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { action, column };
    if (opts.newColumn !== undefined) body["new_column"] = opts.newColumn;
    if (opts.colType !== undefined) body["col_type"] = opts.colType;
    if (opts.optional !== undefined) body["optional"] = opts.optional;
    return this.#patch(`/types/${pathSegment(name)}/schema`, body);
  }

  // -------------------------------------------------------------------------
  // Schema-BRANCH CRUD + edge-type registry (#2497).
  //
  // Distinct from `schemaAlter` (online column evolution, #1307/#2476): this
  // surface governs the git-branched ontology — branch off `main`, drop a
  // stale experiment branch, and register/list edge (link) types within a
  // branch. Mirrors the Rust flat client (`crates/relata-sdk-rust/src/http.rs`
  // 2535–2567) and the Python client.
  // -------------------------------------------------------------------------

  /**
   * Create a schema branch — `POST /schema/branches/:name` with a
   * `{"from": <source>}` body (#2497). The new branch is a copy-on-write
   * child of `fromBranch` (typically `"main"`).
   */
  async createSchemaBranch(
    name: string,
    fromBranch: string,
  ): Promise<Record<string, unknown>> {
    return this.#post(
      `/schema/branches/${encodeURIComponent(name)}`,
      { from: fromBranch },
    );
  }

  /**
   * Delete a schema branch — `DELETE /schema/branches/:name` (#2497).
   * Admin token required server-side.
   */
  async deleteSchemaBranch(name: string): Promise<Record<string, unknown>> {
    return this.#delete(`/schema/branches/${encodeURIComponent(name)}`);
  }

  /**
   * List registered edge (link) types — `GET /types/edges` (#2497).
   * Returns the registry of `(from_type, to_type, label)` triples the
   * planner uses to resolve governed links.
   */
  async listEdgeTypes(): Promise<Record<string, unknown>> {
    return this.#get("/types/edges");
  }

  /**
   * Register an edge (link) type — `POST /types/edges` with a
   * `{"from_type", "to_type", "label"}` body (#2497). Mirrors the Rust flat
   * client's `register_edge_type`.
   */
  async registerEdgeType(
    fromType: string,
    toType: string,
    label: string,
  ): Promise<Record<string, unknown>> {
    return this.#post("/types/edges", { from_type: fromType, to_type: toType, label });
  }

  /** SHACL schema migration — type specs, link types, property constraints. */
  async ontologyMigrate(schema: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#post("/ontology/migrate", schema);
  }

  /** Register identity enrichment rules for SmartIngest. */
  async enrichmentRules(rules: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#post("/ontology/enrichment-rules", rules);
  }

  /** List installed modules / extensions. */
  async listModules(): Promise<Record<string, unknown>> {
    return this.#get("/modules");
  }

  /** Create a typed governed link (edge) between two objects. */
  async createLink(params: {
    linkName: string;
    sourceId: string;
    sourceType: string;
    targetId: string;
    targetType: string;
  }): Promise<Record<string, unknown>> {
    return this.#post("/links", {
      link_name: params.linkName,
      source_id: params.sourceId,
      source_type: params.sourceType,
      target_id: params.targetId,
      target_type: params.targetType,
    });
  }

  /** List detection rules. */
  async listRules(): Promise<Record<string, unknown>> {
    return this.#get("/rules");
  }

  /**
   * Create a detection rule.
   *
   * `purpose` is mandatory server-side (`POST /rules?purpose=<p>`) — pass it
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
    return this.#post(`/rules?purpose=${encodeURIComponent(purpose)}`, rule);
  }

  /** Disable (logically delete) a rule. */
  async disableRule(ruleId: string): Promise<Record<string, unknown>> {
    return this.#delete(`/rules/${pathSegment(ruleId)}`);
  }

  /**
   * Import a Sigma rule (YAML string).
   *
   * The server (`POST /rules/sigma?purpose=<p>`) requires `purpose` as a
   * query param and the raw YAML text as the request body — not a JSON
   * envelope.
   */
  async importSigma(
    sigmaYaml: string,
    opts?: { purpose?: string },
  ): Promise<Record<string, unknown>> {
    const purpose = opts?.purpose ?? this.#defaultPurpose;
    if (!purpose) {
      throw new PurposeError(undefined, "purpose field is required");
    }
    return this.#postRaw(
      `/rules/sigma?purpose=${encodeURIComponent(purpose)}`,
      sigmaYaml,
      "application/x-yaml",
    );
  }

  /** Snooze a rule for ``durationSecs``. */
  async snoozeRule(ruleId: string, durationSecs: number): Promise<Record<string, unknown>> {
    return this.#post(`/rules/${pathSegment(ruleId)}/snooze`, { duration_secs: durationSecs });
  }

  /**
   * Permanently suppress future matches of the rule for a specific entity.
   * `condition` is an optional informational note.
   */
  async suppressRule(
    ruleId: string,
    entityId: string,
    opts?: { condition?: string },
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { entity_id: entityId };
    if (opts?.condition !== undefined) body["condition"] = opts.condition;
    return this.#post(`/rules/${pathSegment(ruleId)}/suppress`, body);
  }

  /** Add an exception entry so specific matches are ignored. */
  async addRuleException(ruleId: string, exception: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#post(`/rules/${pathSegment(ruleId)}/exceptions`, exception);
  }

  /** Retrieve tuning state (snoozes, suppressions, exceptions). */
  async getRuleTuning(ruleId: string): Promise<Record<string, unknown>> {
    return this.#get(`/rules/${pathSegment(ruleId)}/tuning`);
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
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  /** Detect identities in free text via SmartIngest. */
  async detectIdentities(text: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `DETECT_IDENTITIES('${escapeSqlString(text)}')`;
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  /** GDPR Art. 17 erasure — irreversible crypto-shred of a subject's data. */
  async eraseSubject(subject: string, reason?: string): Promise<Record<string, unknown>> {
    const s = escapeSqlString(subject);
    const r = escapeSqlString(reason ?? "gdpr-art17-request");
    const sql = `ERASE SUBJECT '${s}' REASON '${r}' CERTIFY`;
    return this.#post("/query", { purpose: "gdpr-erasure", sql });
  }

  // ── SPARQL, sessions & cluster (#967 Tier 2d) ────────────────────────────

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
    return this.#get(`/export?${params.toString()}`);
  }

  /** Register a webhook for push notifications (#967 Tier 5b). */
  async registerWebhook(url: string, eventTypes?: string[]): Promise<Record<string, unknown>> {
    return this.#post("/webhooks", { url, event_types: eventTypes ?? [] });
  }

  /** List registered webhooks. */
  async listWebhooks(): Promise<Record<string, unknown>> {
    return this.#get("/webhooks");
  }

  /** Delete a webhook. */
  async deleteWebhook(id: string): Promise<Record<string, unknown>> {
    return this.#delete(`/webhooks/${pathSegment(id)}`);
  }

  /** Execute a SPARQL query. */
  async sparql(query: string): Promise<Record<string, unknown>> {
    return this.#post("/sparql", { query });
  }

  /** Get cluster topology. */
  async clusterTopology(): Promise<Record<string, unknown>> {
    return this.#get("/cluster/topology");
  }

  /** Trigger a cluster rebalance. */
  async clusterRebalance(): Promise<Record<string, unknown>> {
    return this.#post("/cluster/rebalance", {});
  }

  /** Drain a node for maintenance. */
  async clusterDrain(nodeId: string): Promise<Record<string, unknown>> {
    return this.#post(`/cluster/drain/${pathSegment(nodeId)}`, {});
  }

  /** View uncommitted session changes. */
  async sessionDiff(sessionId: string): Promise<Record<string, unknown>> {
    return this.#get(`/session/${pathSegment(sessionId)}/diff`);
  }

  /** Commit a session's draft writes. */
  async sessionCommit(sessionId: string): Promise<Record<string, unknown>> {
    return this.#post(`/session/${pathSegment(sessionId)}/commit`, {});
  }

  /** Discard uncommitted session changes. */
  async sessionDiscard(sessionId: string): Promise<Record<string, unknown>> {
    return this.#delete(`/session/${pathSegment(sessionId)}/draft`);
  }

  // ── Entity merge, dedup & identity (#967) ────────────────────────────────

  /** Resolve an identity to its full cluster of linked identifiers. */
  async identityCluster(value: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `RESOLVE_IDENTITY('${escapeSqlString(value)}', MODE => 'cluster')`;
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  /**
   * Predicate: do two identifiers resolve to the same entity? Executes
   * `SAME_IDENTITY('<a>', '<b>')` via `POST /query` and decodes the `match`
   * verdict as a boolean (#2246).
   */
  async sameIdentity(a: string, b: string, purpose?: string): Promise<boolean> {
    const ca = escapeSqlString(a);
    const cb = escapeSqlString(b);
    const sql = `SAME_IDENTITY('${ca}', '${cb}')`;
    const wire = await this.#post<{ data?: Array<Record<string, unknown>> }>(
      "/query",
      { purpose: purpose ?? "analytics", sql },
    );
    return Boolean(Array.isArray(wire.data) && wire.data[0]?.["match"]);
  }

  /** Ontological merge of two identities (#967). */
  async fuseIdentities(idA: string, idB: string, purpose?: string): Promise<Record<string, unknown>> {
    const a = escapeSqlString(idA);
    const b = escapeSqlString(idB);
    const sql = `FUSE_IDENTITIES('${a}', '${b}')`;
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  /** Ontological unmerge — inverse of fuseIdentities (#967). */
  async splitIdentities(idA: string, idB: string, purpose?: string): Promise<Record<string, unknown>> {
    const a = escapeSqlString(idA);
    const b = escapeSqlString(idB);
    const sql = `SPLIT_IDENTITIES('${a}', '${b}')`;
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  // ── Graph algorithm operators (#967) ─────────────────────────────────────

  async graphDijkstra(objectType: string, fromId: string, toId: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `GRAPH_DIJKSTRA(${sqlLiteral(objectType)}, FROM => ${sqlLiteral(fromId)}, TO => ${sqlLiteral(toId)})`;
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  /**
   * Shortest path via the governed `GET /graph/shortest-path` door (#2344).
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
    return this.#get(`/graph/shortest-path?${p.toString()}`);
  }

  /**
   * Breadth-first traversal via the governed `GET /graph/traverse` door.
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
    return this.#get(`/graph/traverse?${p.toString()}`);
  }

  async graphPageRank(objectType: string, opts?: { damping?: number; maxIter?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const parts = [`GRAPH_PAGERANK(${sqlLiteral(objectType)}`];
    if (opts?.damping !== undefined) parts.push(`, DAMPING => ${opts.damping}`);
    if (opts?.maxIter !== undefined) parts.push(`, MAX_ITER => ${opts.maxIter}`);
    parts.push(")");
    return this.#post("/query", { purpose: opts?.purpose ?? "analytics", sql: parts.join("") });
  }

  async graphSCC(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `GRAPH_SCC(${sqlLiteral(objectType)})` });
  }

  async graphCycles(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `GRAPH_CYCLES(${sqlLiteral(objectType)})` });
  }

  async graphCommunity(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `GRAPH_COMMUNITY(${sqlLiteral(objectType)})` });
  }

  async graphNodeSimilarity(objectType: string, node: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `GRAPH_NODE_SIMILARITY(${sqlLiteral(objectType)}, NODE => ${sqlLiteral(node)})`;
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  async graphLinkPredict(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `GRAPH_LINK_PREDICT(${sqlLiteral(objectType)})` });
  }

  async graphTriangleCount(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `TRIANGLE_COUNT(${sqlLiteral(objectType)})` });
  }

  // ── Intelligence operators (#967) ────────────────────────────────────────

  async beneficialOwnershipChain(party: string, opts?: { maxDepth?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const parts = [`BENEFICIAL_OWNERSHIP_CHAIN(${sqlLiteral(party)}`];
    if (opts?.maxDepth !== undefined) parts.push(`, MAX_DEPTH => ${opts.maxDepth}`);
    parts.push(")");
    return this.#post("/query", { purpose: opts?.purpose ?? "compliance", sql: parts.join("") });
  }

  async sanctionsScreen(party: string, opts?: { threshold?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const parts = [`SANCTIONS_SCREEN(${sqlLiteral(party)}`];
    if (opts?.threshold !== undefined) parts.push(`, THRESHOLD => ${opts.threshold}`);
    parts.push(")");
    return this.#post("/query", { purpose: opts?.purpose ?? "compliance", sql: parts.join("") });
  }

  async convoyDetect(opts?: { radiusM?: number; timeTolSecs?: number; minPoints?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const parts: string[] = [];
    if (opts?.radiusM !== undefined) parts.push(`RADIUS => ${opts.radiusM}`);
    if (opts?.timeTolSecs !== undefined) parts.push(`TIME_TOL => ${opts.timeTolSecs * 1_000_000_000}`);
    if (opts?.minPoints !== undefined) parts.push(`MIN_POINTS => ${opts.minPoints}`);
    const sql = `CONVOY(${parts.join(", ")})`;
    return this.#post("/query", { purpose: opts?.purpose ?? "analytics", sql });
  }

  async burnerDetect(opts?: { maxAgeDays?: number; maxCalls?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const parts: string[] = [];
    if (opts?.maxAgeDays !== undefined) parts.push(`MAX_AGE => ${opts.maxAgeDays * 86_400_000_000_000}`);
    if (opts?.maxCalls !== undefined) parts.push(`MAX_CALLS => ${opts.maxCalls}`);
    const sql = `BURNER_DETECT(${parts.join(", ")})`;
    return this.#post("/query", { purpose: opts?.purpose ?? "analytics", sql });
  }

  async cryptoTrace(entity: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `CRYPTO_TRACE(${sqlLiteral(entity)})` });
  }

  async wireReconstruction(account: string, opts?: { tolerancePct?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const parts = [`WIRE_RECONSTRUCTION(${sqlLiteral(account)}`];
    if (opts?.tolerancePct !== undefined) parts.push(`, TOLERANCE_PCT => ${opts.tolerancePct}`);
    parts.push(")");
    return this.#post("/query", { purpose: opts?.purpose ?? "analytics", sql: parts.join("") });
  }

  async hawalaTrace(seed: string, opts?: { maxHops?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const maxHops = opts?.maxHops === undefined ? 5 : Math.min(10, Math.max(1, Math.trunc(opts.maxHops)));
    return this.#post("/query", { purpose: opts?.purpose ?? "analytics", sql: `HAWALA_TRACE(${sqlLiteral(seed)}, MAX_HOPS => ${maxHops})` });
  }

  async dnsTunnelDetect(entity: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "security", sql: `DNS_TUNNEL_DETECT(${sqlLiteral(entity)})` });
  }

  async crimePatternCluster(area: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `CRIME_PATTERN_CLUSTER(${sqlLiteral(area)})` });
  }

  async geofence(fence: string, opts?: { targetType?: string; purpose?: string }): Promise<Record<string, unknown>> {
    const parts = [`GEOFENCE(${sqlLiteral(fence)}`];
    if (opts?.targetType !== undefined) parts.push(`, TARGET_TYPE => ${sqlLiteral(opts.targetType)}`);
    parts.push(")");
    return this.#post("/query", { purpose: opts?.purpose ?? "analytics", sql: parts.join("") });
  }

  // ── Maritime operators (#2247) ────────────────────────────────────────────

  /** Vessel track — track a vessel's AIS position reports over a time window. */
  async vesselTrack(mmsi: number, opts?: { windowSecs?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const parts = [`VESSEL_TRACK(${mmsi}`];
    if (opts?.windowSecs !== undefined) parts.push(`, WINDOW => ${opts.windowSecs * 1_000_000_000}`);
    parts.push(")");
    return this.#post("/query", { purpose: opts?.purpose ?? "analytics", sql: parts.join("") });
  }

  /** Dark-fleet detection — flag vessels with AIS gaps (transponder-off periods). */
  async darkFleetDetect(opts?: { maxGapHours?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const sql = opts?.maxGapHours !== undefined
      ? `DARK_FLEET_DETECT(MAX_GAP_HOURS => ${opts.maxGapHours})`
      : "DARK_FLEET_DETECT()";
    return this.#post("/query", { purpose: opts?.purpose ?? "analytics", sql });
  }

  /** Vessel-to-vessel (ship-to-ship) transfer detection — close-proximity encounters. */
  async vesselToVesselTransfer(opts?: { proximityNm?: number; timeWindowMinutes?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const parts: string[] = [];
    if (opts?.proximityNm !== undefined) parts.push(`PROXIMITY_NM => ${opts.proximityNm}`);
    if (opts?.timeWindowMinutes !== undefined) parts.push(`TIME_WINDOW_MINUTES => ${opts.timeWindowMinutes}`);
    const sql = parts.length ? `VESSEL_TO_VESSEL_TRANSFER(${parts.join(", ")})` : "VESSEL_TO_VESSEL_TRANSFER()";
    return this.#post("/query", { purpose: opts?.purpose ?? "analytics", sql });
  }

  // ── Multimedia operators (#2251, epic #655 — ADR-030) ───────────────────
  //
  // Biometric / perceptual-hash search via the governed SQL operator door.
  // Both route through `POST /query` so PURPOSE / ACL / cell-masking / tenant
  // isolation apply identically to a hand-written query. The server operators
  // are registered in `relata_query::parser`:
  //  - FACE_SEARCH('<csv floats>', '<gallery>', K => n, THRESHOLD => f)
  //  - MATCH_PDQ('<hash>', '<corpus>', THRESHOLD => f)

  /**
   * Biometric face k-NN search against a gallery (#2251, ADR-030).
   *
   * Executes `SELECT * FROM FACE_SEARCH(...)` through the governed `/query`
   * door.
   *
   * @param galleryId - Gallery to search (matches `MediaEmbedding.gallery_id`).
   * @param embedding - Probe face embedding as a number array, or a
   *   pre-formatted comma-separated string.
   * @param opts - `k` (max candidates, default 10), `threshold` (minimum
   *   cosine similarity 0–1, default 0.7), `purpose` override.
   *
   * @example
   * ```typescript
   * const r = await relata.faceSearch("gallery-1", [0.1, 0.2, 0.3],
   *   { k: 5, threshold: 0.6, purpose: "investigation" });
   * r.rows[0]?.score; // number | undefined
   * ```
   */
  async faceSearch<T = Record<string, unknown>>(
    galleryId: string,
    embedding: number[] | string,
    opts?: { k?: number; threshold?: number; purpose?: string },
  ): Promise<QueryResult<T>> {
    const sql = buildFaceSearchSql(galleryId, embedding, opts);
    const queryOpts: { purpose?: string } = {};
    if (opts?.purpose !== undefined) queryOpts.purpose = opts.purpose;
    return this.query<T>(sql, queryOpts);
  }

  /**
   * Perceptual-hash (PDQ) near-duplicate search over a corpus (#2251).
   *
   * Executes `SELECT * FROM MATCH_PDQ(...)` through the governed `/query`
   * door. PDQ near-duplicates differ by ≤ 31 bits (ADR-187).
   *
   * @param corpusId - Hash corpus (matches `MediaHash.corpus_id`).
   * @param queryHash - PDQ hash as a hex string.
   * @param opts - `threshold` (minimum Hamming similarity 0–1, default 0.9),
   *   `purpose` override.
   */
  async matchPdq<T = Record<string, unknown>>(
    corpusId: string,
    queryHash: string,
    opts?: { threshold?: number; purpose?: string },
  ): Promise<QueryResult<T>> {
    const sql = buildMatchPdqSql(corpusId, queryHash, opts?.threshold);
    const queryOpts: { purpose?: string } = {};
    if (opts?.purpose !== undefined) queryOpts.purpose = opts.purpose;
    return this.query<T>(sql, queryOpts);
  }

  /**
   * Near-duplicate/similar-image search against a media reference (#2840,
   * PR #2859).
   *
   * Executes `SELECT * FROM SIMILAR_IMAGE(...)` through the governed
   * `/query` door.
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
   * Execute a SQL query over Arrow Flight `do_get` and return the decoded
   * columnar result — no JSON intermediate (#2253, #958, #2492).
   *
   * The Flight door is enabled server-side with `RELATA_FLIGHT_ENABLE=true`
   * (default port 8815). The ticket is the raw UTF-8 SQL, optionally prefixed
   * with a leading `PURPOSE '<id>'` SQL comment which the server extracts as
   * the query purpose.
   *
   * **Works out of the box (#2492):** when no `transport` is supplied the SDK
   * uses its built-in first-party {@link createArrowFlightTransport} adapter,
   * which opens a real gRPC Flight `do_get` and decodes the stream into an
   * `apache-arrow` `Table` — matching what the Python/Go/Rust SDKs do natively.
   * The gRPC + Arrow runtime libraries (`@grpc/grpc-js`, `apache-arrow`) are
   * **optional peer dependencies**: if they are not installed, the call throws
   * a `RelataError` with install guidance. Supply a `transport` only if you
   * operate your own Arrow Flight stack (e.g. a grpc-web client for the
   * browser); the SDK still handles ticket/PURPOSE assembly, endpoint
   * derivation, and bearer wiring.
   *
   * @param sql - SQL query string used verbatim as the Flight ticket.
   * @param opts - `flightEndpoint` override, `purpose` (injected as a
   *   `PURPOSE '...'` SQL comment), `bearerToken` override (defaults to the
   *   client's token), and `transport` — an optional Flight `do_get` adapter
   *   overriding the built-in one.
   *
   * @typeParam T - Decoded result type (an `apache-arrow` `Table` when the
   *   built-in transport is used; default `unknown`).
   *
   * @example
   * ```typescript
   * // Zero-config (installs apache-arrow + @grpc/grpc-js as peers first):
   * const table = await relata.queryFlight(
   *   "SELECT * FROM Person LIMIT 1000",
   *   { purpose: "analytics" },
   * );
   *
   * // Caller-supplied adapter (unchanged from #2253):
   * const table = await relata.queryFlight(
   *   "SELECT * FROM Person LIMIT 1000",
   *   { purpose: "analytics", transport: myFlightAdapter },
   * );
   * ```
   */
  async queryFlight<T = unknown>(sql: string, opts?: {
    flightEndpoint?: string;
    purpose?: string;
    bearerToken?: string;
    transport?: FlightTransport<T>;
  }): Promise<T> {
    const endpoint = deriveFlightEndpoint(this.#baseUrl, opts?.flightEndpoint);
    const ticketSql = buildFlightTicket(sql, opts?.purpose);
    const bearer = opts?.bearerToken !== undefined ? opts.bearerToken : this.#bearerToken;
    const headers = this.#flightHeaders();
    if (opts?.transport) {
      return opts.transport(endpoint, ticketSql, bearer, headers);
    }
    // #2492: built-in first-party Arrow Flight adapter — works out of the box
    // once the optional apache-arrow + @grpc/grpc-js peers are installed.
    const flight = createArrowFlightTransport<T>({ timeoutMs: this.#timeoutMs });
    return flight.doGet(endpoint, ticketSql, bearer, headers);
  }

  /**
   * Execute a SQL query over the plain gRPC `RelataQuery/Execute` RPC,
   * opting into the negotiated Arrow-IPC row encoding (#4090,
   * `QueryRequest.wants_arrow_ipc_rows` — landed server-side in PR #4086).
   * The server transparently answers with either `arrow_ipc_rows` or
   * `rows_json` (an older/unsupported result falls back to JSON rows,
   * per the proto's documented contract); this method decodes either wire
   * shape into the same row-object array, so callers never need to know
   * which one the server picked.
   *
   * The gRPC + Arrow runtime libraries (`@grpc/grpc-js`, `apache-arrow`) are
   * **optional peer dependencies** — same as {@link queryFlight}. If they are
   * not installed, the call throws a `RelataError` with install guidance.
   *
   * @param sql - SQL query string.
   * @param opts - `grpcEndpoint` override (defaults to
   *   `grpc://<baseUrl host>:50051`, the server's default `RELATA_GRPC_PORT`),
   *   `purpose`, `bearerToken` override (defaults to the client's token).
   *
   * @example
   * ```typescript
   * const result = await relata.queryGrpc("SELECT * FROM Person LIMIT 1000", {
   *   purpose: "analytics",
   * });
   * console.log(result.rowCount, result.rows[0]);
   * ```
   */
  async queryGrpc<T = Record<string, unknown>>(
    sql: string,
    opts?: { grpcEndpoint?: string; purpose?: string; bearerToken?: string },
  ): Promise<GrpcQueryResult<T>> {
    const endpoint = deriveGrpcQueryEndpoint(this.#baseUrl, opts?.grpcEndpoint);
    const bearer = opts?.bearerToken !== undefined ? opts.bearerToken : this.#bearerToken;
    const headers = this.#flightHeaders();
    const purpose = opts?.purpose ?? this.#defaultPurpose;
    const transport = createGrpcQueryTransport({ timeoutMs: this.#timeoutMs });
    const queryOpts: { purpose?: string; bearer?: string; headers?: Record<string, string> } = {
      headers,
    };
    if (purpose !== undefined) queryOpts.purpose = purpose;
    if (bearer !== undefined) queryOpts.bearer = bearer;
    return transport.execute<T>(endpoint, sql, queryOpts);
  }

  /**
   * Execute a SQL query over the plain gRPC `RelataQuery/ExecuteStream`
   * server-streaming RPC (#4090 follow-up to {@link queryGrpc}), opting into
   * the negotiated Arrow-IPC row encoding on every streamed `RowBatch`
   * frame. Collects the stream and decodes it into the same result shape
   * {@link queryGrpc} returns — useful for result sets large enough that the
   * server chunks them into multiple frames (the unary `Execute` RPC
   * `queryGrpc` uses buffers the whole response in one `QueryResponse`
   * message instead).
   *
   * Same options and optional-peer-dependency contract as {@link queryGrpc}.
   *
   * @example
   * ```typescript
   * const result = await relata.queryGrpcStream("SELECT * FROM Person", {
   *   purpose: "analytics",
   * });
   * console.log(result.rowCount, result.rows[0]);
   * ```
   */
  async queryGrpcStream<T = Record<string, unknown>>(
    sql: string,
    opts?: { grpcEndpoint?: string; purpose?: string; bearerToken?: string },
  ): Promise<GrpcQueryResult<T>> {
    const endpoint = deriveGrpcQueryEndpoint(this.#baseUrl, opts?.grpcEndpoint);
    const bearer = opts?.bearerToken !== undefined ? opts.bearerToken : this.#bearerToken;
    const headers = this.#flightHeaders();
    const purpose = opts?.purpose ?? this.#defaultPurpose;
    const transport = createGrpcQueryTransport({ timeoutMs: this.#timeoutMs });
    const queryOpts: { purpose?: string; bearer?: string; headers?: Record<string, string> } = {
      headers,
    };
    if (purpose !== undefined) queryOpts.purpose = purpose;
    if (bearer !== undefined) queryOpts.bearer = bearer;
    return transport.executeStream<T>(endpoint, sql, queryOpts);
  }

  /**
   * @internal Build the tenant / delegation / correlation headers a Flight
   * do_get carries as gRPC metadata (#3213). A fresh X-Request-ID is generated
   * per call unless the caller pinned one in the static header bag.
   */
  #flightHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.#tenant !== undefined) headers["x-relata-tenant-id"] = this.#tenant;
    if (this.#actingAs !== undefined) headers["x-acting-as"] = this.#actingAs;
    if (this.#delegatedBy !== undefined) headers["x-delegated-by"] = this.#delegatedBy;
    const pinned = Object.keys(this.#extraHeaders).find(
      (k) => k.toLowerCase() === "x-request-id",
    );
    if (pinned !== undefined) {
      headers["x-request-id"] = this.#extraHeaders[pinned]!;
    } else if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      headers["x-request-id"] = crypto.randomUUID();
    }
    return headers;
  }

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
   * Returns the deployment profile, cluster role, and per-principal query quota.
   *
   * @throws {AuthError} Server requires auth and token is invalid.
   * @throws {NetworkError} Server unreachable.
   */
  async status(): Promise<StatusResponse> {
    const wire = await this.#get<WireStatusResponse>("/status");
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
    const wire = await this.#get<WireAuditCountResponse>("/audit/count");
    return {
      entries: wire.entries,
      chainValid: wire.chain_valid,
    };
  }

  /**
   * Fetch the list of nodes in the Relata cluster.
   *
   * Returns a single-element list in `free` and `server` profiles.
   *
   * @throws {AuthError} Token missing or invalid.
   * @throws {NetworkError} Server unreachable.
   */
  async clusterNodes(): Promise<ClusterNode[]> {
    const wire = await this.#get<WireClusterNodesResponse>("/cluster/nodes");
    return wire.nodes.map((n) => ({
      nodeId: n.node_id,
      role: n.role,
      url: n.url,
    }));
  }

  /**
   * Return engine-wide counts for health dashboards.
   *
   * Wraps `GET /debug/stats`. The shape mirrors the storage-backend contract
   * §9 — `records`, `states`, `snapshotRows`, `logLeaves`, `tokens` — to the
   * extent the server currently distinguishes them. Fields the server does
   * not yet emit come back as `undefined`; the full server payload is on
   * `raw` for forward-compat.
   *
   * @throws {AuthError} Token missing or invalid.
   * @throws {NetworkError} Server unreachable.
   */
  async stats(): Promise<Stats> {
    const wire = await this.#get<WireStatsResponse>("/debug/stats");
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
   * Ingest a datagrep-extractor document into Relata.
   *
   * Submits the `_chunks.jsonl` and `_manifest.json` outputs of a `dgrep`
   * extraction run to `POST /rag/ingest` (renamed from `/ingest/document` by
   * #4499). The server parses and version-checks the protocol envelope, then
   * queues the chunks for storage. See `GET /rag/specs` for the protocol
   * version/field-contract handshake.
   *
   * @param chunksJsonl - Newline-delimited JSON string — one chunk per line,
   *   as produced by `dgrep run --mode chunks`.
   * @param manifestJson - JSON string of the extraction manifest.
   * @returns The ingest receipt (`reportId`, `taskId`, `chunksIngested`,
   *          `warnings`, `schemaVersion`, `queueDepth`). Poll `taskId` with
   *          `ingestDocumentStatus()` to confirm storage completion (#1001).
   *
   * @throws {AuthError} Invalid/missing token.
   * @throws {RateLimitedError} Ingest queue full (HTTP 429).
   * @throws {ValidationError} Protocol error (HTTP 422).
   * @throws {ServerError} Any other server-side failure (HTTP 5xx).
   * @throws {NetworkError} Server unreachable.
   */
  async ingestDocument(
    chunksJsonl: string,
    manifestJson: string,
  ): Promise<IngestDocumentResponse> {
    const wire = await this.#post<WireIngestDocumentResponse>(
      "/rag/ingest",
      { chunks_jsonl: chunksJsonl, manifest_json: manifestJson },
    );
    return {
      reportId: wire.report_id ?? "",
      taskId: wire.task_id ?? "",
      chunksIngested: wire.chunks_ingested ?? 0,
      warnings: Array.isArray(wire.warnings) ? wire.warnings : [],
      schemaVersion: wire.schema_version ?? "",
      queueDepth: wire.queue_depth ?? 0,
    };
  }

  /**
   * Poll the status of an async document-ingest task (#1001).
   *
   * `POST /rag/ingest` returns immediately with a `taskId`; chunks flush to
   * storage in the background. Call this with the `taskId` until
   * `status === "complete"`.
   *
   * @param taskId - The `taskId` returned by `ingestDocument()`.
   * @returns The task status (`status`, `chunksTotal`, `chunksWritten`, …).
   *
   * @throws {AuthError} Invalid/missing token.
   * @throws {NotFoundError} Unknown / wrong-endpoint `taskId` (HTTP 404).
   * @throws {ServerError} Any other server-side failure (HTTP 5xx).
   * @throws {NetworkError} Server unreachable.
   */
  async ingestDocumentStatus(taskId: string): Promise<IngestDocumentTaskStatus> {
    const wire = await this.#get<WireIngestDocumentTaskStatus>(
      `/rag/ingest/${encodeURIComponent(taskId)}`,
    );
    return {
      taskId: wire.task_id ?? taskId,
      status: wire.status === "complete" ? "complete" : "pending",
      reportId: wire.report_id ?? null,
      chunksTotal: wire.chunks_total ?? 0,
      chunksWritten: wire.chunks_written ?? 0,
      warnings: Array.isArray(wire.warnings) ? wire.warnings : [],
    };
  }

  /**
   * Record a post-ingest usage signal against a `DocumentSource` (#4498).
   *
   * `citationCount`/`retrievalCount`/`lastCitedAt` are write-BACK signals,
   * not ingest-time constants — an agentic RAG loop calls this once per
   * retrieval/citation/feedback event, e.g. right after generating an
   * answer that cites a chunk from `reportId`:
   * `client.documentUsage(reportId, { cited: true })`.
   *
   * @param reportId - The `DocumentSource.reportId` this event targets.
   * @param signal - At least one of `cited`, `retrieved`, `feedbackScore`
   *   must be set. `cited: true` increments `citationCount` by 1 and sets
   *   `lastCitedAt` to now; `retrieved: true` increments `retrievalCount`
   *   by 1; `feedbackScore` (recommended range `[0.0, 1.0]`, not enforced
   *   server-side) folds into `feedbackAvg` as a running mean.
   * @returns The `DocumentSource`'s updated usage counters.
   *
   * @throws {NotFoundError} `reportId` has no live `DocumentSource` for the
   *   caller's tenant (HTTP 404).
   * @throws {ValidationError} No signal was supplied (HTTP 400).
   * @throws {AuthError} Invalid/missing token.
   * @throws {ServerError} Any other server-side failure (HTTP 5xx).
   * @throws {NetworkError} Server unreachable.
   */
  async documentUsage(
    reportId: string,
    signal: { cited?: boolean; retrieved?: boolean; feedbackScore?: number },
  ): Promise<DocumentUsageResponse> {
    const body: Record<string, unknown> = {};
    if (signal.cited) body["cited"] = true;
    if (signal.retrieved) body["retrieved"] = true;
    if (signal.feedbackScore !== undefined) body["feedback_score"] = signal.feedbackScore;
    const wire = await this.#post<WireDocumentUsageResponse>(
      `/rag/documents/${encodeURIComponent(reportId)}/usage`,
      body,
    );
    return {
      reportId: wire.report_id ?? reportId,
      citationCount: wire.citation_count ?? null,
      retrievalCount: wire.retrieval_count ?? null,
      lastCitedAt: wire.last_cited_at ?? null,
      feedbackAvg: wire.feedback_avg ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Public API — ingest + memory verbs (#751)
  // -------------------------------------------------------------------------

  /** Ingest an array of objects into Relata (`POST /ingest`). */
  async ingest(objects: object[]): Promise<IngestResponse> {
    return this.#post<IngestResponse>("/ingest", { objects });
  }

  /**
   * Stream rows from an async iterable into batched `POST /ingest` calls
   * with backpressure. Memory is O(batchSize), not O(totalRows). Returns
   * the total number of rows successfully ingested. Stops on first error.
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
    await this.#post(`/ingest?${params}`, { objects: batch });
  }

  /** Store a memory item (`POST /memory/remember`). */
  async remember(content: string, opts?: RememberOptions): Promise<RememberResponse> {
    return this.#post<RememberResponse>("/memory/remember", { content, ...opts });
  }

  /** Recall memory items matching a query (`GET /memory/recall`). */
  async recall(query: string, opts?: RecallOptions): Promise<RecallResponse> {
    const params = new URLSearchParams({ q: query });
    if (opts?.session_id !== undefined) params.set("session_id", opts.session_id);
    if (opts?.top_k !== undefined) params.set("top_k", String(opts.top_k));
    if (opts?.as_of !== undefined) params.set("as_of", opts.as_of);
    if (opts?.purpose !== undefined) params.set("purpose", opts.purpose);
    return this.#get<RecallResponse>(`/memory/recall?${params}`);
  }

  /** Delete a memory item (`DELETE /memory/forget/:id`). */
  async forget(id: string): Promise<void> {
    await this.#delete<unknown>(`/memory/forget/${encodeURIComponent(id)}`);
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
   * @internal
   * POST a raw (non-JSON) text body — e.g. Sigma YAML. No retry (the
   * operation may not be idempotent server-side), mirroring
   * `_typed-http.ts`'s `_sendRaw`.
   */
  async #postRaw<T>(
    path: string,
    body: string,
    contentType: string,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.#destroyed) {
      throw new ClientClosedError();
    }
    const url = `${this.#baseUrl}${path}`;
    const effectiveTimeout = timeoutMs ?? this.#timeoutMs;
    const controller = new AbortController();
    const timer =
      effectiveTimeout > 0
        ? setTimeout(() => controller.abort(), effectiveTimeout)
        : undefined;
    try {
      const headers = this.#buildHeaders(true);
      headers["Content-Type"] = contentType;
      const response = await this.#fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body,
        redirect: "manual",
      });
      assertNotRedirected(response, url);
      return await this.#parseResponse<T>(response, undefined);
    } catch (err) {
      if (this.#isAbortError(err)) {
        throw new TimeoutError(effectiveTimeout);
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
   * Mirrors the Python `_http._send_with_retry` loop and the Rust/Go
   * idempotency gate (#2489):
   * - Generate a per-attempt `X-Request-ID` (unless the caller pinned one in
   *   the static header bag).
   * - Retry **idempotent** verbs (`GET`/`HEAD`/`OPTIONS`) on `{502, 503, 504}`
   *   and on network errors, up to `maxRetries`. POST/PUT/PATCH/DELETE are
   *   never retried — a gateway timeout after commit would double-execute
   *   irreversible operations (parity with `crates/relata-sdk-rust/src/http.rs`
   *   `post()` and `sdks/go/relata/client.go::isIdempotent`).
   * - Exponential backoff: `retryBackoffMs * 2^attempt`.
   */
  async #send<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body: Record<string, unknown> | undefined,
    timeoutMs: number | undefined,
    callHeaders?: Record<string, string>,
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
        if (method !== "GET" && method !== "DELETE") {
          (init as RequestInit & { body: string }).body = JSON.stringify(body);
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
      body = text ? JSON.parse(text) : {};
    } else {
      // Non-JSON bodies (e.g., plain text errors from reverse proxies)
      body = text ? { error: text } : {};
    }

    if (!response.ok) {
      const err = body as Partial<WireErrorResponse>;
      const serverMessage =
        err?.detail ?? err?.error ?? err?.message ?? `HTTP ${response.status}`;
      const queryId = err?.query_id;
      const code = err?.code;
      const typeUrl = err?.type;
      const retryable = err?.retryable ?? false;
      // X-Request-ID can be echoed in the body or only in the header.
      const requestId =
        err?.request_id ?? response.headers.get("x-request-id") ?? undefined;
      const retryAfter = response.headers.get("Retry-After");
      const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
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
        queryId,
        retryAfterSeconds,
        costUnits,
        code,
        typeUrl,
        retryable,
        requestId,
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
    const cap = this.#maxResponseBytes;
    const body = response.body ?? new ReadableStream<Uint8Array>();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > cap) {
          throw new ResponseTooLargeError(cap);
        }
        chunks.push(value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore cancel errors
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
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

/** @internal Wire shape for `POST /rag/ingest` (renamed from `/ingest/document`). */
interface WireIngestDocumentResponse {
  report_id?: string;
  task_id?: string;
  chunks_ingested?: number;
  warnings?: string[];
  schema_version?: string;
  queue_depth?: number;
}

/** @internal Wire shape for `GET /rag/ingest/:task_id` (renamed from `/ingest/document/:task_id`). */
interface WireIngestDocumentTaskStatus {
  task_id?: string;
  status?: string;
  report_id?: string | null;
  chunks_total?: number;
  chunks_written?: number;
  warnings?: string[];
}

/** @internal Wire shape for `POST /rag/documents/:report_id/usage` (#4498). */
interface WireDocumentUsageResponse {
  report_id?: string;
  citation_count?: number | null;
  retrieval_count?: number | null;
  last_cited_at?: number | null;
  feedback_avg?: number | null;
}

/** @internal Wire shape for `GET /version`. */
interface WireVersionInfo {
  version: string;
  commit?: string;
  profile?: string;
  schema_version?: string;
  features?: string[];
}

/** @internal Wire shape for `GET /debug/stats`. */
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
