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
 * `client.ts` at all, breaking the cycle.
 */

/**
 * HTTP status codes that trigger an automatic retry when `maxRetries > 0`.
 * Matches the Python `_http._DEFAULT_RETRY_ON` set.
 */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * HTTP methods that are safe to retry without risk of double-execution.
 * Parity with the Rust SDK (`post()` never retries — see
 * `crates/relata-sdk-rust/src/http.rs`) and the Go SDK's `isIdempotent`
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
