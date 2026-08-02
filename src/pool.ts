/**
 * Multi-endpoint connection pool for high-availability deployments (#2756,
 * TS parity delta #2 vs. the Rust reference).
 *
 * Round-robin load balancing across N HTTP endpoints with health-aware
 * failover, mirroring `crates/relata-sdk-rust/src/pool.rs::RelataClientPool`.
 * When an endpoint's request fails, the pool marks it unhealthy and skips it
 * for a cooldown period, retrying on the next healthy endpoint.
 *
 * Data-plane surface only (matching the Rust pool): `query`, `search`,
 * `version`, `health`, `stats`. Anything else (schema mutation, ingest,
 * admin) should go through a single {@link RelataClient} pointed at a
 * specific node — the pool is for read/query-side high availability, not a
 * general-purpose load balancer.
 *
 * ```typescript
 * import { ClientPool } from "@zysec-ai/relata-sdk";
 *
 * const pool = new ClientPool(process.env.RELATA_TOKEN)
 *   .withEndpoint("http://node-1:9090")
 *   .withEndpoint("http://node-2:9090")
 *   .withEndpoint("http://node-3:9090");
 *
 * // Automatically round-robins + fails over.
 * const version = await pool.version();
 * ```
 *
 * @module
 */

import { RelataClient } from "./client.ts";
import type {
  HealthResponse,
  QueryResult,
  RelataClientOptions,
  SearchOptions,
  SearchResponse,
  Stats,
  VersionInfo,
} from "./types.ts";

/** Cooldown for a failed endpoint before it is retried again (milliseconds). */
const FAIL_COOLDOWN_MS = 5000;

/** @internal */
interface PoolEntry {
  readonly client: RelataClient;
  readonly url: string;
  healthy: boolean;
  failedAt: number | null;
}

/** Options for constructing a {@link ClientPool}. */
export interface ClientPoolOptions {
  /**
   * Override the `fetch` implementation used by every endpoint in the pool
   * (forwarded to each per-endpoint `RelataClient`). Defaults to
   * `globalThis.fetch`. Primarily useful for tests.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Multi-endpoint HTTP client pool with round-robin + health-aware failover.
 *
 * Mirrors the Rust `RelataClientPool` builder shape: construct with the
 * pool-wide bearer token, then chain `.withEndpoint(url)` per node.
 */
export class ClientPool {
  readonly #endpoints: PoolEntry[] = [];
  #cursor = 0;
  readonly #defaultBearerToken: string | undefined;
  readonly #fetch: typeof globalThis.fetch | undefined;

  /**
   * Create a pool with the given default bearer token and no endpoints.
   * Call `.withEndpoint()` / `.withEndpointConfigured()` to add nodes.
   */
  constructor(bearerToken?: string, opts: ClientPoolOptions = {}) {
    this.#defaultBearerToken = bearerToken;
    this.#fetch = opts.fetch;
  }

  /**
   * Add an endpoint to the pool. Inherits the pool's bearer token: the first
   * already-added endpoint's token if the pool is non-empty, otherwise the
   * token passed to the constructor.
   */
  withEndpoint(url: string): this {
    const token = this.#endpoints[0]?.client.bearerToken ?? this.#defaultBearerToken;
    return this.withEndpointConfigured(url, token);
  }

  /** Add an endpoint with an explicit bearer token and optional tenant. */
  withEndpointConfigured(url: string, bearerToken?: string, tenant?: string): this {
    // Built up field-by-field (rather than `{ baseUrl: url, bearerToken, tenant,
    // fetch: this.#fetch }`) because `RelataClientOptions`'s `bearerToken`/
    // `tenant`/`fetch` are optional (`field?: T`), and this SDK's
    // `exactOptionalPropertyTypes: true` rejects assigning an explicit
    // `undefined` to those keys — omit the key entirely instead. Same idiom
    // as `cli.ts`'s `clientOpts` construction.
    const opts: RelataClientOptions = { baseUrl: url };
    if (bearerToken !== undefined) opts.bearerToken = bearerToken;
    if (tenant !== undefined) opts.tenant = tenant;
    if (this.#fetch !== undefined) opts.fetch = this.#fetch;
    const client = new RelataClient(opts);
    this.#endpoints.push({ client, url, healthy: true, failedAt: null });
    return this;
  }

  /** Number of endpoints in the pool. */
  get length(): number {
    return this.#endpoints.length;
  }

  /** Whether the pool has no endpoints. */
  get isEmpty(): boolean {
    return this.#endpoints.length === 0;
  }

  /** @internal Pick the next healthy endpoint (round-robin, skipping unhealthy). */
  #nextHealthy(): PoolEntry | undefined {
    if (this.#endpoints.length === 0) return undefined;
    const start = this.#cursor++;
    for (let i = 0; i < this.#endpoints.length; i++) {
      const entry = this.#endpoints[(start + i) % this.#endpoints.length]!;
      if (entry.healthy) return entry;
      const elapsed =
        entry.failedAt === null ? Number.POSITIVE_INFINITY : Date.now() - entry.failedAt;
      if (elapsed >= FAIL_COOLDOWN_MS) return entry;
    }
    // Every endpoint is unhealthy and still cooling down — try the first one
    // anyway rather than failing outright (matches the Rust fallback).
    return this.#endpoints[0];
  }

  /** @internal */
  #markFailed(entry: PoolEntry): void {
    entry.healthy = false;
    entry.failedAt = Date.now();
  }

  /** @internal */
  #markHealthy(entry: PoolEntry): void {
    entry.healthy = true;
    entry.failedAt = null;
  }

  /** @internal Run `op` against the pool, failing over to the next endpoint on error. */
  async #withFailover<T>(op: (client: RelataClient) => Promise<T>): Promise<T> {
    if (this.#endpoints.length === 0) {
      throw new Error("ClientPool: no endpoints in pool");
    }
    let lastErr: unknown = new Error("ClientPool: no healthy endpoints");
    for (let i = 0; i < this.#endpoints.length; i++) {
      const entry = this.#nextHealthy();
      if (!entry) break;
      try {
        const result = await op(entry.client);
        this.#markHealthy(entry);
        return result;
      } catch (err) {
        this.#markFailed(entry);
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /** `GET /version` via the pool. */
  async version(): Promise<VersionInfo> {
    return this.#withFailover((c) => c.version());
  }

  /** `GET /health` via the pool. */
  async health(): Promise<HealthResponse> {
    return this.#withFailover((c) => c.health());
  }

  /** `GET /stats` via the pool. */
  async stats(): Promise<Stats> {
    return this.#withFailover((c) => c.stats());
  }

  /** `POST /query` via the pool. */
  async query<T = Record<string, unknown>>(sql: string, purpose: string): Promise<QueryResult<T>> {
    return this.#withFailover((c) => c.query<T>(sql, { purpose }));
  }

  /** `POST /search` via the pool. */
  async search(params: { query: string; type: string } & SearchOptions): Promise<SearchResponse> {
    return this.#withFailover((c) => c.search(params));
  }
}
