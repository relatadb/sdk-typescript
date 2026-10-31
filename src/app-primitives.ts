/**
 * Application primitives SDK (#5768, #5783): atomic sequences and a durable
 * job queue.
 *
 * A claim returns a fencing token; `renew`/`complete`/`fail` must present it,
 * and a stale token is rejected with 409.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

/** Options for {@link AppPrimitivesClient.enqueue}. */
export interface EnqueueOptions {
  priority?: number;
  runAt?: string | number;
  delayMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  idempotencyKey?: string;
}

function defined(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
}

/** Sequences and durable job queue client. */
export class AppPrimitivesClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): AppPrimitivesClient {
    return new AppPrimitivesClient(TypedClientBase.clientToCtor(client));
  }

  /** Allocate `count` (default 1) contiguous values. Wraps `POST /v1/sequences/:name/next`. */
  async sequenceNext(
    name: string,
    opts: { count?: number; idempotencyKey?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this._post(`/v1/sequences/${encodeURIComponent(name)}/next`, defined({ ...opts }));
  }

  /** Return the value the next allocation would start at. Wraps `GET /v1/sequences/:name`. */
  async sequenceGet(name: string): Promise<Record<string, unknown>> {
    return this._get(`/v1/sequences/${encodeURIComponent(name)}`);
  }

  /** Enqueue a job. Wraps `POST /v1/queues/:name/jobs`. */
  async enqueue(
    queue: string,
    payload: unknown,
    opts: EnqueueOptions = {},
  ): Promise<Record<string, unknown>> {
    return this._post(
      `/v1/queues/${encodeURIComponent(queue)}/jobs`,
      defined({ payload: payload ?? null, ...opts }),
    );
  }

  /** Lease up to `max` ready jobs. Wraps `POST /v1/queues/:name/claim`. */
  async claim(
    queue: string,
    workerId: string,
    opts: { leaseMs?: number; max?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const resp = await this._post<{ jobs?: Array<Record<string, unknown>> }>(
      `/v1/queues/${encodeURIComponent(queue)}/claim`,
      defined({ workerId, ...opts }),
    );
    return resp.jobs ?? [];
  }

  /** Extend a held lease. Wraps `POST /v1/jobs/:id/renew`. */
  async renew(
    jobId: string,
    fencingToken: number,
    opts: { leaseMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this._post(`/v1/jobs/${encodeURIComponent(jobId)}/renew`, defined({ fencingToken, ...opts }));
  }

  /** Mark a held job done. Wraps `POST /v1/jobs/:id/complete`. */
  async complete(
    jobId: string,
    fencingToken: number,
    opts: { result?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    return this._post(`/v1/jobs/${encodeURIComponent(jobId)}/complete`, defined({ fencingToken, ...opts }));
  }

  /** Report failure. Wraps `POST /v1/jobs/:id/fail`. */
  async fail(
    jobId: string,
    fencingToken: number,
    opts: { error?: string; retryAfterMs?: number; retryable?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    return this._post(`/v1/jobs/${encodeURIComponent(jobId)}/fail`, defined({ fencingToken, ...opts }));
  }

  /** Inspect a queue. Wraps `GET /v1/queues/:name/jobs`. */
  async listJobs(
    queue: string,
    opts: { state?: string; limit?: number } = {},
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (opts.state !== undefined) params.set("state", opts.state);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return this._get(`/v1/queues/${encodeURIComponent(queue)}/jobs${qs ? `?${qs}` : ""}`);
  }

  /** Fetch one job. Wraps `GET /v1/queues/:name/jobs/:id`. */
  async getJob(queue: string, jobId: string): Promise<Record<string, unknown>> {
    return this._get(`/v1/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(jobId)}`);
  }
}
