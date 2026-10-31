/**
 * System / runtime SDK — jobs status and operator surfaces.
 *
 * Covers generic runtime administration. Model-provider configuration and
 * completion callbacks are application-owned.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

/** System / runtime client for generic operator surfaces. */
export class SystemClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): SystemClient {
    return new SystemClient(TypedClientBase.clientToCtor(client));
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  /**
   * Return the status of every background job (continuous-pattern
   * detectors, MV refresh, embedder worker, orphan-blob sweep, ...).
   * Wraps `GET /v1/jobs`.
   */
  async jobsStatus(): Promise<Record<string, unknown>> {
    return this._get("/v1/jobs");
  }

  /** Status of a single background job by name. Wraps `GET /v1/jobs/:name`. */
  async jobStatus(name: string): Promise<Record<string, unknown>> {
    return this._get(`/v1/jobs/${encodeURIComponent(name)}`);
  }

  // ── notifications ──────────────────────────────────────────────────────────

  /**
   * List notification rules (`GET /v1/notification-rules`). Webhook delivery
   * is a channel of a notification rule: set `webhook_url` (and optionally
   * `webhook_headers`) on the rule instead of registering a webhook.
   */
  async notificationRules(): Promise<Record<string, unknown>[]> {
    const data = await this._get<Record<string, unknown>>('/v1/notification-rules');
    return Array.isArray(data) ? data : ((data["rules"] as Record<string, unknown>[]) ?? []);
  }

  /**
   * Create a notification rule (`POST /v1/notification-rules`). Include
   * `webhook_url` / `webhook_headers` to deliver via webhook.
   */
  async createNotificationRule(rule: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._post('/v1/notification-rules', rule);
  }

  async deleteNotificationRule(id: string): Promise<Record<string, unknown>> {
    return this._delete(`/v1/notification-rules/${encodeURIComponent(id)}`);
  }
}
