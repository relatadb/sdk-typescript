/**
 * Bulk ingest SDK (#83).
 *
 * Exposes the generic row-ingest APIs. `RelataClient.ingestDocument` sends
 * prepared document rows as a queued mixed-type request to `/ingest/bulk`;
 * document extraction and source-format mapping belong in an application
 * adapter.
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
function cdrValues(row: RelataRow): Map<string, unknown> {
  // Build this view once per row. Alias lookup is repeated for every canonical
  // field and metadata key; rebuilding the same map for each lookup dominated
  // the adapter's avoidable per-row allocation cost.
  const values = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) {
    // CDR aliases are ASCII identifiers; match Python/Go without Unicode
    // case-folding differences.
    const folded = key.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
    if (values.has(folded)) throw new Error(`ambiguous case-insensitive field '${folded}'`);
    values.set(folded, value);
  }
  return values;
}

function cdrValue(values: Map<string, unknown>, aliases: readonly string[]): unknown {
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

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

function rfc3339TimestampNs(text: string): bigint {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!match) throw new Error(`call_start '${text}': expected integer epoch or RFC3339 timestamp`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] = match;
  const offset = zone ?? "";
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  if (fraction !== undefined && fraction.length > 9) {
    throw new Error("call_start RFC3339 fraction exceeds nanosecond precision");
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (monthDays[month - 1] ?? 0)
      || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`call_start '${text}': invalid RFC3339 date or time`);
  }
  let offsetSeconds = 0;
  if (offset !== "Z") {
    if (offset === "-00:00") throw new Error("call_start RFC3339 -00:00 offset is unknown, not UTC");
    const offsetHour = Number(offset.slice(1, 3)), offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) throw new Error(`call_start '${text}': invalid RFC3339 offset`);
    offsetSeconds = (offsetHour * 60 + offsetMinute) * 60 * (offset[0] === "-" ? -1 : 1);
  }
  // Howard Hinnant's civil-date conversion, evaluated exactly for four-digit years.
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const epochDays = era * 146097 + dayOfEra - 719468;
  const epochSeconds = BigInt(epochDays * 86400 + hour * 3600 + minute * 60 + second - offsetSeconds);
  const nanos = epochSeconds * 1_000_000_000n + BigInt((fraction ?? "").padEnd(9, "0") || "0");
  if (nanos < I64_MIN || nanos > I64_MAX) throw new Error("call_start RFC3339 value is outside i64 nanosecond range");
  return nanos;
}

function cdrTimestamp(value: unknown, fallbackNs: bigint): bigint {
  let raw: bigint;
  if (value === undefined || value === null) {
    raw = fallbackNs;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `call_start '${value}' is not a safe JavaScript integer; pass exact timestamps as a string or bigint`,
      );
    }
    raw = BigInt(value);
  } else if (typeof value === "bigint") {
    raw = value;
  } else {
    const text = String(value).trim();
    if (/^[+-]?\d+$/.test(text)) raw = BigInt(text);
    else return rfc3339TimestampNs(text);
  }
  if (raw < I64_MIN || raw > I64_MAX) {
    throw new Error(`call_start '${raw}': value out of range for i64`);
  }
  if (raw >= 10_000_000_000_000n) return raw;
  const nanoseconds = raw * 1_000_000_000n;
  return nanoseconds < I64_MIN ? I64_MIN : nanoseconds > I64_MAX ? I64_MAX : nanoseconds;
}

function cdrJsonObject(row: RelataRow): string {
  const fields = Object.entries(row).map(([key, value]) =>
    `${JSON.stringify(key)}:${typeof value === "bigint" ? value.toString() : JSON.stringify(value)}`
  );
  return `{${fields.join(",")}}`;
}

function cdrJsonArray(rows: RelataRow[]): string {
  return `[${rows.map(cdrJsonObject).join(",")}]`;
}

function cdrMetadata(values: Map<string, unknown>, normalized: RelataRow): void {
  for (const field of ["_pk", "id"] as const) {
    const value = cdrValue(values, [field]);
    if (value !== undefined && value !== null) normalized[field] = value;
  }
  const sourceFileId = cdrValue(values, ["source_file_id"]);
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
      const values = cdrValues(row);
      const callerRaw = cdrValue(values, CDR_ALIASES["caller"] ?? []);
      const calleeRaw = cdrValue(values, CDR_ALIASES["callee"] ?? []);
      const callerDigits = String(callerRaw ?? "").replace(/[^0-9]/g, "");
      const calleeDigits = String(calleeRaw ?? "").replace(/[^0-9]/g, "");
      if (callerDigits.length > 15) throw new Error(`caller_msisdn '${callerRaw}': too many digits (max 15 for E.164)`);
      if (calleeDigits.length > 15) throw new Error(`callee_msisdn '${calleeRaw}': too many digits (max 15 for E.164)`);
      const start = cdrTimestamp(cdrValue(values, CDR_ALIASES["start"] ?? []), nowNs);
      const duration = cdrInteger(cdrValue(values, CDR_ALIASES["duration"] ?? []), "duration", 0);
      if (duration < 0 || duration > 0xffff_ffff) throw new Error(`duration '${duration}': value out of range for u32`);
      const type = String(cdrValue(values, CDR_ALIASES["type"] ?? []) ?? "").trim().toLowerCase();
      const callType = ({ voice: "voice", call: "voice", "0": "voice", sms: "sms", mms: "sms", "1": "sms", data: "data", gprs: "data", "2": "data" } as Record<string, string>)[type] ?? "unknown";
      const normalizedRow: RelataRow = {
        caller_msisdn: cdrInteger(callerDigits, "caller_msisdn"),
        callee_msisdn: cdrInteger(calleeDigits, "callee_msisdn"),
        call_start_ns: start,
        duration_secs: duration,
        tower_id: String(cdrValue(values, CDR_ALIASES["tower"] ?? []) ?? "").trim(),
        call_type: callType,
        source_file_id: 0,
      };
      cdrMetadata(values, normalizedRow);
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
  /** Tenant / `X-Relata-Tenant-Id`; overrides extraHeaders case-insensitively. */
  tenant?: string;
}

/** Bulk-ingest client. */
export class IngestClient extends TypedClientBase {
  readonly #purpose: string | undefined;

  constructor(opts: IngestClientCtor) {
    // Canonicalize casing on a copy: the explicit tenant option owns scope,
    // without adding a second differently-cased header or mutating the caller.
    const headers = new Headers(opts.extraHeaders);
    if (opts.tenant !== undefined) headers.set("X-Relata-Tenant-Id", opts.tenant);
    const extraHeaders: Record<string, string> = {};
    headers.forEach((value, key) => { extraHeaders[key] = value; });
    super({ ...opts, extraHeaders });
    this.#purpose = opts.purpose;
  }

  /** Inherit parent auth, purpose and effective headers, including tenant overrides. */
  static fromClient(client: RelataClient): IngestClient {
    const ctor = TypedClientBase.clientToCtor(client);
    const ingestCtor: IngestClientCtor = { ...ctor };
    if (client.defaultPurpose !== undefined) {
      ingestCtor.purpose = client.defaultPurpose;
    }
    // clientToCtor already carries the parent's effective tenant header. Do
    // not reinterpret its declared tenant option over an explicit header override.
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
   * - `idempotencyKey` — `Idempotency-Key` header (#5689): a retry with the same
   *   key and rows replays the recorded response without a second write; a
   *   different body is `409 idempotency-conflict`.
   * - `durability` — `"sync"` sends `X-Relata-Durability: sync` (WAL fsynced
   *   before the response).
   * - `sourceCheckpoint` — `{ source, position, expected_position? }`; the
   *   server advances the durable checkpoint only after a successful
   *   synchronous write (requires `durability: "sync"`).
   * - `contract` — `{ dataset, version? }`: validate against a data contract
   *   (#5714); invalid rows are quarantined server-side.
   * - `mediaWorkClaim` — the `claim_id` from `MediaWorkClient.claim`, sent as
   *   `X-Relata-Claim`. Required when `sourceCheckpoint` names an
   *   `openetl/media/<work_id>` source (the server fences stale holders).
   * Any of `onConflict`, `idempotencyKey`, `sourceCheckpoint`, `contract` or
   * `mediaWorkClaim` routes the call to `POST /ingest/bulk`.
   */
  async bulk(
    objectType: string,
    rows: RelataRow[],
    opts: {
      purpose?: string;
      detectPacks?: string;
      onConflict?: "upsert" | "skip" | "error";
      tenantId?: string;
      idempotencyKey?: string;
      durability?: "sync";
      sourceCheckpoint?: { source: string; position: string; expected_position?: string };
      contract?: { dataset: string; version?: number };
      mediaWorkClaim?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (
      opts.mediaWorkClaim !== undefined ||
      opts.onConflict !== undefined ||
      opts.idempotencyKey !== undefined ||
      opts.sourceCheckpoint !== undefined ||
      opts.contract !== undefined
    ) {
      // Route to /ingest/bulk so on_conflict + tenant_id + the envelope take
      // effect. Match Python/Go: the explicit target type owns routing. A row's
      // stale _type annotation must not redirect this single-type method.
      const objects = rows.map((r) => ({ ...r, _type: objectType }));
      const body: Record<string, unknown> = { objects };
      if (opts.onConflict !== undefined) body["on_conflict"] = opts.onConflict;
      const purpose = opts.purpose ?? this.#purpose;
      if (purpose !== undefined) body["purpose"] = purpose;
      if (opts.tenantId !== undefined) body["tenant_id"] = opts.tenantId;
      if (opts.sourceCheckpoint !== undefined) body["source_checkpoint"] = opts.sourceCheckpoint;
      if (opts.contract !== undefined) body["contract"] = opts.contract;
      const headers: Record<string, string> = { ...(this.#detectHeader(opts.detectPacks) ?? {}) };
      if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
      if (opts.durability) headers["X-Relata-Durability"] = opts.durability;
      if (opts.mediaWorkClaim !== undefined) {
        headers["X-Relata-Claim"] = String(Math.trunc(opts.mediaWorkClaim));
      }
      return this._sendRaw(
        "POST",
        "/ingest/bulk",
        JSON.stringify(body),
        "application/json",
        Object.keys(headers).length > 0 ? headers : undefined,
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
   * `errors`; poll the returned `task_id` for writer completion. Pass
   * nanosecond timestamps as decimal strings or `bigint`; unsafe JavaScript
   * numeric timestamps are rejected instead of silently rounded. Strict
   * RFC3339 timestamps with an explicit offset are normalized exactly to UTC
   * nanoseconds (at most nine fractional digits). Inputs must fit i64 before
   * unit detection; epoch-second conversion then saturates to the i64
   * nanosecond bounds, matching Python and Go.
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
        cdrJsonArray(normalized.rows),
        "application/json",
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
}
