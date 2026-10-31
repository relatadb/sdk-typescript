/**
 * Audit + provenance SDK (#78).
 *
 * Wraps `/v1/audit/count` and `/v1/audit/log`.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase, qs } from "./_typed-http.ts";

/**
 * Audit + provenance client — chain count and the filtered audit log.
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
  // Audit count + log (#78)
  // -------------------------------------------------------------------------

  /**
   * Total audit-entry count + chain integrity flag.
   * Wraps `GET /v1/audit/count`.
   */
  async count(): Promise<Record<string, unknown>> {
    return this._get("/v1/audit/count");
  }

  /**
   * Filtered mutation-style audit projections. Wraps `GET /v1/audit/log`.
   * `from`/`to` are inclusive timestamp bounds, `table` a substring of the
   * derived resource; `tenantId` only applies to an unscoped admin caller.
   * Returns `{"entries": [...], "chain_valid": bool}`.
   */
  async log(
    opts: { limit?: number; from?: string; to?: string; table?: string; tenantId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const path = `/v1/audit/log${qs({
      limit: opts.limit ?? 100,
      from: opts.from,
      to: opts.to,
      table: opts.table,
      tenant_id: opts.tenantId,
    })}`;
    return this._get(path);
  }
}
