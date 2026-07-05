/**
 * RelataClient — the primary entry point for the Relata TypeScript SDK.
 *
 * Handles authentication, request lifecycle, timeout, and error mapping.
 * Zero runtime dependencies; uses the platform-native `fetch` API.
 *
 * ```typescript
 * import { createClient } from "@relata/sdk";
 *
 * const relata = createClient("http://localhost:8080", {
 *   bearerToken: process.env.RELATA_TOKEN,
 *   defaultPurpose: "analytics",
 * });
 *
 * const result = await relata.query<{ name: string }>(
 *   "SELECT name FROM Person WHERE identity_index_match('+919876543210') LIMIT 5",
 * );
 * console.log(result.rows[0]?.name);
 * ```
 */

import {
  type AuditCountResponse,
  type ClusterNode,
  type HealthResponse,
  type QueryOptions,
  type QueryResult,
  type RelataClientOptions,
  type StatusResponse,
  type WireAuditCountResponse,
  type WireClusterNodesResponse,
  type WireErrorResponse,
  type WireHealthResponse,
  type WireQueryResponse,
  type WireStatusResponse,
} from "./types.ts";
import {
  mapHttpError,
  NetworkError,
  PurposeError,
  TimeoutError,
} from "./errors.ts";
import { QueryBuilder } from "./query.ts";

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
  readonly #bearerToken: string | undefined;
  readonly #defaultPurpose: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

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
   *   baseUrl: "http://localhost:8080",
   *   bearerToken: process.env.RELATA_TOKEN,
   *   defaultPurpose: "analytics",
   *   timeoutMs: 30_000,
   * });
   *
   * // Convenience string shorthand
   * const relata = new RelataClient("http://localhost:8080");
   * ```
   */
  constructor(options: RelataClientOptions | string) {
    const opts: RelataClientOptions =
      typeof options === "string" ? { baseUrl: options } : options;

    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#bearerToken = opts.bearerToken;
    this.#defaultPurpose = opts.defaultPurpose;
    this.#timeoutMs = opts.timeoutMs ?? 0;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
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
   * The SQL dialect extends ANSI SQL with Relata-specific extensions:
   * - `AS OF 'YYYY-MM-DDTHH:MM:SSZ'` — bi-temporal snapshot query
   * - `WITH PROVENANCE` — attach PROV-O provenance to each row
   * - `PATHS_BETWEEN(a, b, max_hops => 4)` — graph path operator
   * - `MATCH_FACE(image_bytes => ...)` — face-recognition operator
   * - `LOOKUP_IDENTITY(...)` — IdentityIndex universal lookup
   * - `HYBRID_SCORE(...)` — combined BM25 + vector similarity
   * - `NETWORK_EXPAND(seed_id => ..., hops => 3)` — network expansion
   *
   * @typeParam T - Row shape. Defaults to `Record<string, unknown>`.
   * @param sql - The SQL string to execute.
   * @param options - Optional per-call overrides (purpose, timeout).
   * @returns Typed query result with `rows`, `queryId`, `elapsedMs`, `rowCount`.
   *
   * @throws {PurposeError} No purpose declared or purpose not in PurposeRegistry.
   * @throws {AuthError} Bearer token missing or invalid.
   * @throws {QuotaError} Per-principal query cost quota exhausted.
   * @throws {ForbiddenError} Cedar ACL denies access to requested data.
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
   * // Bi-temporal snapshot
   * const r = await relata.query(
   *   "SELECT * FROM BankAccount AS OF '2024-06-01T00:00:00Z' LIMIT 100",
   *   { purpose: "audit" },
   * );
   *
   * // Graph traversal
   * const r = await relata.query(
   *   "SELECT * FROM PATHS_BETWEEN('person-001', 'org-042', max_hops => 4)",
   *   { purpose: "analytics" },
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
      throw new PurposeError(undefined, "purpose field is required");
    }

    const wire = await this.#post<WireQueryResponse>("/query", {
      purpose,
      sql,
    }, options?.timeoutMs);

    const rows = wire.rows as T[];
    return {
      rows,
      queryId: wire.query_id,
      elapsedMs: wire.elapsed_ms,
      rowCount: rows.length,
    };
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
   * A `chainValid: false` result indicates the hash chain may have been tampered
   * with and must be investigated immediately.
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
   * Returns a single-element list in `lite` and `server` profiles.
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

  // -------------------------------------------------------------------------
  // Internal HTTP helpers
  // -------------------------------------------------------------------------

  /** @internal */
  async #get<T>(path: string, timeoutMs?: number): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const effectiveTimeout = timeoutMs ?? this.#timeoutMs;

    let signal: AbortSignal | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (effectiveTimeout > 0) {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), effectiveTimeout);
      signal = controller.signal;
    }

    try {
      const response = await this.#fetch(url, {
        method: "GET",
        headers: this.#buildHeaders(),
        signal,
      });

      return this.#parseResponse<T>(response, undefined);
    } catch (err) {
      if (this.#isAbortError(err)) {
        throw new TimeoutError(effectiveTimeout);
      }
      if (err instanceof Error && err.name !== "RelataError") {
        throw new NetworkError(
          `Failed to reach Relata at ${url}: ${err.message}`,
          err,
        );
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** @internal */
  async #post<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const effectiveTimeout = timeoutMs ?? this.#timeoutMs;

    let signal: AbortSignal | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (effectiveTimeout > 0) {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), effectiveTimeout);
      signal = controller.signal;
    }

    try {
      const response = await this.#fetch(url, {
        method: "POST",
        headers: {
          ...this.#buildHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      return this.#parseResponse<T>(response, body["purpose"] as string | undefined);
    } catch (err) {
      if (this.#isAbortError(err)) {
        throw new TimeoutError(effectiveTimeout);
      }
      if (err instanceof Error && err.name !== "RelataError") {
        throw new NetworkError(
          `Failed to reach Relata at ${url}: ${err.message}`,
          err,
        );
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** @internal Parse response, map HTTP errors to typed errors. */
  async #parseResponse<T>(
    response: Response,
    purpose: string | undefined,
  ): Promise<T> {
    // Attempt to parse the body as JSON regardless of status so we can surface
    // the server's error message when present.
    let body: unknown;
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      body = await response.json();
    } else {
      // Non-JSON bodies (e.g., plain text errors from reverse proxies)
      const text = await response.text();
      body = text ? { error: text } : {};
    }

    if (!response.ok) {
      const err = body as Partial<WireErrorResponse>;
      const serverMessage = err?.error ?? `HTTP ${response.status}`;
      const queryId = err?.query_id;
      const retryAfter = response.headers.get("Retry-After");
      const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;

      const extras: {
        purpose?: string | undefined;
        queryId?: string | undefined;
        retryAfterSeconds?: number | undefined;
      } = {};
      if (purpose !== undefined) extras.purpose = purpose;
      if (queryId !== undefined) extras.queryId = queryId;
      if (retryAfterSeconds !== undefined) extras.retryAfterSeconds = retryAfterSeconds;

      throw mapHttpError(response.status, serverMessage, extras);
    }

    return body as T;
  }

  /** @internal Build common request headers. */
  #buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.#bearerToken) {
      headers["Authorization"] = `Bearer ${this.#bearerToken}`;
    }
    return headers;
  }

  /** @internal Detect AbortError across runtimes (Node, Deno, Bun, browser). */
  #isAbortError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.name === "AbortError" || err.message.includes("aborted");
  }
}
