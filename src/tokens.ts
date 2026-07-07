/**
 * Dedup / uniqueness token SDK (#84 — server routes now shipped).
 *
 * Wraps `POST /tokens`, `GET /tokens/:id`, `DELETE /tokens/:id`,
 * `GET /tokens/stats`.
 *
 * Server contract:
 * - `GET /tokens/:id` → `200 {"present": bool, "inserted_at_ns"?: i64, "ttl_secs"?: u64|null}`
 * - `DELETE /tokens/:id` → `200 {"revoked": bool}` (admin only)
 * - `GET /tokens/stats` → `200 {"count": usize, "oldest_ns"?: i64|null, "eviction_policy": str}`
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

/** Dedup token set statistics. */
export interface TokenStats {
  count: number;
  oldestNs: number | undefined;
  evictionPolicy: string;
}

/** Dedup / uniqueness token client. */
export class TokenClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): TokenClient {
    return new TokenClient(TypedClientBase.clientToCtor(client));
  }

  /**
   * Atomic test-and-set. Returns `true` if newly inserted, `false` if
   * already present. This is the replay-defence primitive — security
   * relevant; a backend that buffers the write asynchronously or loses the
   * token on restart fails the §7 contract.
   * Wraps `POST /tokens`.
   */
  async remember(
    tokenId: string,
    opts: { ttlSecs?: number } = {},
  ): Promise<boolean> {
    const payload: Record<string, unknown> = { id: tokenId };
    if (opts.ttlSecs !== undefined) payload["ttl_secs"] = opts.ttlSecs;
    const resp = await this._post<Record<string, unknown>>("/tokens", payload);
    return resp["newly_inserted"] === true;
  }

  /**
   * Non-mutating presence check.
   * Wraps `GET /tokens/:id`. Returns
   * `{"present": bool, "inserted_at_ns"?: int, "ttl_secs"?: int|null}`.
   */
  async check(tokenId: string): Promise<Record<string, unknown>> {
    return this._get(`/tokens/${encodeURIComponent(tokenId)}`);
  }

  /**
   * Explicit revoke (admin only). Returns `true` if a token was actually
   * removed. Wraps `DELETE /tokens/:id`.
   */
  async revoke(tokenId: string): Promise<boolean> {
    const resp = await this._delete<Record<string, unknown>>(
      `/tokens/${encodeURIComponent(tokenId)}`,
    );
    return resp["revoked"] === true;
  }

  /** Return dedup-set statistics. Wraps `GET /tokens/stats`. */
  async stats(): Promise<TokenStats> {
    const resp = await this._get<Record<string, unknown>>("/tokens/stats");
    const oldest = resp["oldest_ns"];
    return {
      count: Number(resp["count"] ?? 0),
      oldestNs:
        typeof oldest === "number"
          ? oldest
          : typeof oldest === "string" && oldest.length > 0
            ? Number(oldest)
            : undefined,
      evictionPolicy: String(resp["eviction_policy"] ?? ""),
    };
  }
}
