/**
 * Tenants SDK — the caller's own tenant record.
 *
 * Wraps `GET /v1/tenants/me`. Tenant administration (create / suspend /
 * quota / sharing / platform usage) is an Enterprise capability and is not
 * part of the public SDK.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

/** Tenants client — introspect the caller's own tenant. */
export class TenantAdminClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): TenantAdminClient {
    return new TenantAdminClient(TypedClientBase.clientToCtor(client));
  }

  /** Return the caller's own tenant record. Wraps `GET /v1/tenants/me`. */
  async me(): Promise<Record<string, unknown>> {
    return this._get("/v1/tenants/me");
  }
}
