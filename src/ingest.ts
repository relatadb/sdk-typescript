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

// Canonical CDR field → accepted input aliases. CDR normalization is an
// application adapter; the server accepts the canonical row via generic ingest.
const CDR_ALIASES: Record<string, readonly string[]> = {
  caller: ["caller", "caller_msisdn", "a_number", "a_msisdn"],
  callee: ["callee", "callee_msisdn", "b_number", "b_msisdn", "called"],
  start: ["start", "call_start", "start_time", "timestamp", "call_start_ns"],
  duration: ["duration", "duration_secs", "duration_seconds"],
  tower: ["tower", "tower_id", "cell_id", "site", "cell"],
  type: ["type", "call_type", "record_type"],
};
function cdrValue(row: RelataRow, aliases: readonly string[]): unknown {
  const values = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of aliases) if (values.has(key)) return values.get(key);
  return undefined;
}

function cdrInteger(value: unknown, name: string, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} '' is not an integer`);
  }
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) throw new Error(`${name} '${text}' is not an integer`);
  const result = Number(text);
  if (!Number.isSafeInteger(result)) throw new Error(`${name} '${text}' is outside JavaScript's safe integer range`);
  return result;
}

function cdrTimestamp(value: unknown, fallbackNs: bigint): bigint {
  const raw = value === undefined || value === null
    ? fallbackNs
    : BigInt(String(value).trim());
  const ns = raw < 10_000_000_000_000n ? raw * 1_000_000_000n : raw;
  if (ns < -(1n << 63n) || ns > (1n << 63n) - 1n) throw new Error(`call_start '${raw}': value out of range for i64`);
  return ns;
}

function cdrJsonLine(row: RelataRow): string {
  const fields = Object.entries(row).map(([key, value]) =>
    `${JSON.stringify(key)}:${typeof value === "bigint" ? value.toString() : JSON.stringify(value)}`
  );
  return `{${fields.join(",")}}`;
}

function cdrMetadata(row: RelataRow, normalized: RelataRow): void {
  for (const field of ["_pk", "id"] as const) {
    const value = cdrValue(row, [field]);
    if (value !== undefined && value !== null) normalized[field] = value;
  }
  const sourceFileId = cdrValue(row, ["source_file_id"]);
  if (sourceFileId !== undefined && sourceFileId !== null) {
    normalized["source_file_id"] = sourceFileId;
  }
}

function normalizeCdrRows(rows: RelataRow[]): { rows: RelataRow[]; errors: RelataRow[] } {
  const normalized: RelataRow[] = [];
  const errors: RelataRow[] = [];
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  rows.forEach((row, index) => {
    try {
      const callerRaw = cdrValue(row, CDR_ALIASES["caller"] ?? []);
      const calleeRaw = cdrValue(row, CDR_ALIASES["callee"] ?? []);
      const callerDigits = String(callerRaw ?? "").replace(/[^0-9]/g, "");
      const calleeDigits = String(calleeRaw ?? "").replace(/[^0-9]/g, "");
      if (callerDigits.length > 15) throw new Error(`caller_msisdn '${callerRaw}': too many digits (max 15 for E.164)`);
      if (calleeDigits.length > 15) throw new Error(`callee_msisdn '${calleeRaw}': too many digits (max 15 for E.164)`);
      const start = cdrTimestamp(cdrValue(row, CDR_ALIASES["start"] ?? []), nowNs);
      const duration = cdrInteger(cdrValue(row, CDR_ALIASES["duration"] ?? []), "duration", 0);
      if (duration < 0 || duration > 0xffff_ffff) throw new Error(`duration '${duration}': value out of range for u32`);
      const type = String(cdrValue(row, CDR_ALIASES["type"] ?? []) ?? "").trim().toLowerCase();
      const callType = ({ voice: "voice", call: "voice", "0": "voice", sms: "sms", mms: "sms", "1": "sms", data: "data", gprs: "data", "2": "data" } as Record<string, string>)[type] ?? "unknown";
      const normalizedRow: RelataRow = {
        caller_msisdn: cdrInteger(callerDigits, "caller_msisdn"),
        callee_msisdn: cdrInteger(calleeDigits, "callee_msisdn"),
        call_start_ns: start,
        duration_secs: duration,
        tower_id: String(cdrValue(row, CDR_ALIASES["tower"] ?? []) ?? "").trim(),
        call_type: callType,
        source_file_id: 0,
      };
      cdrMetadata(row, normalizedRow);
      normalized.push(normalizedRow);
    } catch (error) {
      errors.push({ row: index + 1, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { rows: normalized, errors };
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
   * Normalize telecom CDR aliases, then queue canonical `CdrRecord` rows via
   * `POST /ingest?object_type=CdrRecord`. Invalid rows are returned in
   * `errors`; poll the returned `task_id` for writer completion.
   */
  async ingestCdr(
    rows: RelataRow[],
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const normalized = normalizeCdrRows(rows);
    const receipt = normalized.rows.length > 0
      ? await this._sendRaw(
        "POST",
        this.paramsPath("CdrRecord", opts.purpose),
        normalized.rows.map(cdrJsonLine).join("\n"),
        "application/x-ndjson",
      )
      : await this._sendRaw("POST", this.paramsPath("CdrRecord", opts.purpose), "[]", "application/json");
    const serverErrors = Array.isArray(receipt["errors"]) ? receipt["errors"] : [];
    const serverRejected = typeof receipt["rows_rejected"] === "number" ? receipt["rows_rejected"] : 0;
    return {
      ...receipt,
      errors: [...normalized.errors, ...serverErrors],
      rows_rejected: serverRejected + normalized.errors.length,
    };
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
