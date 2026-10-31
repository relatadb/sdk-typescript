/**
 * Durable-write and cross-index freshness contract (`relata.freshness/v1`, #5706).
 *
 * A write returns an `operation` block with an opaque `token`. Pass it to
 * {@link FreshnessClient.barrier} (or send {@link freshnessHeaders} on a read)
 * to wait, boundedly, until the write is visible in the lexical, secondary,
 * vector, graph and extraction indexes. A read is never served as complete
 * while an index it needs is behind: it fails with 503 `freshness-not-ready`
 * carrying per-index progress, or in `partial` mode returns
 * `freshness.status === "incomplete"`.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

/** Indexes a read can depend on. */
export type FreshnessIndex = "lexical" | "secondary" | "vector" | "graph" | "extraction";

/** Options for a gated read or a barrier. */
export interface FreshnessOptions {
  indexes?: FreshnessIndex[];
  /** Maximum wait in milliseconds (server default 1000, max 30000). */
  waitMs?: number;
  requireDurable?: boolean;
}

/** Headers that gate `/v1/query`, `/v1/search`, `/v1/graphql` or MCP reads on `token`. */
export function freshnessHeaders(
  token: string,
  opts: FreshnessOptions & { partial?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = { "X-Relata-Min-Version": token };
  if (opts.indexes !== undefined) {
    headers["X-Relata-Require-Index"] = opts.indexes.join(",") || "none";
  }
  if (opts.waitMs !== undefined) headers["X-Relata-Wait-Ms"] = String(Math.trunc(opts.waitMs));
  if (opts.requireDurable) headers["X-Relata-Require-Durable"] = "true";
  if (opts.partial) headers["X-Relata-Freshness-Mode"] = "partial";
  return headers;
}

/** Freshness client. */
export class FreshnessClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): FreshnessClient {
    return new FreshnessClient(TypedClientBase.clientToCtor(client));
  }

  /** `GET /v1/freshness/status`: per-index state plus a token for the latest write. */
  async status(): Promise<Record<string, unknown>> {
    return this._get<Record<string, unknown>>("/v1/freshness/status");
  }

  /**
   * `POST /v1/freshness/barrier`: wait until `token` is visible in `opts.indexes`
   * (default all). A write not visible within `waitMs` throws the server's
   * `freshness-not-ready` problem, whose body names the lagging index.
   */
  async barrier(token: string, opts: FreshnessOptions = {}): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { token };
    if (opts.indexes !== undefined) payload["indexes"] = opts.indexes;
    if (opts.waitMs !== undefined) payload["wait_ms"] = Math.trunc(opts.waitMs);
    if (opts.requireDurable) payload["require_durable"] = true;
    return this._post<Record<string, unknown>>("/v1/freshness/barrier", payload);
  }
}
