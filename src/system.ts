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
   * Wraps `GET /jobs`.
   */
  async jobsStatus(): Promise<Record<string, unknown>> {
    return this._get("/jobs");
  }

  /** Status of a single background job by name. Wraps `GET /jobs/:name`. */
  async jobStatus(name: string): Promise<Record<string, unknown>> {
    return this._get(`/jobs/${encodeURIComponent(name)}`);
  }

  // ── feed ───────────────────────────────────────────────────────────────────

  async feedHealth(): Promise<Record<string, unknown>> {
    return this._get('/feed/health');
  }

  /** List available RIFN feed channels. Wraps `GET /feed/channels`. */
  async feedChannels(): Promise<Record<string, unknown>> {
    return this._get('/feed/channels');
  }

  async feedPublish(channel: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._post('/feed/publish', { channel, payload });
  }

  // ── notifications ──────────────────────────────────────────────────────────

  async notificationRules(): Promise<Record<string, unknown>[]> {
    const data = await this._get<Record<string, unknown>>('/notifications/rules');
    return Array.isArray(data) ? data : ((data["rules"] as Record<string, unknown>[]) ?? []);
  }

  async createNotificationRule(rule: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._post('/notifications/rules', rule);
  }

  async deleteNotificationRule(id: string): Promise<Record<string, unknown>> {
    return this._delete(`/notifications/rules/${encodeURIComponent(id)}`);
  }

  // ── pipelines ──────────────────────────────────────────────────────────────

  async listPipelines(): Promise<Record<string, unknown>[]> {
    const data = await this._get<Record<string, unknown>>('/pipelines');
    return Array.isArray(data) ? data : ((data["pipelines"] as Record<string, unknown>[]) ?? []);
  }

  async definePipeline(definition: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._post('/pipelines', definition);
  }
}
