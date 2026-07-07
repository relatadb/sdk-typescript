/**
 * Bulk ingest SDK (#83).
 *
 * Surfaces the server's `POST /ingest?object_type=<Type>` for NDJSON / CSV
 * batches. Distinct from `RelataClient.ingestDocument` which is the
 * datagrep-extractor envelope; this module is the general batch path the
 * partner contract (§4) calls for.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase, qs } from "./_typed-http.ts";

/** Row shape accepted by `bulk`. */
export type RelataRow = Record<string, unknown>;

/** Options inherited from the parent client. */
export interface IngestClientCtor extends TypedClientCtor {
  /** Default purpose attached to ingest calls when not overridden per-call. */
  purpose?: string;
  /** Tenant / `X-Organization-Id`. */
  tenant?: string;
}

/** Bulk-ingest client. */
export class IngestClient extends TypedClientBase {
  readonly #purpose: string | undefined;
  readonly #tenant: string | undefined;

  constructor(opts: IngestClientCtor) {
    super(opts);
    this.#purpose = opts.purpose;
    this.#tenant = opts.tenant;
  }

  /** Inherit the parent client's auth, purpose, tenant, and headers. */
  static fromClient(client: RelataClient): IngestClient {
    const ctor = TypedClientBase.clientToCtor(client);
    const ingestCtor: IngestClientCtor = { ...ctor };
    if (client.defaultPurpose !== undefined) {
      ingestCtor.purpose = client.defaultPurpose;
    }
    if (client.tenant !== undefined) ingestCtor.tenant = client.tenant;
    return new IngestClient(ingestCtor);
  }

  /** @internal Build the query string for an ingest call. */
  private paramsPath(
    objectType: string,
    purposeOverride: string | undefined,
  ): string {
    const effPurpose = purposeOverride ?? this.#purpose;
    return `/ingest${qs({ object_type: objectType, purpose: effPurpose })}`;
  }

  /**
   * Bulk-ingest `rows` as NDJSON.
   * Wraps `POST /ingest?object_type=<Type>` with an
   * `Content-Type: application/x-ndjson` body.
   */
  async bulk(
    objectType: string,
    rows: RelataRow[],
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const body = rows.map((r) => JSON.stringify(r)).join("\n");
    return this._sendRaw(
      "POST",
      this.paramsPath(objectType, opts.purpose),
      body,
      "application/x-ndjson",
    );
  }

  /**
   * Bulk-ingest a CSV string. The server parses it server-side.
   * Wraps `POST /ingest?object_type=<Type>` with a `text/csv` body.
   */
  async bulkCsv(
    objectType: string,
    csvText: string,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this._sendRaw(
      "POST",
      this.paramsPath(objectType, opts.purpose),
      csvText,
      "text/csv",
    );
  }

  /**
   * Poll the status of a multipart media upload (paired with #76).
   * Wraps `GET /ingest/media/:taskId`.
   */
  async mediaStatus(taskId: string): Promise<Record<string, unknown>> {
    return this._get(`/ingest/media/${encodeURIComponent(taskId)}`);
  }
}
