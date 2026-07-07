/**
 * Object store SDK (#82) — general state-object upsert + load surface.
 *
 * The server's universal upsert path is `POST /ingest?object_type=<Type>`;
 * this module wraps it as a typed `ObjectClient` so TypeScript callers don't
 * have to know the ingest envelope shape.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase, qs } from "./_typed-http.ts";

/** Row shape accepted by `upsert` / `batchUpssert`. */
export type RelataRow = Record<string, unknown>;

/** Serialise `rows` as newline-delimited JSON — one row per line. */
function rowsToNdjson(rows: RelataRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

/** Options inherited from the parent client. */
export interface ObjectClientCtor extends TypedClientCtor {
  /** Default purpose attached to ingest calls when not overridden per-call. */
  purpose?: string;
  /** Tenant / `X-Organization-Id`. */
  tenant?: string;
}

/** Typed upsert/load client for state objects. */
export class ObjectClient extends TypedClientBase {
  readonly #purpose: string | undefined;
  readonly #tenant: string | undefined;

  constructor(opts: ObjectClientCtor) {
    super(opts);
    this.#purpose = opts.purpose;
    this.#tenant = opts.tenant;
  }

  /** Inherit the parent client's auth, purpose, tenant, and headers. */
  static fromClient(client: RelataClient): ObjectClient {
    const ctor = TypedClientBase.clientToCtor(client);
    const objectCtor: ObjectClientCtor = { ...ctor };
    if (client.defaultPurpose !== undefined) {
      objectCtor.purpose = client.defaultPurpose;
    }
    if (client.tenant !== undefined) objectCtor.tenant = client.tenant;
    return new ObjectClient(objectCtor);
  }

  /**
   * Upsert a single state object. The `objectId` becomes the row's primary
   * key; re-upserting with the same id supersedes bi-temporally.
   * Wraps `POST /ingest?object_type=<Type>` with an NDJSON body.
   *
   * @returns The server's upsert receipt
   *          (`object_id`, `write_seq`, `valid_from`).
   */
  async upsert(
    objectType: string,
    objectId: string,
    fields: RelataRow,
    opts: { purpose?: string; source?: string } = {},
  ): Promise<Record<string, unknown>> {
    const row: RelataRow = { ...fields, id: objectId };
    if (opts.source !== undefined) row["_source"] = opts.source;
    return this.sendNdjson(objectType, [row], opts.purpose);
  }

  /**
   * Bulk upsert. Each row must carry its own `id` key.
   * Wraps `POST /ingest?object_type=<Type>` with an NDJSON body.
   *
   * @returns The bulk receipt
   *          (`accepted`, `rejected`, `write_seq`, `queue_depth`).
   */
  async batchUpsert(
    objectType: string,
    rows: RelataRow[],
    opts: { purpose?: string; source?: string } = {},
  ): Promise<Record<string, unknown>> {
    const prepared = opts.source !== undefined
      ? rows.map((r) => ({ ...r, _source: opts.source }))
      : rows;
    return this.sendNdjson(objectType, prepared, opts.purpose);
  }

  /** @internal Build the query string and POST the NDJSON body. */
  private async sendNdjson(
    objectType: string,
    rows: RelataRow[],
    purposeOverride: string | undefined,
  ): Promise<Record<string, unknown>> {
    const effPurpose = purposeOverride ?? this.#purpose;
    const path = `/ingest${qs({
      object_type: objectType,
      purpose: effPurpose,
    })}`;
    return this._sendRaw("POST", path, rowsToNdjson(rows), "application/x-ndjson");
  }
}
