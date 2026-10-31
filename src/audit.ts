/**
 * Audit + provenance SDK (#78).
 *
 * Wraps `/audit/count`, `/audit/entries`, `/audit/log`.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase, qs } from "./_typed-http.ts";

/**
 * Audit + provenance client — entry listing and query correlation.
 */
export class AuditClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): AuditClient {
    return new AuditClient(TypedClientBase.clientToCtor(client));
  }

  // -------------------------------------------------------------------------
  // Audit entries (#78)
  // -------------------------------------------------------------------------

  /**
   * Total audit-entry count + chain integrity flag.
   * Wraps `GET /audit/count`.
   */
  async count(): Promise<Record<string, unknown>> {
    return this._get("/audit/count");
  }

  /**
   * Paginated audit-entry listing with filters.
   * Wraps `GET /audit/entries`. Returns
   * `{"entries": [...], "next_cursor"?: string, "chain_valid": bool}`.
   */
  async entries(
    opts: {
      principal?: string;
      purpose?: string;
      decision?: string;
      requestId?: string;
      sinceNs?: number;
      untilNs?: number;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const path = `/audit/entries${qs({
      principal: opts.principal,
      purpose: opts.purpose,
      decision: opts.decision,
      request_id: opts.requestId,
      since: opts.sinceNs,
      until: opts.untilNs,
      limit: opts.limit ?? 100,
      cursor: opts.cursor,
    })}`;
    return this._get(path);
  }

  /**
   * Filtered mutation-style audit projections. Wraps `GET /audit/log`.
   * `from`/`to` are inclusive timestamp bounds, `table` a substring of the
   * derived resource; `tenantId` only applies to an unscoped admin caller.
   * Returns `{"entries": [...], "chain_valid": bool}`.
   */
  async log(
    opts: { limit?: number; from?: string; to?: string; table?: string; tenantId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const path = `/audit/log${qs({
      limit: opts.limit ?? 100,
      from: opts.from,
      to: opts.to,
      table: opts.table,
      tenant_id: opts.tenantId,
    })}`;
    return this._get(path);
  }

  /**
   * Look up a single audit entry by its `request_id`. Returns `null` when
   * no entry matches (the server returns an empty page).
   */
  async findByRequestId(
    requestId: string,
  ): Promise<Record<string, unknown> | null> {
    const page = await this.entries({ requestId, limit: 1 });
    const entries =
      typeof page === "object" && page !== null && Array.isArray(page["entries"])
        ? page["entries"]
        : undefined;
    if (Array.isArray(entries) && entries.length > 0) {
      const first = entries[0];
      if (typeof first !== "object" || first === null) return null;
      const row = first as Record<string, unknown>;
      // Never return a different request's entry (e.g. a server that ignores
      // the `request_id` filter answers with the newest entry).
      if ("request_id" in row && row["request_id"] !== requestId) return null;
      return row;
    }
    return null;
  }

}
