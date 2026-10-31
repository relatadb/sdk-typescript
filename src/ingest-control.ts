/**
 * Ingestion control plane: source checkpoints, data contracts, quarantine
 * (#5689, #5714).
 *
 * Wraps `GET /v1/ingest/checkpoints/{source}`, `GET /v1/ingest/contracts`,
 * `GET|PUT /v1/ingest/contracts/{dataset}`, `GET /v1/ingest/contracts/{dataset}/quality`,
 * `GET /v1/ingest/quarantine` and `DELETE /v1/ingest/quarantine/{id}`. These routes use
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

  /** `GET /v1/ingest/checkpoints/{source}`: last durably committed checkpoint. */
  async checkpoint(source: string): Promise<Record<string, unknown>> {
    return this._get(`/v1/ingest/checkpoints/${seg(source)}`);
  }

  /** `GET /v1/ingest/contracts`: `{ contracts: [{ dataset, latest_version }] }`. */
  async listContracts(): Promise<Record<string, unknown>> {
    return this._get("/v1/ingest/contracts");
  }

  /** `GET /v1/ingest/contracts/{dataset}`: every retained contract version. */
  async getContract(dataset: string): Promise<Record<string, unknown>> {
    return this._get(`/v1/ingest/contracts/${seg(dataset)}`);
  }

  /**
   * `PUT /v1/ingest/contracts/{dataset}`: define the next contract version. The
   * server checks backward compatibility; `contract` is sent verbatim.
   */
  async putContract(dataset: string, contract: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._put(`/v1/ingest/contracts/${seg(dataset)}`, contract);
  }

  /** `GET /v1/ingest/contracts/{dataset}/quality`: validation counts, freshness, drift. */
  async contractQuality(dataset: string): Promise<Record<string, unknown>> {
    return this._get(`/v1/ingest/contracts/${seg(dataset)}/quality`);
  }

  /**
   * `GET /v1/ingest/quarantine`: a page of quarantined records. Pass the previous
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
    return this._get(`/v1/ingest/quarantine${q ? `?${q}` : ""}`);
  }

  /** `DELETE /v1/ingest/quarantine/{id}`: discard one record (404 when unknown). */
  async deleteQuarantine(id: number): Promise<void> {
    const response = await this._sendBytes("DELETE", `/v1/ingest/quarantine/${Math.trunc(id)}`);
    if (response.status !== 204) {
      throw new RelataError(
        `Quarantine DELETE expected HTTP 204, got ${response.status}`,
        response.status,
        "Unexpected quarantine response",
      );
    }
  }
}
