/**
 * Media work hand-off for OpenETL (`/v1/media/work`, #5938).
 *
 * Lease items with {@link MediaWorkClient.claim}, keep the lease with
 * {@link MediaWorkClient.heartbeat}, write extracted rows through
 * `IngestClient.bulk(..., { sourceCheckpoint, mediaWorkClaim })`, then
 * acknowledge with {@link MediaWorkClient.complete} or
 * {@link MediaWorkClient.fail}. Completion succeeds only when the batch and
 * child counts equal what Relata durably holds.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

/** Header every bulk write-back for an `openetl/media/<work_id>` source must carry. */
export const MEDIA_WORK_CLAIM_HEADER = "X-Relata-Claim";

const STATES = ["queued", "claimed", "writing", "completed", "dead_letter", "cancelled"] as const;

/** Work item lifecycle states accepted by {@link MediaWorkClient.list}. */
export type MediaWorkState = (typeof STATES)[number];

/** `X-Relata-Claim` header for a raw `POST /v1/ingest/bulk` write-back. */
export function mediaWorkClaimHeaders(claimId: number): Record<string, string> {
  return { [MEDIA_WORK_CLAIM_HEADER]: String(Math.trunc(claimId)) };
}

const item = (workId: string, suffix = ""): string =>
  `/v1/media/work/${encodeURIComponent(workId)}${suffix}`;

/** Media work client. */
export class MediaWorkClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): MediaWorkClient {
    return new MediaWorkClient(TypedClientBase.clientToCtor(client));
  }

  /** `GET /v1/media/work`: the tenant's work items, optionally filtered by state. */
  async list(opts: { state?: MediaWorkState; limit?: number } = {}): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (opts.state !== undefined) {
      if (!STATES.includes(opts.state)) throw new Error(`state must be one of ${STATES.join(", ")}`);
      params.set("state", opts.state);
    }
    if (opts.limit !== undefined) params.set("limit", String(Math.trunc(opts.limit)));
    const q = params.toString();
    return this._get<Record<string, unknown>>(`/v1/media/work${q ? `?${q}` : ""}`);
  }

  /** `GET /v1/media/work/{id}`: durable status; 404 when unknown. */
  async get(workId: string): Promise<Record<string, unknown>> {
    return this._get<Record<string, unknown>>(item(workId));
  }

  /**
   * `POST /v1/media/work/claim`: lease up to `maxItems` items (`{ items: [...] }`).
   * An empty list means nothing is deliverable now (no long poll).
   */
  async claim(
    claimant: string,
    opts: { maxItems?: number; leaseMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { claimant };
    if (opts.maxItems !== undefined) body["max_items"] = Math.trunc(opts.maxItems);
    if (opts.leaseMs !== undefined) body["lease_ms"] = Math.trunc(opts.leaseMs);
    return this._post<Record<string, unknown>>("/v1/media/work/claim", body);
  }

  /** `POST /v1/media/work/{id}/heartbeat`: extend the lease (409 once it lapsed). */
  async heartbeat(
    workId: string,
    claimId: number,
    opts: { leaseMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { claim_id: Math.trunc(claimId) };
    if (opts.leaseMs !== undefined) body["lease_ms"] = Math.trunc(opts.leaseMs);
    return this._post<Record<string, unknown>>(item(workId, "/heartbeat"), body);
  }

  /** `POST /v1/media/work/{id}/complete`: 409 when counts differ from what is stored. */
  async complete(
    workId: string,
    claimId: number,
    opts: { producerVersion: string; batches: number; children: number },
  ): Promise<Record<string, unknown>> {
    return this._post<Record<string, unknown>>(item(workId, "/complete"), {
      claim_id: Math.trunc(claimId),
      producer_version: opts.producerVersion,
      batches: Math.trunc(opts.batches),
      children: Math.trunc(opts.children),
    });
  }

  /** `POST /v1/media/work/{id}/fail`: `retryable` is redelivered, `permanent` dead-letters. */
  async fail(
    workId: string,
    claimId: number,
    opts: { failureClass: "retryable" | "permanent"; code?: string; detail?: string },
  ): Promise<Record<string, unknown>> {
    if (opts.failureClass !== "retryable" && opts.failureClass !== "permanent") {
      throw new Error("failureClass must be 'retryable' or 'permanent'");
    }
    const body: Record<string, unknown> = { claim_id: Math.trunc(claimId), class: opts.failureClass };
    if (opts.code !== undefined) body["code"] = opts.code;
    if (opts.detail !== undefined) body["detail"] = opts.detail;
    return this._post<Record<string, unknown>>(item(workId, "/fail"), body);
  }

  /**
   * `POST /v1/media/work/{id}/requeue`: return an item to the queue (for example a
   * dead-lettered one) so it is delivered again.
   */
  async requeue(workId: string): Promise<Record<string, unknown>> {
    return this._post<Record<string, unknown>>(item(workId, "/requeue"), {});
  }
}
