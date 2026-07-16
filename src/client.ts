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
 * const relata = createClient("http://localhost:8080", {
 *   bearerToken: process.env.RELATA_TOKEN,
 *   defaultPurpose: "analytics",
 *   tenant: "org-acme",          // X-Organization-Id
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
  type HealthResponse,
  type IngestDocumentResponse,
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
  mapHttpError,
  NetworkError,
  PurposeError,
  RelataError,
  TimeoutError,
} from "./errors.ts";
import { QueryBuilder } from "./query.ts";

// ---------------------------------------------------------------------------
// Transport config
// ---------------------------------------------------------------------------

/**
 * @internal
 * HTTP status codes that trigger an automatic retry when `maxRetries > 0`.
 * Matches the Python `_http._DEFAULT_RETRY_ON` set.
 */
const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * @internal
 * Default base backoff for the retry loop, in milliseconds.
 */
const DEFAULT_RETRY_BACKOFF_MS = 500;

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
  readonly #tenant: string | undefined;
  readonly #actingAs: string | undefined;
  readonly #delegatedBy: string | undefined;
  readonly #maxRetries: number;
  readonly #retryBackoffMs: number;
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
   *   baseUrl: "http://localhost:8080",
   *   bearerToken: process.env.RELATA_TOKEN,
   *   defaultPurpose: "analytics",
   *   timeoutMs: 30_000,
   *   tenant: "org-acme",
   *   maxRetries: 3,
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
    this.#tenant = opts.tenant;
    this.#actingAs = opts.actingAs;
    this.#delegatedBy = opts.delegatedBy;
    this.#maxRetries = opts.maxRetries ?? 0;
    this.#retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

    // Compose the static extra-headers bag: tenant/delegation first, then
    // caller-supplied headers win. Per-attempt X-Request-ID is overlaid in
    // #buildHeaders so each request gets a fresh id unless the caller pinned
    // one in `opts.headers`.
    const extra: Record<string, string> = {};
    if (opts.tenant !== undefined) extra["X-Organization-Id"] = opts.tenant;
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
   * @typeParam T - Row shape. Defaults to `Record<string, unknown>`.
   * @param sql - The SQL string to execute.
   * @param options - Optional per-call overrides (purpose, timeout).
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
      { purpose, sql },
      options?.timeoutMs,
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
   * ```typescript
   * const results = await relata.search({
   *   query: "alice smith",
   *   type: "Person",
   *   limit: 10,
   *   facets: ["tenant_id"],
   *   highlight: true,
   * });
   * console.log(results.hits[0]?.fields["name"]);
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
    if (params.typoTolerance) body["typo_tolerance"] = params.typoTolerance;

    const wire = await this.#post<WireSearchResponse>("/search", body);
    return {
      hits: (wire.hits ?? []).map((h) => ({
        id: h.id,
        objectType: h.object_type,
        fields: h.fields,
        score: h.score,
        highlights: h.highlights ?? {},
      })),
      total: wire.total ?? 0,
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
    const wire = await this.#post<{ results: unknown[]; processing_time_ms: number }>(
      "/multi-search",
      { queries },
    );
    return {
      results: (wire.results ?? []) as SearchResponse[],
      processingTimeMs: wire.processing_time_ms ?? 0,
    };
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
    return this.#delete(`/types/${name}`);
  }

  /** Get type detail (properties, owner, row count). */
  async typeDetail(name: string): Promise<Record<string, unknown>> {
    return this.#get(`/types/${name}`);
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

  /** Create a detection rule. */
  async createRule(rule: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#post("/rules", rule);
  }

  /** Disable (logically delete) a rule. */
  async disableRule(ruleId: string): Promise<Record<string, unknown>> {
    return this.#delete(`/rules/${ruleId}`);
  }

  /** Import a Sigma rule (YAML string). */
  async importSigma(sigmaYaml: string): Promise<Record<string, unknown>> {
    return this.#post("/rules/sigma", { sigma: sigmaYaml });
  }

  /** Snooze a rule for ``durationSecs``. */
  async snoozeRule(ruleId: string, durationSecs: number): Promise<Record<string, unknown>> {
    return this.#post(`/rules/${ruleId}/snooze`, { duration_secs: durationSecs });
  }

  /** Suppress all future matches of ``pattern`` for a rule. */
  async suppressRule(ruleId: string, pattern: string): Promise<Record<string, unknown>> {
    return this.#post(`/rules/${ruleId}/suppress`, { pattern });
  }

  /** Add an exception entry so specific matches are ignored. */
  async addRuleException(ruleId: string, exception: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#post(`/rules/${ruleId}/exceptions`, exception);
  }

  /** Retrieve tuning state (snoozes, suppressions, exceptions). */
  async getRuleTuning(ruleId: string): Promise<Record<string, unknown>> {
    return this.#get(`/rules/${ruleId}/tuning`);
  }

  /** Resolve an identity value to all known objects/clusters via SQL. */
  async resolveIdentity(value: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `RESOLVE_IDENTITY('${value.replace(/'/g, "''")}')`;
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  /** Detect identities in free text via SmartIngest. */
  async detectIdentities(text: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `DETECT_IDENTITIES('${text.replace(/'/g, "''")}')`;
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  /** GDPR Art. 17 erasure — irreversible crypto-shred of a subject's data. */
  async eraseSubject(subject: string, reason?: string): Promise<Record<string, unknown>> {
    const s = subject.replace(/'/g, "''");
    const r = (reason ?? "gdpr-art17-request").replace(/'/g, "''");
    const sql = `ERASE SUBJECT '${s}' REASON '${r}' CERTIFY`;
    return this.#post("/query", { purpose: "gdpr-erasure", sql });
  }

  // ── SPARQL, sessions & cluster (#967 Tier 2d) ────────────────────────────

  /** Bulk export all rows of a type (#967 Tier 5c). */
  async exportData(objectType: string, format?: string): Promise<Record<string, unknown>> {
    const fmt = format ?? "json";
    return this.#get(`/export?type=${objectType}&format=${fmt}&purpose=export`);
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
    return this.#delete(`/webhooks/${id}`);
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
    return this.#post(`/cluster/drain/${nodeId}`, {});
  }

  /** View uncommitted session changes. */
  async sessionDiff(sessionId: string): Promise<Record<string, unknown>> {
    return this.#get(`/session/${sessionId}/diff`);
  }

  /** Commit a session's draft writes. */
  async sessionCommit(sessionId: string): Promise<Record<string, unknown>> {
    return this.#post(`/session/${sessionId}/commit`, {});
  }

  /** Discard uncommitted session changes. */
  async sessionDiscard(sessionId: string): Promise<Record<string, unknown>> {
    return this.#delete(`/session/${sessionId}/draft`);
  }

  // ── Entity merge, dedup & identity (#967) ────────────────────────────────

  /** Resolve an identity to its full cluster of linked identifiers. */
  async identityCluster(value: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `RESOLVE_IDENTITY('${value.replace(/'/g, "''")}', MODE => 'cluster')`;
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  /** Ontological merge of two identities (#967). */
  async fuseIdentities(idA: string, idB: string, purpose?: string): Promise<Record<string, unknown>> {
    const a = idA.replace(/'/g, "''");
    const b = idB.replace(/'/g, "''");
    const sql = `FUSE_IDENTITIES('${a}', '${b}')`;
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  /** Ontological unmerge — inverse of fuseIdentities (#967). */
  async splitIdentities(idA: string, idB: string, purpose?: string): Promise<Record<string, unknown>> {
    const a = idA.replace(/'/g, "''");
    const b = idB.replace(/'/g, "''");
    const sql = `SPLIT_IDENTITIES('${a}', '${b}')`;
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  // ── Graph algorithm operators (#967) ─────────────────────────────────────

  async graphDijkstra(objectType: string, fromId: string, toId: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `GRAPH_DIJKSTRA('${objectType}', FROM => '${fromId}', TO => '${toId}')`;
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  async graphPageRank(objectType: string, opts?: { damping?: number; maxIter?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const parts = [`GRAPH_PAGERANK('${objectType}'`];
    if (opts?.damping !== undefined) parts.push(`, DAMPING => ${opts.damping}`);
    if (opts?.maxIter !== undefined) parts.push(`, MAX_ITER => ${opts.maxIter}`);
    parts.push(")");
    return this.#post("/query", { purpose: opts?.purpose ?? "analytics", sql: parts.join("") });
  }

  async graphSCC(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `GRAPH_SCC('${objectType}')` });
  }

  async graphCycles(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `GRAPH_CYCLES('${objectType}')` });
  }

  async graphCommunity(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `GRAPH_COMMUNITY('${objectType}')` });
  }

  async graphNodeSimilarity(objectType: string, node: string, purpose?: string): Promise<Record<string, unknown>> {
    const sql = `GRAPH_NODE_SIMILARITY('${objectType}', NODE => '${node}')`;
    return this.#post("/query", { purpose: purpose ?? "analytics", sql });
  }

  async graphLinkPredict(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `GRAPH_LINK_PREDICT('${objectType}')` });
  }

  async graphTriangleCount(objectType: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `TRIANGLE_COUNT('${objectType}')` });
  }

  // ── Intelligence operators (#967) ────────────────────────────────────────

  async beneficialOwnershipChain(party: string, opts?: { maxDepth?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const parts = [`BENEFICIAL_OWNERSHIP_CHAIN('${party}'`];
    if (opts?.maxDepth !== undefined) parts.push(`, MAX_DEPTH => ${opts.maxDepth}`);
    parts.push(")");
    return this.#post("/query", { purpose: opts?.purpose ?? "compliance", sql: parts.join("") });
  }

  async sanctionsScreen(party: string, opts?: { threshold?: number; purpose?: string }): Promise<Record<string, unknown>> {
    const parts = [`SANCTIONS_SCREEN('${party}'`];
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
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `CRYPTO_TRACE('${entity}')` });
  }

  async dnsTunnelDetect(entity: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "security", sql: `DNS_TUNNEL_DETECT('${entity}')` });
  }

  async crimePatternCluster(area: string, purpose?: string): Promise<Record<string, unknown>> {
    return this.#post("/query", { purpose: purpose ?? "analytics", sql: `CRIME_PATTERN_CLUSTER('${area}')` });
  }

  async geofence(fence: string, opts?: { targetType?: string; purpose?: string }): Promise<Record<string, unknown>> {
    const parts = [`GEOFENCE('${fence}'`];
    if (opts?.targetType !== undefined) parts.push(`, TARGET_TYPE => '${opts.targetType}'`);
    parts.push(")");
    return this.#post("/query", { purpose: opts?.purpose ?? "analytics", sql: parts.join("") });
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
   * extraction run to `POST /ingest/document`. The server parses and
   * version-checks the protocol envelope, then queues the chunks for storage.
   *
   * @param chunksJsonl - Newline-delimited JSON string — one chunk per line,
   *   as produced by `dgrep run --mode chunks`.
   * @param manifestJson - JSON string of the extraction manifest.
   * @returns The ingest receipt (`reportId`, `chunksIngested`, `warnings`,
   *          `schemaVersion`, `queueDepth`).
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
      "/ingest/document",
      { chunks_jsonl: chunksJsonl, manifest_json: manifestJson },
    );
    return {
      reportId: wire.report_id ?? "",
      chunksIngested: wire.chunks_ingested ?? 0,
      warnings: Array.isArray(wire.warnings) ? wire.warnings : [],
      schemaVersion: wire.schema_version ?? "",
      queueDepth: wire.queue_depth ?? 0,
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

  /** Bearer token passed to the constructor, if any. */
  get bearerToken(): string | undefined {
    return this.#bearerToken;
  }

  /** Default purpose declared on the client, if any. */
  get defaultPurpose(): string | undefined {
    return this.#defaultPurpose;
  }

  /** Tenant / `X-Organization-Id` declared on the client, if any. */
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
  ): Promise<T> {
    return this.#send<T>("POST", path, body, timeoutMs);
  }

  /** @internal */
  async #delete<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.#send<T>("DELETE", path, undefined, timeoutMs);
  }

  /**
   * @internal
   * Core request dispatcher: timeout, retry, X-Request-ID, error mapping.
   *
   * Mirrors the Python `_http._send_with_retry` loop:
   * - Generate a per-attempt `X-Request-ID` (unless the caller pinned one in
   *   the static header bag).
   * - Retry on `{502, 503, 504}` and on network errors, up to `maxRetries`.
   * - Exponential backoff: `retryBackoffMs * 2^attempt`.
   */
  async #send<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: Record<string, unknown> | undefined,
    timeoutMs: number | undefined,
  ): Promise<T> {
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
        const init: RequestInit = {
          method,
          headers,
          signal,
        };
        if (method === "POST") {
          (init as RequestInit & { body: string }).body = JSON.stringify(body);
        }
        const response = await this.#fetch(url, init);
        const result = await this.#parseResponse<T>(
          response,
          body?.["purpose"] as string | undefined,
        );
        return result;
      } catch (err) {
        lastError = err;
        // Timeout — never retry (the operation may have side-effects).
        if (this.#isAbortError(err)) {
          throw new TimeoutError(effectiveTimeout);
        }
        // Already-classified RelataError (any subclass) — retry only on the
        // retryable set; otherwise rethrow as-is.
        if (err instanceof RelataError) {
          const status = err.statusCode;
          if (
            attempt + 1 < maxAttempts &&
            RETRYABLE_STATUS_CODES.has(status)
          ) {
            await this.#sleep(this.#retryBackoffMs * 2 ** attempt);
            continue;
          }
          throw err;
        }
        // Raw network failure — wrap + retry.
        if (err instanceof Error) {
          const wrapped = new NetworkError(
            `Failed to reach Relata at ${url}: ${err.message}`,
            err,
          );
          lastError = wrapped;
          if (attempt + 1 < maxAttempts) {
            await this.#sleep(this.#retryBackoffMs * 2 ** attempt);
            continue;
          }
          throw wrapped;
        }
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    // Exhausted retries on a network error.
    throw lastError;
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

    if (
      contentType.includes("application/json") ||
      contentType.includes("application/problem+json")
    ) {
      body = await response.json();
    } else {
      // Non-JSON bodies (e.g., plain text errors from reverse proxies)
      const text = await response.text();
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
      });
    }

    return body as T;
  }

  /** @internal Build common request headers. */
  #buildHeaders(generateRequestId: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
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

  /** @internal Promise-based sleep for the retry backoff. */
  async #sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Wire shapes that are private to the client module
// ---------------------------------------------------------------------------

/** @internal Wire shape for `POST /ingest/document`. */
interface WireIngestDocumentResponse {
  report_id?: string;
  chunks_ingested?: number;
  warnings?: string[];
  schema_version?: string;
  queue_depth?: number;
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
