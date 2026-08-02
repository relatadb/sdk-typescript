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

// ── CDR ingest helpers (#2252) ─────────────────────────────────────────────────

// Canonical CDR column → accepted aliases (mirrors the server's
// `CdrRecord::from_csv_row` header recognition, case-insensitive server-side).
const CDR_ALIASES: Record<string, readonly string[]> = {
  caller: ["caller", "caller_msisdn", "a_number", "a_msisdn"],
  callee: ["callee", "callee_msisdn", "b_number", "b_msisdn", "called"],
  start: ["start", "call_start", "start_time", "timestamp", "call_start_ns"],
  duration: ["duration", "duration_secs", "duration_seconds"],
  tower: ["tower", "tower_id", "cell_id", "site", "cell"],
  type: ["type", "call_type", "record_type"],
};
const CDR_COLUMNS = ["caller", "callee", "start", "duration", "tower", "type"] as const;

/** Render a CDR cell value — the server parses CSV via naive split(','). */
function cdrField(value: unknown): string {
  if (value === null || value === undefined) return "";
  // Strip commas / CR / LF so a value can never break column alignment.
  return String(value).replace(/,/g, "").replace(/[\r\n]/g, " ");
}

/** Serialise typed CDR rows into the CSV shape `POST /ingest/cdr` expects. */
function rowsToCdrCsv(rows: RelataRow[]): string {
  const lines: string[] = [CDR_COLUMNS.join(",")];
  for (const row of rows) {
    const fields = CDR_COLUMNS.map((col) => {
      for (const key of CDR_ALIASES[col] ?? []) {
        if (key in row) return cdrField(row[key]);
      }
      return "";
    });
    lines.push(fields.join(","));
  }
  return lines.join("\n");
}

/** Options inherited from the parent client. */
export interface IngestClientCtor extends TypedClientCtor {
  /** Default purpose attached to ingest calls when not overridden per-call. */
  purpose?: string;
  /** Tenant / `X-Relata-Tenant-Id`. */
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

  /** @internal Build a path carrying only the (optional) `purpose` param. */
  private purposePath(base: string, purposeOverride: string | undefined): string {
    const effPurpose = purposeOverride ?? this.#purpose;
    return effPurpose === undefined ? base : `${base}${qs({ purpose: effPurpose })}`;
  }

  /** @internal X-Detect-Packs header for a per-call SmartIngest override (#2258). */
  #detectHeader(detectPacks: string | undefined): Record<string, string> | undefined {
    return detectPacks && detectPacks !== ""
      ? { "X-Detect-Packs": detectPacks }
      : undefined;
  }

  /**
   * Bulk-ingest `rows` as NDJSON.
   * Wraps `POST /ingest?object_type=<Type>` with an
   * `Content-Type: application/x-ndjson` body.
   *
   * Per-call controls (opts):
   * - `detectPacks` — SmartIngest detector-pack override (#2258 SI-3), sent as
   *   the `X-Detect-Packs` header. `"none"` disables SmartIngest for this call;
   *   a comma-separated list (e.g. `"network,financial"`) selects packs.
   *   Requires the `IngestDetectOverride` ACL grant server-side.
   * - `onConflict` — when set (`"upsert" | "skip" | "error"`), routes the call
   *   to `POST /ingest/bulk` so conflict resolution + `tenantId` take effect.
   * - `tenantId` — tenant scope (only honoured on the `/ingest/bulk` door).
   */
  async bulk(
    objectType: string,
    rows: RelataRow[],
    opts: {
      purpose?: string;
      detectPacks?: string;
      onConflict?: "upsert" | "skip" | "error";
      tenantId?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (opts.onConflict !== undefined) {
      // Route to /ingest/bulk so on_conflict + tenant_id take effect.
      const objects = rows.map((r) => ({ _type: objectType, ...r }));
      const body: Record<string, unknown> = {
        objects,
        on_conflict: opts.onConflict,
      };
      const purpose = opts.purpose ?? this.#purpose;
      if (purpose !== undefined) body["purpose"] = purpose;
      if (opts.tenantId !== undefined) body["tenant_id"] = opts.tenantId;
      return this._sendRaw(
        "POST",
        "/ingest/bulk",
        JSON.stringify(body),
        "application/json",
        this.#detectHeader(opts.detectPacks),
      );
    }
    const body = rows.map((r) => JSON.stringify(r)).join("\n");
    return this._sendRaw(
      "POST",
      this.paramsPath(objectType, opts.purpose),
      body,
      "application/x-ndjson",
      this.#detectHeader(opts.detectPacks),
    );
  }

  /**
   * Bulk-ingest a CSV string. The server parses it server-side.
   * Wraps `POST /ingest?object_type=<Type>` with a `text/csv` body. Honours
   * `detectPacks` via the `X-Detect-Packs` header (#2258 SI-3).
   */
  async bulkCsv(
    objectType: string,
    csvText: string,
    opts: { purpose?: string; detectPacks?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this._sendRaw(
      "POST",
      this.paramsPath(objectType, opts.purpose),
      csvText,
      "text/csv",
      this.#detectHeader(opts.detectPacks),
    );
  }

  /**
   * Schemaless ingest — auto-create the type on first write with inferred
   * fields (T6, #1988). Wraps `POST /ingest/auto`. The response carries
   * `type_created` and `inferred_schema`. Optional `schema` overrides
   * field-type inference, `tenantId` scopes the write.
   */
  async ingestAuto(
    objectType: string,
    rows: RelataRow[],
    opts: {
      schema?: Record<string, string>;
      tenantId?: string;
      purpose?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { object_type: objectType, rows };
    const purpose = opts.purpose ?? this.#purpose;
    if (purpose !== undefined) body["purpose"] = purpose;
    if (opts.schema) body["schema"] = opts.schema;
    if (opts.tenantId !== undefined) body["tenant_id"] = opts.tenantId;
    return this._post("/ingest/auto", body);
  }

  /**
   * Ingest CDR (call detail records) via `POST /ingest/cdr` (#2252).
   *
   * Each row maps CDR fields (`caller`, `callee`, `start`, `duration`, `tower`,
   * `type`); common aliases like `caller_msisdn`/`a_number` are accepted. Rows
   * are serialised to the CSV shape the server's `CdrBatch::from_csv` expects.
   * `purpose` is mandatory server-side — pass it here or via the client default.
   */
  async ingestCdr(
    rows: RelataRow[],
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const csv = rowsToCdrCsv(rows);
    return this._sendRaw(
      "POST",
      this.purposePath("/ingest/cdr", opts.purpose),
      csv,
      "text/csv",
    );
  }

  /** Ingest OTLP/JSON traces via `POST /v1/traces` (#2252). */
  async otlpTraces(
    payload: Record<string, unknown>,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this._post(this.purposePath("/v1/traces", opts.purpose), payload);
  }

  /** Ingest OTLP/JSON logs via `POST /v1/logs` (#2252). */
  async otlpLogs(
    payload: Record<string, unknown>,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this._post(this.purposePath("/v1/logs", opts.purpose), payload);
  }

  /** Ingest OTLP/JSON metrics via `POST /v1/metrics` (#2252). */
  async otlpMetrics(
    payload: Record<string, unknown>,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this._post(this.purposePath("/v1/metrics", opts.purpose), payload);
  }

  /**
   * Poll the status of a multipart media upload (paired with #76).
   * Wraps `GET /ingest/media/:taskId`.
   */
  async mediaStatus(taskId: string): Promise<Record<string, unknown>> {
    return this._get(`/ingest/media/${encodeURIComponent(taskId)}`);
  }
}
