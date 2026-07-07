/**
 * Tenant admin SDK (#73 — completes the tenant surface).
 *
 * Wraps `/tenants/*` and `/platform/tenants/*` so a TypeScript operator can
 * provision, suspend, reactivate, quota-manage, and configure sharing
 * agreements for tenants from code.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

/** Tenant-admin client — CRUD + quota + sharing. */
export class TenantAdminClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): TenantAdminClient {
    return new TenantAdminClient(TypedClientBase.clientToCtor(client));
  }

  // -------------------------------------------------------------------------
  // Tenant introspection
  // -------------------------------------------------------------------------

  /** Return the caller's own tenant record. Wraps `GET /tenants/me`. */
  async me(): Promise<Record<string, unknown>> {
    return this._get("/tenants/me");
  }

  /** Return the caller's tenant usage. Wraps `GET /tenants/usage`. */
  async usage(): Promise<Record<string, unknown>> {
    return this._get("/tenants/usage");
  }

  // -------------------------------------------------------------------------
  // Tenant CRUD (platform admin)
  // -------------------------------------------------------------------------

  /**
   * Provision a new tenant. Wraps `POST /platform/tenants`.
   *
   * @param tenantId Caller-chosen tenant identifier.
   * @param tier     Tier (`"standard"` default).
   * @param fields   Additional fields forwarded to the server.
   */
  async create(
    tenantId: string,
    opts: {
      tier?: string;
      fields?: Record<string, unknown>;
    } = {},
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      tenant_id: tenantId,
      tier: opts.tier ?? "standard",
      ...(opts.fields ?? {}),
    };
    return this._post("/platform/tenants", payload);
  }

  /** Get a tenant's details. Wraps `GET /platform/tenants/:id`. */
  async get(tenantId: string): Promise<Record<string, unknown>> {
    return this._get(`/platform/tenants/${encodeURIComponent(tenantId)}`);
  }

  /** Delete a tenant. Wraps `DELETE /platform/tenants/:id`. */
  async delete(tenantId: string): Promise<Record<string, unknown>> {
    return this._delete(`/platform/tenants/${encodeURIComponent(tenantId)}`);
  }

  /** Change a tenant's tier. Wraps `PATCH /platform/tenants/:id/tier`. */
  async setTier(
    tenantId: string,
    tier: string,
  ): Promise<Record<string, unknown>> {
    return this._patch(
      `/platform/tenants/${encodeURIComponent(tenantId)}/tier`,
      { tier },
    );
  }

  /** Suspend a tenant. Wraps `POST /platform/tenants/:id/suspend`. */
  async suspend(tenantId: string): Promise<Record<string, unknown>> {
    return this._post(
      `/platform/tenants/${encodeURIComponent(tenantId)}/suspend`,
      {},
    );
  }

  /** Reactivate a suspended tenant. Wraps `POST /platform/tenants/:id/reactivate`. */
  async reactivate(tenantId: string): Promise<Record<string, unknown>> {
    return this._post(
      `/platform/tenants/${encodeURIComponent(tenantId)}/reactivate`,
      {},
    );
  }

  // -------------------------------------------------------------------------
  // Per-tenant quota + usage
  // -------------------------------------------------------------------------

  /** Set the cost-unit quota for a tenant. Wraps `PUT /tenants/:id/quota`. */
  async setQuota(
    tenantId: string,
    quota: number,
  ): Promise<Record<string, unknown>> {
    return this._put(
      `/tenants/${encodeURIComponent(tenantId)}/quota`,
      { quota },
    );
  }

  /** Get a specific tenant's usage. Wraps `GET /tenants/:id/usage`. */
  async tenantUsage(
    tenantId: string,
  ): Promise<Record<string, unknown>> {
    return this._get(`/tenants/${encodeURIComponent(tenantId)}/usage`);
  }

  // -------------------------------------------------------------------------
  // Sharing agreements (ADR-132)
  // -------------------------------------------------------------------------

  /**
   * List the sharing agreements for a tenant.
   * Wraps `GET /tenants/:id/sharing`.
   */
  async listSharing(
    tenantId: string,
  ): Promise<Record<string, unknown>[]> {
    const data = await this._get<Record<string, unknown>>(
      `/tenants/${encodeURIComponent(tenantId)}/sharing`,
    );
    const agreements =
      typeof data === "object" && data !== null && Array.isArray(data["agreements"])
        ? data["agreements"]
        : Array.isArray(data)
          ? data
          : [];
    return agreements as Record<string, unknown>[];
  }

  /**
   * Register a `SharingAgreement` so `tenantId` can read
   * `partnerTenant`'s rows of `objectType` (ADR-132 cross-org reads).
   * Wraps `POST /tenants/:id/sharing`.
   */
  async createSharing(
    tenantId: string,
    partnerTenant: string,
    opts: {
      objectType: string;
      action?: string;
      expiresNs?: number;
    },
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      partner_tenant: partnerTenant,
      object_type: opts.objectType,
      action: opts.action ?? "read",
    };
    if (opts.expiresNs !== undefined) payload["expires_ns"] = opts.expiresNs;
    return this._post(
      `/tenants/${encodeURIComponent(tenantId)}/sharing`,
      payload,
    );
  }

  // -------------------------------------------------------------------------
  // Platform-wide
  // -------------------------------------------------------------------------

  /** Return platform-wide usage (all tenants). Wraps `GET /platform/usage`. */
  async platformUsage(): Promise<Record<string, unknown>> {
    return this._get("/platform/usage");
  }

  /** Return the platform license info (tier, max_tenants, expiry). */
  async platformLicense(): Promise<Record<string, unknown>> {
    return this._get("/platform/license");
  }
}
