/**
 * @internal
 * Shared HTTP retry policy — the exact retryable-status set, idempotency
 * gate, and default backoff that both `RelataClient` (`client.ts`) and
 * `TypedClientBase` (`_typed-http.ts`, #2731) use, so the two client
 * surfaces never re-diverge on what's safe to retry.
 *
 * Kept in its own dependency-free leaf module rather than defined in
 * `client.ts` and imported by `_typed-http.ts` (as it originally was):
 * `_typed-http.ts` importing a value from `client.ts` closed an ESM
 * circular-import cycle — `client.ts` → `namespace.ts` (`Namespace` uses
 * `IngestClient`) → `ingest.ts` (`IngestClient extends TypedClientBase`) →
 * `_typed-http.ts` → back to `client.ts` — which surfaced as
 * `ReferenceError: Cannot access 'TypedClientBase' before initialization`
 * whenever `_typed-http.ts` happened to be the first module Node resolved
 * along that chain (#2879). Extracting these constants here means
 * `_typed-http.ts` no longer needs any runtime (value) import from
 * `client.ts` at all, breaking the cycle. Its only import is the leaf
 * `_body.ts` capped reader (#6302).
 */

import { readCappedResponseBody } from "./_body.ts";

/**
 * HTTP status codes that trigger an automatic retry when `maxRetries > 0`.
 * Matches the Python `_http._DEFAULT_RETRY_ON` set.
 */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * HTTP methods that are safe to retry without risk of double-execution.
 * Non-idempotent POST operations are not retried, consistent with the Go
 * SDK's `isIdempotent`
 * (`sdks/go/relata/client.go`). POST/PUT/PATCH/DELETE are NOT retried — a
 * gateway timeout after commit would otherwise double-execute irreversible
 * ops (erase_subject, fuse_identities, session_commit, #2489).
 */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
]);

/**
 * `true` when the HTTP method is safe to retry (#2489). Shared by
 * `RelataClient` and `TypedClientBase` (#2731) so both gate retries on the
 * exact same set.
 */
export function isIdempotentMethod(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Default base backoff for the retry loop, in milliseconds. Shared by
 * `RelataClient` and `TypedClientBase` (#2731) so neither re-diverges the
 * default.
 */
export const DEFAULT_RETRY_BACKOFF_MS = 500;

/**
 * #5689 (owner decision D06): every bulk ingest request carries an
 * `Idempotency-Key` so a retry cannot duplicate keyless rows.
 */
const BULK_INGEST_PATH = "/v1/ingest/bulk";

/** `true` for a `POST /v1/ingest/bulk` (`target` is a path or a full URL). */
export function isBulkIngest(method: string, target: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const path = (target.split("?")[0] ?? target).replace(/\/+$/, "");
  return path.endsWith(BULK_INGEST_PATH);
}

/**
 * Return `headers` with an automatic `Idempotency-Key` (a random UUID) added
 * when none is present (#5689 D06, the Kafka/Stripe pattern). Called once per
 * call, before the retry loop, so every attempt reuses the same key and the
 * server replays or converges instead of writing twice. An explicit key is
 * never replaced.
 */
export function withBulkIngestIdempotencyKey(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out = { ...(headers ?? {}) };
  if (Object.keys(out).some((k) => k.toLowerCase() === "idempotency-key")) return out;
  out["Idempotency-Key"] =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `relata-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return out;
}

/**
 * Whether a response status is retried. Idempotent verbs retry on every
 * {@link RETRYABLE_STATUS_CODES} status. A keyed bulk ingest also retries on
 * the gateway statuses (502/504), but never on a 503 from Relata itself, which
 * carries its own `retryable` verdict and `Retry-After` (#5689).
 */
export function isRetryableStatus(method: string, status: number, keyedBulk: boolean): boolean {
  if (!RETRYABLE_STATUS_CODES.has(status)) return false;
  if (isIdempotentMethod(method)) return true;
  return keyedBulk && status !== 503;
}

/**
 * Default total time, in milliseconds, one call may spend waiting out node
 * maintenance pauses (#6302). Set `pauseRetryBudgetMs: 0` to disable.
 */
export const DEFAULT_PAUSE_RETRY_BUDGET_MS = 30_000;

/**
 * `pause_reason` values of a node maintenance pause (#6302). A 503 naming
 * one of these with `retryable: true` was refused before any handler ran
 * (the router-wide admission gate, or a bulk group that wrote nothing), so
 * it is safe to resend for every verb. `poisoned` and `storage_recovering`
 * are not maintenance pauses and are never retried this way.
 */
const MAINTENANCE_PAUSE_REASONS: ReadonlySet<string> = new Set([
  "rollover_begin",
  "rollover_commit",
  "backup",
  "restore",
]);
const PAUSE_RETRY_MAX_DELAY_MS = 5_000;
const PAUSE_RETRY_MIN_DELAY_MS = 100;
const PAUSE_RETRY_DEFAULT_DELAY_MS = 1_000;
/** A pause body is a few hundred bytes; a larger 503 body is not one. */
const PAUSE_PEEK_MAX_BYTES = 64 * 1024;

/**
 * Only a JSON 503 that declares a small `Content-Length` is read ahead, as the
 * server's pause response always does; any other body (streamed, stalled or
 * oversized) is left to the normal capped, time-bounded read.
 */
function mayBePauseBody(headers: Headers): boolean {
  const type = headers.get("content-type") ?? "";
  const length = Number(headers.get("content-length") ?? NaN);
  return type.includes("json") && Number.isSafeInteger(length) && length >= 0
    && length <= PAUSE_PEEK_MAX_BYTES;
}

/**
 * @internal
 * Milliseconds to wait before resending a request refused by a node
 * maintenance pause, or `undefined` when `response` is not one (#6302).
 * Honours `Retry-After` (then the body's `retry_after_secs`, then 1 s),
 * clamped to 100 ms..5 s. Reads a clone, so `response` stays unread, and only
 * when the body is a small JSON document of declared length.
 */
export async function maintenancePauseDelayMs(response: Response): Promise<number | undefined> {
  if (response.status !== 503) return undefined;
  let fields: Record<string, unknown>;
  let header: string | null;
  try {
    if (!mayBePauseBody(response.headers)) return undefined;
    header = response.headers.get("Retry-After");
    const bytes = await readCappedResponseBody(response.clone(), PAUSE_PEEK_MAX_BYTES);
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
    fields = body as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const reason = fields["pause_reason"];
  if (
    fields["retryable"] !== true ||
    typeof reason !== "string" ||
    !MAINTENANCE_PAUSE_REASONS.has(reason)
  ) {
    return undefined;
  }
  let seconds: number | undefined;
  if (header !== null && /^\d+$/.test(header.trim())) seconds = Number(header.trim());
  const hint = fields["retry_after_secs"];
  if (seconds === undefined && typeof hint === "number" && Number.isFinite(hint) && hint >= 0) {
    seconds = hint;
  }
  const ms = seconds === undefined ? PAUSE_RETRY_DEFAULT_DELAY_MS : seconds * 1000;
  return Math.min(Math.max(ms, PAUSE_RETRY_MIN_DELAY_MS), PAUSE_RETRY_MAX_DELAY_MS);
}
