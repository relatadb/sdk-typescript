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
 * @typeParam T - Shape of each row. Defaults to `Record<string, unknown>`.
 *               Pass a concrete interface for typed access:
 *               ```typescript
 *               const r = await relata.query<Person>("SELECT * FROM Person LIMIT 10");
 *               r.rows[0].name; // typed as string | undefined
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
}

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

/**
 * Options for constructing a `RelataClient`.
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
   * `"audit"`, `"analysis"`, `"compliance"`.
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
  /** Deployment profile: `"lite"` | `"server"` | `"cluster"`. */
  profile: string;
  /** Node identifier set via `NODE_ID` env var. */
  nodeId: string;
}

/**
 * Response from `GET /status`.
 */
export interface StatusResponse {
  /** Deployment profile: `"lite"` | `"server"` | `"cluster"`. */
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

/** @internal Wire shape returned by `POST /query`. */
export interface WireQueryResponse {
  rows: Record<string, unknown>[];
  query_id: string;
  elapsed_ms: number;
}

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
  error: string;
  code?: string;
  query_id?: string;
}
