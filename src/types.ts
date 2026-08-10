/**
 * Core TypeScript types for the Relata SDK.
 *
 * All timestamps are RFC 3339 strings with `Z` suffix (UTC).
 * All int64 values that exceed Number.MAX_SAFE_INTEGER are represented as strings.
 */

import type { Logger } from "./logger.ts";

// ---------------------------------------------------------------------------
// Query result
// ---------------------------------------------------------------------------

/**
 * The result of a SQL query executed against Relata.
 *
 * The wire shape returned by `POST /query` is normalised by the client so that
 * `rows` is **always** an array of row objects, regardless of whether the
 * server sent `data: [...]` (the rich shape) or `rows: <int>` (the legacy
 * count-only shape). See `RelataClient.query` for details.
 *
 * @typeParam T - Shape of each row. Defaults to `Record<string, unknown>`.
 *               Pass a concrete interface for typed access:
 *               ```typescript
 *               const r = await relata.query<Person>("SELECT * FROM Person LIMIT 10");
 *               r.rows[0]?.name; // typed as string | undefined
 *               ```
 */
export interface QueryResult<T = Record<string, unknown>> {
  /** Row data returned by the query. */
  rows: T[];
  /** Server-assigned unique query identifier (UUID v4). */
  queryId: string;
  /** Server-side wall-clock execution time in milliseconds (legacy field). */
  elapsedMs: number;
  /**
   * Server-side processing time in milliseconds (#1252).
   * Populated from `processing_time_ms` when present, falls back to `elapsed_ms`.
   */
  processingTimeMs?: number;
  /** Number of rows in `rows`. Convenience alias for `rows.length`. */
  rowCount: number;
  /** Column names in projection order, when the server sends them. */
  columns: string[];
}

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

/**
 * Options for constructing a `RelataClient`.
 *
 * All fields except `baseUrl` are optional. The same shape is accepted by the
 * `createClient(url, options?)` factory (with `baseUrl` passed positionally).
 */
export interface RelataClientOptions {
  /**
   * Base URL of the Relata server, e.g. `"http://localhost:9090"`.
   * Trailing slash is stripped automatically.
   */
  baseUrl: string;

  /**
   * Base URL of the loopbound admin control-plane listener
   * (`RELATA_ADMIN_BIND`, default `127.0.0.1:9091`). Per ADR-0261,
   * `/admin/*` and `/platform/*` routes are mounted **only** there on a
   * hardened server/cluster deployment — set this so
   * {@link BackupClient}/{@link TenantAdminClient}'s platform-tenant methods
   * reach them (relatadb/RelataDB#2321). Leave unset (the default) when the
   * admin listener isn't split from the data plane (e.g. local/free-profile
   * dev) — every request then goes to `baseUrl`, unchanged.
   */
  adminBaseUrl?: string;

  /**
   * Bearer token for the `Authorization` header.
   * Required when the server is started with `RELATA_BEARER_TOKEN` set.
   */
  bearerToken?: string;

  /**
   * Default purpose declared with every query when the caller does not
   * specify one explicitly.
   *
   * Every Relata query **must** declare a purpose registered in the tenant's
   * `PurposeRegistry` (SPECS §5.22.4). Common values: `"analytics"`,
   * `"audit"`, `"analysis"`, `"compliance_review"`.
   */
  defaultPurpose?: string;

  /**
   * Per-request timeout in milliseconds. Defaults to `30000` (30s), matching
   * the Python and Go SDKs (#2494). `0` is an explicit opt-out meaning no
   * timeout. Applied via `AbortController`; works in Node 18+, Deno, Bun, and
   * browser.
   */
  timeoutMs?: number;

  /**
   * Override the `fetch` implementation. Useful in environments where the
   * global `fetch` is unavailable or for testing with a mock transport.
   *
   * Defaults to `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch;

  /**
   * Tenant / organisation id sent as `X-Relata-Tenant-Id` on every request.
   * Required for multi-tenant deployments.
   */
  tenant?: string;

  /**
   * Delegation principal sent as `X-Acting-As` — the caller asserts
   * membership and the server's `wire_acting_as()` parses it (#55). Pairs
   * with `delegatedBy`.
   */
  actingAs?: string;

  /**
   * Delegation chain root sent as `X-Delegated-By`.
   */
  delegatedBy?: string;

  /**
   * Optional dict of arbitrary HTTP headers overlaid on every request (e.g.
   * `{"X-Request-ID": "..."}` for correlation, or
   * `{"X-Verified-Principal": "..."}` for proxy-trust deployments).
   * Caller-supplied headers win over the SDK defaults.
   */
  headers?: Record<string, string>;

  /**
   * Maximum number of retries on transient failures (HTTP 502/503/504 and
   * network-level errors). Defaults to `0` (off). When greater than zero the
   * client retries with an exponential backoff (`retryBackoffMs * 2^attempt`).
   */
  maxRetries?: number;

  /**
   * Base backoff in milliseconds for the retry loop. The n-th retry waits
   * approximately `retryBackoffMs * 2^n` before firing. Defaults to `500`
   * (0.5s), matching the Python SDK.
   */
  retryBackoffMs?: number;

  /**
   * Cap on how much of a (non-streaming) response body the client will buffer,
   * in bytes (#3214). A larger body rejects with {@link ResponseTooLargeError}
   * instead of being read into memory, so a malicious or buggy server cannot
   * exhaust memory. Defaults to 64 MiB. Streaming surfaces are not capped.
   */
  maxResponseBytes?: number;

  /**
   * Pluggable logger for SDK-side diagnostics (retry attempts, deprecation
   * warnings, …). The library is **silent by default** — supplying a
   * `Logger` (e.g. `new ConsoleLogger("my-app")`) is the only way the SDK
   * will emit anything to the console. See `logger.ts` for the interface.
   *
   * The SDK never throws from a logger call; custom implementations must
   * catch their own failures.
   */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Health & status
// ---------------------------------------------------------------------------

/**
 * Response from `GET /health`.
 */
export interface HealthResponse {
  /** Always `"ok"` when the server is healthy. */
  status: string;
  /** Deployment profile: `"free"` | `"server"` | `"cluster"`. */
  profile: string;
  /** Node identifier set via `NODE_ID` env var. */
  nodeId: string;
}

/**
 * Response from `GET /status`.
 */
export interface StatusResponse {
  /** Deployment profile: `"free"` | `"server"` | `"cluster"`. */
  profile: string;
  /** Cluster role: `"coordinator"` | `"reader"` | `"writer"` | `"indexer"`. */
  role: string;
  /** Per-principal hard cap on query cost units (`RELATA_QUERY_QUOTA`). */
  queryQuota: number;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Response from `GET /audit/count`.
 */
export interface AuditCountResponse {
  /** Total number of audit log entries in the tamper-evident chain. */
  entries: number;
  /**
   * Whether the hash chain is intact. `false` indicates possible tampering
   * and must be investigated immediately.
   */
  chainValid: boolean;
}

// ---------------------------------------------------------------------------
// Cluster
// ---------------------------------------------------------------------------

/**
 * A single node in the Relata cluster.
 */
export interface ClusterNode {
  /** Node identifier (`NODE_ID` env var). */
  nodeId: string;
  /** Cluster role: `"coordinator"` | `"reader"` | `"writer"` | `"indexer"`. */
  role: string;
  /** Reachable URL of this node. */
  url: string;
}

/**
 * Response from `GET /cluster/nodes`.
 */
export interface ClusterNodesResponse {
  nodes: ClusterNode[];
}

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

/**
 * Subgraph-matcher selection for multi-hop Cypher patterns (#1189).
 *
 * `"auto"` (the default) lets the server choose; `"vf3"` forces the VF3
 * subgraph-isomorphism matcher; `"bfs"` forces the chained-BFS fallback.
 * BFS is also the automatic fallback for patterns VF3 cannot handle
 * (e.g. unbounded `*` variable-length paths). The server-wide kill-switch
 * is `RELATA_VF3_ENABLED`.
 */
export type Matcher = "auto" | "vf3" | "bfs";

/**
 * Per-call options accepted by `RelataClient.query()`.
 */
export interface QueryOptions {
  /**
   * Purpose token declared for this query.
   * Falls back to `RelataClientOptions.defaultPurpose` when omitted.
   *
   * The server rejects any query with a missing or unregistered purpose
   * (HTTP 400, `PurposeError`).
   */
  purpose?: string;

  /**
   * Per-query timeout override in milliseconds.
   * Overrides `RelataClientOptions.timeoutMs` for this call only.
   */
  timeoutMs?: number;

  /**
   * Query-language override sent as the `x-query-dialect` header (#3265).
   * - `"sql"` — Relata SQL (default when the body is not `MATCH`-prefixed).
   * - `"cypher"` — openCypher subset, translated to governed SQL.
   * - `"gql"` — ISO/IEC 39075 GQL subset (header-selected only; never
   *   auto-detected). GQL-status errors surface as `RelataError`
   *   (42G04 syntax → HTTP 400, 0A501 unsupported feature → HTTP 501).
   *
   * When omitted, the server auto-detects: a `MATCH`-prefixed body is
   * treated as Cypher, anything else as SQL.
   */
  dialect?: "sql" | "cypher" | "gql";

  /**
   * Subgraph-matcher hint for multi-hop Cypher patterns (#1189).
   * Injected as a leading `/*+ matcher=…` hint comment on the query text.
   * Omitted or `"auto"` sends the query unchanged.
   */
  matcher?: Matcher;
}

// ---------------------------------------------------------------------------
// Raw wire shapes (internal — used for JSON parsing)
// ---------------------------------------------------------------------------

/** @internal Wire shape returned by `GET /health`. */
export interface WireHealthResponse {
  status: string;
  profile: string;
  node_id: string;
}

/** @internal Wire shape returned by `GET /status`. */
export interface WireStatusResponse {
  profile: string;
  role: string;
  query_quota: number;
}

/** @internal Wire shape returned by `GET /audit/count`. */
export interface WireAuditCountResponse {
  entries: number;
  chain_valid: boolean;
}

/** @internal Wire shape returned by `GET /cluster/nodes`. */
export interface WireClusterNode {
  node_id: string;
  role: string;
  url: string;
}

/** @internal */
export interface WireClusterNodesResponse {
  nodes: WireClusterNode[];
}

/** @internal Wire error envelope returned by the server. */
export interface WireErrorResponse {
  error?: string;
  /**
   * RFC 7807 `code` extension field. Kebab-case for most HTTP errors (e.g.
   * `"access-denied"`); the `QueryError`-derived `REL_*` form (e.g.
   * `"REL_PARSE"`) for `/query*` planner/execution errors — see
   * `RelataError` in `errors.ts` for the full vocabulary split (#2555). Not
   * the dotted `"RELATA.QUERY.PURPOSE_REQUIRED"` form, which was never
   * implemented server-side.
   */
  code?: string;
  /** RFC 7807 `type` URL linking to the error docs. */
  type?: string;
  /** RFC 7807 human-readable detail. */
  detail?: string;
  /** Server-side message alias (older shape). */
  message?: string;
  /** Whether the server says the request can be retried. */
  retryable?: boolean;
  /** `X-Request-ID` echoed back in the body, when available. */
  request_id?: string;
  /** Server-assigned query id, present when the error occurred mid-execution. */
  query_id?: string;
}

// ---------------------------------------------------------------------------
// Ingest / introspection
// ---------------------------------------------------------------------------

/**
 * Response from `POST /rag/ingest` (renamed from `/ingest/document`) — the
 * datagrep-extractor envelope.
 */
export interface IngestDocumentResponse {
  /** Server-assigned manifest id for the ingested document. */
  reportId: string;
  /** Async task id — poll with `ingestDocumentStatus(taskId)` until `status === "complete"` (#1001). */
  taskId: string;
  /** Number of chunks accepted into the ingest queue. */
  chunksIngested: number;
  /** Non-fatal protocol warnings (e.g. newer-minor-version fields). */
  warnings: string[];
  /** Protocol version the server parsed the document as. */
  schemaVersion: string;
  /** Current ingest queue depth after this submission. */
  queueDepth: number;
}

/**
 * Status of an async document-ingest task — `GET /rag/ingest/:task_id`
 * (renamed from `/ingest/document/:task_id`) (#1001).
 *
 * `status` is `"pending"` while chunks are still flushing to storage, then
 * `"complete"` once the background writer confirms them. `chunksWritten` reaches
 * `chunksTotal` on a successful completion.
 */
export interface IngestDocumentTaskStatus {
  taskId: string;
  status: "pending" | "complete";
  reportId: string | null;
  chunksTotal: number;
  chunksWritten: number;
  warnings: string[];
}

/**
 * Response from `POST /rag/documents/{reportId}/usage` (#4498).
 *
 * Reports the `DocumentSource` row's usage counters *after* applying this
 * call's increments — `citationCount`/`retrievalCount`/`lastCitedAt`/
 * `feedbackAvg` are write-BACK signals maintained by repeated calls to this
 * endpoint, not ingest-time constants.
 */
export interface DocumentUsageResponse {
  /** The `DocumentSource` this usage event targeted. */
  reportId: string;
  /** Total citations recorded so far. */
  citationCount: number | null;
  /** Total retrievals recorded so far. */
  retrievalCount: number | null;
  /** Nanoseconds since epoch of the most recent citation, or `null` if never cited. */
  lastCitedAt: number | null;
  /** Running mean of every `feedbackScore` recorded so far, or `null` if none yet. */
  feedbackAvg: number | null;
}

/**
 * Response from `GET /version` — runtime build-info.
 */
export interface VersionInfo {
  /** Relata server version (e.g. `"1.1.0"`). */
  version: string;
  /** Git commit hash the binary was built from. */
  commit: string | undefined;
  /** Deployment profile — `free` / `server` / `cluster`. */
  profile: string | undefined;
  /** Ontology / row-model schema version, useful for migration gating. */
  schemaVersion: string | undefined;
  /** Compiled-in feature flags. */
  features: string[];
}

/**
 * Response from `GET /debug/stats` — engine-wide counts for health dashboards.
 *
 * The shape mirrors the storage-backend contract §9. Every field the server
 * populates is exposed; fields the server does not yet emit default to
 * `undefined` so the model is forward-compatible.
 */
export interface Stats {
  /** Total content-addressed blobs (partner §2). */
  records: number | undefined;
  /** Total live rows across all types (partner §3). */
  states: number | undefined;
  /** Total rows in incrementally-refreshed MVs (partner §4). */
  snapshotRows: number | undefined;
  /** Current WAL write_seq (partner §5; pending server support). */
  logLeaves: number | undefined;
  /** Current dedup-token count (partner §7). */
  tokens: number | undefined;
  /** Full server response, in case the caller wants an unmodelled field. */
  raw: Record<string, unknown>;
}

/**
 * Response from `GET /health/ready` — the 9-condition readiness report.
 */
export interface ReadyReport {
  /** `true` when the node is ready to serve (HTTP 200). */
  isReady: boolean;
  /** Server-side status string (e.g. `"ok"`, `"shedding"`). */
  status: string;
  /** Machine-friendly shed reason (queue_backpressure / wal_failures / ...). */
  reason: string | undefined;
  /** Human-friendly explanation. */
  detail: string | undefined;
}

// ---------------------------------------------------------------------------
// Raw wire shapes (internal — used for JSON parsing)
// ---------------------------------------------------------------------------

/** @internal Wire shape returned by `POST /query`. The client normalises the
 * `data`/`rows` ambiguity into the public `QueryResult` shape. */
export interface WireQueryResponse {
  /** When an array, the actual row data. When a number, a row count. */
  rows?: unknown;
  /** Some servers send the row data under `data` instead of `rows`. */
  data?: unknown;
  /** Column names in projection order, when the server sends them. */
  columns?: string[];
  query_id?: string;
  elapsed_ms?: number;
  /** Server-side processing time in ms (#1252). Falls back to elapsed_ms. */
  processing_time_ms?: number;
}

// ---------------------------------------------------------------------------
// Search (#670)
// ---------------------------------------------------------------------------

/** A single document returned by `POST /search`. */
export interface SearchHit {
  /** Object ID. */
  id: string;
  /** Object type name. */
  objectType: string;
  /** Object fields as a plain object. */
  fields: Record<string, unknown>;
  /** BM25 relevance score. */
  score: number;
  /** Field-level snippets with `<em>` highlights (present when `highlight: true`). */
  highlights: Record<string, string>;
}

/** Response from `POST /search` (#670). */
export interface SearchResponse {
  /** Matching documents sorted by descending score. */
  hits: SearchHit[];
  /** Total matching documents (may exceed `hits.length` when a limit is set). */
  total: number;
  /** Full matching-set size (#967). */
  estimatedTotalHits?: number;
  /** Facet counts keyed by field name then value. */
  facets: Record<string, Record<string, number>>;
  /** Numeric facet stats: min/max/sum/avg (#967). */
  facetStats?: Record<string, { min: number; max: number; sum: number; avg: number; count: number }>;
  /** Server-side processing time in milliseconds. */
  processingTimeMs: number;
}

/** Matching strategy for multi-term queries (#967). */
/**
 * Query-term matching strategy (#967). `"boolean"` (#3263) interprets
 * uppercase `AND`/`OR`/`NOT` operators in the query text as posting-list set
 * operations (left-associative; a bare space means OR).
 */
export type MatchingStrategy = "all" | "last" | "frequency" | "boolean" | "any";

/** Per-query typo tolerance config (#967). */
export interface TypoTolerance {
  enabled?: boolean;
  minWordSize?: number;
  disableOnWords?: string[];
  disableOnAttributes?: string[];
}

/**
 * Options for the `search()` client method (#670).
 *
 * By default `search()` is BM25-only — it never touches the vector channel.
 * Set `metric` and/or `weights` to route the request through the server's
 * real HYBRID_SEARCH fusion (BM25 + vector reciprocal-rank fusion) instead;
 * either one alone is enough to switch the request onto the hybrid path (#2672).
 */
export interface SearchOptions {
  /** Maximum number of hits to return (server default: 20). */
  limit?: number;
  /** Field names to aggregate counts for. */
  facets?: string[];
  /** Include field-level `<em>` highlight snippets. */
  highlight?: boolean;
  /** Equality filters applied server-side (`{field: value}`). */
  filters?: Record<string, string>;
  /**
   * Matching strategy: "all" (AND), "last", "frequency", "boolean", or
   * "any" (OR, default) (#967). "boolean" (#3263) interprets uppercase
   * AND/OR/NOT operators in the query text as set operations.
   */
  matchingStrategy?: MatchingStrategy;
  /** Per-query typo tolerance override (#967). */
  typoTolerance?: TypoTolerance;
  /**
   * Vector distance metric for the HYBRID_SEARCH channel (e.g. `"cosine"`,
   * `"euclidean"`, `"dot"`). Setting this (or `weights`) is what actually
   * triggers hybrid fusion instead of plain BM25 (#2672).
   */
  metric?: string;
  /**
   * Three-element `[graph, bm25, vector]` fusion weights for HYBRID_SEARCH.
   * Setting this (or `metric`) is what actually triggers hybrid fusion
   * instead of plain BM25 (#2672).
   */
  weights?: [number, number, number];
}

// ---------------------------------------------------------------------------
// Ingest (#751)
// ---------------------------------------------------------------------------

/** Response from `POST /ingest`. */
export interface IngestResponse {
  rows_written: number;
}

// ---------------------------------------------------------------------------
// Memory verbs (#751)
// ---------------------------------------------------------------------------

/** Options for `RelataClient.remember()`. */
export interface RememberOptions {
  session_id?: string;
  confidence?: number;
  memory_class?: "episodic" | "semantic" | "procedural";
  purpose?: string;
}

/** Response from `POST /memory/remember`. */
export interface RememberResponse {
  id: string;
}

/** Options for `RelataClient.recall()`. */
export interface RecallOptions {
  session_id?: string;
  top_k?: number;
  as_of?: string;
  purpose?: string;
}

/** A single memory item returned by `GET /memory/recall`. */
export interface RecallItem {
  id: string;
  content: string;
  confidence: number;
  memory_class: string;
}

/** Response from `GET /memory/recall`. */
export interface RecallResponse {
  items: RecallItem[];
}

/** @internal Wire shape for `POST /search`. */
export interface WireSearchResponse {
  hits?: Array<{
    id: string;
    object_type: string;
    fields: Record<string, unknown>;
    score: number;
    highlights?: Record<string, string>;
  }>;
  total?: number;
  estimatedTotalHits?: number;
  facets?: Record<string, Record<string, number>>;
  facetStats?: Record<string, { min: number; max: number; sum: number; avg: number; count: number }>;
  processing_time_ms?: number;
}
