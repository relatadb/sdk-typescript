/**
 * Core TypeScript types for the Relata SDK.
 *
 * All timestamps are RFC 3339 strings with `Z` suffix (UTC).
 * All int64 values that exceed Number.MAX_SAFE_INTEGER are represented as strings.
 */

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
  /** Server-side wall-clock execution time in milliseconds. */
  elapsedMs: number;
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
   * Base URL of the Relata server, e.g. `"http://localhost:8080"`.
   * Trailing slash is stripped automatically.
   */
  baseUrl: string;

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
   * Per-request timeout in milliseconds. `0` means no timeout (default).
   * Applied via `AbortController`; works in Node 18+, Deno, Bun, and browser.
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
   * Tenant / organisation id sent as `X-Organization-Id` on every request.
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
  /** RFC 7807 dotted problem code, e.g. `"RELATA.QUERY.PURPOSE_REQUIRED"`. */
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
 * Response from `POST /ingest/document` — the datagrep-extractor envelope.
 */
export interface IngestDocumentResponse {
  /** Server-assigned manifest id for the ingested document. */
  reportId: string;
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
  /** Facet counts keyed by field name then value. */
  facets: Record<string, Record<string, number>>;
  /** Server-side processing time in milliseconds. */
  processingTimeMs: number;
}

/** Options for the `search()` client method (#670). */
export interface SearchOptions {
  /** Maximum number of hits to return (server default: 20). */
  limit?: number;
  /** Field names to aggregate counts for. */
  facets?: string[];
  /** Include field-level `<em>` highlight snippets. */
  highlight?: boolean;
  /** Equality filters applied server-side (`{field: value}`). */
  filters?: Record<string, string>;
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
  facets?: Record<string, Record<string, number>>;
  processing_time_ms?: number;
}
