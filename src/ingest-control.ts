/**
 * Ingestion control plane: source checkpoints, data contracts, quarantine
 * (#5689, #5714).
 *
 * Wraps `GET /ingest/checkpoints/{source}`, `GET /ingest/contracts`,
 * `GET|PUT /ingest/contracts/{dataset}`, `GET /ingest/contracts/{dataset}/quality`,
 * `GET /ingest/quarantine` and `DELETE /ingest/quarantine/{id}`. These routes use
 * the data-plane credential and are scoped to the caller's tenant.
 */

import { RelataClient } from "./client.ts";
import { RelataError } from "./errors.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

const seg = (v: string): string => encodeURIComponent(v);

/** Ingestion control-plane client. */
export class IngestControlClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): IngestControlClient {
    return new IngestControlClient(TypedClientBase.clientToCtor(client));
  }

  /** `GET /ingest/checkpoints/{source}`: last durably committed checkpoint. */
  async checkpoint(source: string): Promise<Record<string, unknown>> {
    return this._get(`/ingest/checkpoints/${seg(source)}`);
  }

  /** `GET /ingest/contracts`: `{ contracts: [{ dataset, latest_version }] }`. */
  async listContracts(): Promise<Record<string, unknown>> {
    return this._get("/ingest/contracts");
  }

  /** `GET /ingest/contracts/{dataset}`: every retained contract version. */
  async getContract(dataset: string): Promise<Record<string, unknown>> {
    return this._get(`/ingest/contracts/${seg(dataset)}`);
  }

  /**
   * `PUT /ingest/contracts/{dataset}`: define the next contract version. The
   * server checks backward compatibility; `contract` is sent verbatim.
   */
  async putContract(dataset: string, contract: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._put(`/ingest/contracts/${seg(dataset)}`, contract);
  }

  /** `GET /ingest/contracts/{dataset}/quality`: validation counts, freshness, drift. */
  async contractQuality(dataset: string): Promise<Record<string, unknown>> {
    return this._get(`/ingest/contracts/${seg(dataset)}/quality`);
  }

  /**
   * `GET /ingest/quarantine`: a page of quarantined records. Pass the previous
   * page's `next_after_id` as `afterId` to continue.
   */
  async listQuarantine(
    opts: { dataset?: string; afterId?: number; limit?: number } = {},
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (opts.dataset !== undefined) params.set("dataset", opts.dataset);
    if (opts.afterId !== undefined) params.set("after_id", String(Math.trunc(opts.afterId)));
    if (opts.limit !== undefined) params.set("limit", String(Math.trunc(opts.limit)));
    const q = params.toString();
    return this._get(`/ingest/quarantine${q ? `?${q}` : ""}`);
  }

  /** `DELETE /ingest/quarantine/{id}`: discard one record (404 when unknown). */
  async deleteQuarantine(id: number): Promise<void> {
    const response = await this._sendBytes("DELETE", `/ingest/quarantine/${Math.trunc(id)}`);
    if (response.status !== 204) {
      throw new RelataError(
        `Quarantine DELETE expected HTTP 204, got ${response.status}`,
        response.status,
        "Unexpected quarantine response",
      );
    }
  }
}
