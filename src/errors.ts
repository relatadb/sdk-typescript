/**
 * Typed error classes for the Relata SDK.
 *
 * All errors extend `RelataError`, which extends the native `Error`.
 * Catch by type to handle specific failure modes:
 *
 * ```typescript
 * import { PurposeError, QuotaError, AuthError } from "@zysec-ai/relata-sdk";
 *
 * try {
 *   await relata.query("SELECT * FROM Person");
 * } catch (err) {
 *   if (err instanceof PurposeError) {
 *     console.error("Declare a purpose:", err.message);
 *   } else if (err instanceof QuotaError) {
 *     console.error("Query quota exhausted. Cost:", err.costUnits);
 *   } else if (err instanceof AuthError) {
 *     console.error("Invalid or missing bearer token.");
 *   } else {
 *     throw err; // unexpected — rethrow
 *   }
 * }
 * ```
 */

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

/**
 * Base class for all Relata SDK errors.
 *
 * Every error carries:
 * - `statusCode` — the HTTP status code returned by the server (0 for network errors)
 * - `serverMessage` — raw error string from the server's JSON envelope
 * - `queryId` — server-assigned query identifier, if the error occurred after
 *   the query was accepted and assigned an ID
 * - `code` — the server's RFC 7807 `application/problem+json` `code` extension
 *   field, or `undefined` when the server emits the legacy `{"error": "..."}`
 *   shape. Two vocabularies exist in real responses (#2555): most HTTP errors
 *   (auth/ACL/ingest/admin/...) use kebab-case, e.g. `"access-denied"`,
 *   `"parse-error"` (catalogue: `docs/api/error-codes.md`); `/query`'s
 *   planner/execution errors use the `QueryError`-derived `REL_*` form, e.g.
 *   `"REL_PARSE"`, `"REL_ACL"` (catalogue: `docs/src/end-users/error-codes.md`).
 *   Match on the literal string rather than assuming either form — do not
 *   rely on dotted-form codes like `"RELATA.QUERY.PURPOSE_REQUIRED"`, which
 *   were never implemented server-side.
 * - `typeUrl` — RFC 7807 `type` URL linking to the error docs
 * - `retryable` — `true` when the server says the request can be retried
 * - `requestId` — the `X-Request-ID` from the response, when available
 */
export class RelataError extends Error {
  /** HTTP status code (0 = network-level failure; no HTTP response received). */
  readonly statusCode: number;
  /** Raw error message from the server's `{ "error": "..." }` envelope. */
  readonly serverMessage: string;
  /** Server-assigned query ID, present when the error occurred mid-execution. */
  readonly queryId: string | undefined;
  /**
   * The server's RFC 7807 `code` extension field, when the server emits
   * `application/problem+json`. Kebab-case for most HTTP errors, `REL_*` for
   * `QueryError`-derived `/query*` errors — see the class docstring.
   */
  readonly code: string | undefined;
  /** RFC 7807 `type` URL linking to the error docs. */
  readonly typeUrl: string | undefined;
  /** `true` when the server says the request can be retried. */
  readonly retryable: boolean;
  /** The `X-Request-ID` from the response, when available. */
  readonly requestId: string | undefined;
  /** Server retry delay in seconds, when supplied; not permission to replay. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    statusCode: number,
    serverMessage: string,
    queryId?: string,
    extras: {
      code?: string | undefined;
      typeUrl?: string | undefined;
      retryable?: boolean | undefined;
      requestId?: string | undefined;
      retryAfterSeconds?: number | undefined;
    } = {},
  ) {
    super(message);
    this.name = "RelataError";
    this.statusCode = statusCode;
    this.serverMessage = serverMessage;
    this.queryId = queryId ?? undefined;
    this.code = extras.code ?? undefined;
    this.typeUrl = extras.typeUrl ?? undefined;
    this.retryable = extras.retryable ?? false;
    this.requestId = extras.requestId ?? undefined;
    this.retryAfterSeconds = extras.retryAfterSeconds;

    // Maintain proper prototype chain in TypeScript/transpiled environments.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// HTTP 400 — Bad request
// ---------------------------------------------------------------------------

/**
 * Thrown when the server rejects a query because the `purpose` field is
 * missing or not registered in the tenant's `PurposeRegistry`.
 *
 * Every Relata query **must** declare a purpose (SPECS §5.22.4). Register a
 * purpose by setting `RELATA_PURPOSES` on the server, or by providing
 * `defaultPurpose` in `RelataClientOptions`.
 *
 * **Fix:** Pass a registered purpose string, e.g.:
 * ```typescript
 * await relata.query("SELECT * FROM Person", { purpose: "analytics" });
 * // — or globally —
 * const relata = createClient(url, { defaultPurpose: "analytics" });
 * ```
 */
export class PurposeError extends RelataError {
  /** The purpose token that was rejected, if one was supplied. */
  readonly purpose: string | undefined;

  constructor(
    purpose: string | undefined,
    serverMessage: string,
    queryId?: string,
    extras: ConstructorParameters<typeof RelataError>[4] = {},
  ) {
    const what = purpose
      ? `Purpose "${purpose}" is not registered in the tenant's PurposeRegistry`
      : "Query is missing a required purpose declaration";
    super(
      `${what}. ` +
        `Provide a purpose via query options or RelataClientOptions.defaultPurpose. ` +
        `Server said: ${serverMessage}`,
      400,
      serverMessage,
      queryId,
      extras,
    );
    this.name = "PurposeError";
    this.purpose = purpose;
  }
}

/**
 * Thrown when the server returns HTTP 400 for reasons other than a missing
 * purpose (e.g. syntax error in the SQL, invalid `AS OF` timestamp, etc.).
 */
export class BadRequestError extends RelataError {
  constructor(serverMessage: string, queryId?: string, extras: ConstructorParameters<typeof RelataError>[4] = {}) {
    super(
      `Bad request: ${serverMessage}`,
      400,
      serverMessage,
      queryId,
      extras,
    );
    this.name = "BadRequestError";
  }
}

// ---------------------------------------------------------------------------
// HTTP 401 — Unauthorized
// ---------------------------------------------------------------------------

/**
 * Thrown when the server requires a bearer token and the supplied token is
 * missing, expired, or invalid.
 *
 * **Fix:** Pass `bearerToken` in `RelataClientOptions`:
 * ```typescript
 * const relata = createClient(url, { bearerToken: process.env.RELATA_TOKEN });
 * ```
 */
export class AuthError extends RelataError {
  constructor(serverMessage: string, extras: NonNullable<ConstructorParameters<typeof RelataError>[4]> & { queryId?: string | undefined } = {}) {
    super(
      `Authentication failed: ${serverMessage}. ` +
        `Provide a valid bearer token via RelataClientOptions.bearerToken or ` +
        `the RELATA_TOKEN environment variable.`,
      401,
      serverMessage,
      extras.queryId,
      extras,
    );
    this.name = "AuthError";
  }
}

// ---------------------------------------------------------------------------
// HTTP 403 — Forbidden
// ---------------------------------------------------------------------------

/**
 * Thrown when the authenticated principal does not have the Cedar ACL rights
 * to access the requested data (cell-level ACL pushdown, SPECS §5.15).
 */
export class ForbiddenError extends RelataError {
  constructor(
    serverMessage: string,
    queryId?: string,
    extras: {
      code?: string | undefined;
      typeUrl?: string | undefined;
      retryable?: boolean | undefined;
      requestId?: string | undefined;
      retryAfterSeconds?: number | undefined;
    } = {},
  ) {
    super(
      `Access denied: ${serverMessage}`,
      403,
      serverMessage,
      queryId,
      extras,
    );
    this.name = "ForbiddenError";
  }
}

// ---------------------------------------------------------------------------
// HTTP 404 / 409 / 422 — typed v1.1 subclasses
// ---------------------------------------------------------------------------

/**
 * Thrown when the server returns HTTP 404 — the requested resource does not
 * exist.
 */
export class NotFoundError extends RelataError {
  constructor(
    serverMessage: string,
    extras: {
      queryId?: string | undefined;
      code?: string | undefined;
      typeUrl?: string | undefined;
      retryable?: boolean | undefined;
      requestId?: string | undefined;
      retryAfterSeconds?: number | undefined;
    } = {},
  ) {
    super(
      `Not found: ${serverMessage}`,
      404,
      serverMessage,
      extras.queryId,
      extras,
    );
    this.name = "NotFoundError";
  }
}

/**
 * Thrown when the server returns HTTP 409 — a version or uniqueness conflict.
 */
export class ConflictError extends RelataError {
  constructor(
    serverMessage: string,
    extras: {
      queryId?: string | undefined;
      code?: string | undefined;
      typeUrl?: string | undefined;
      retryable?: boolean | undefined;
      requestId?: string | undefined;
      retryAfterSeconds?: number | undefined;
    } = {},
  ) {
    super(
      `Conflict: ${serverMessage}`,
      409,
      serverMessage,
      extras.queryId,
      extras,
    );
    this.name = "ConflictError";
  }
}

/**
 * Thrown when the server returns HTTP 412 — a conditional write
 * (`If-Match` / `If-None-Match` / a bundle's `expectedVersion`) lost: the
 * object is not at the version the caller read. Nothing was written; re-read
 * the object and retry with its current version.
 */
export class PreconditionFailedError extends RelataError {
  /** Live version of the object (also the response `ETag`); `null` when it does not exist. */
  readonly currentVersion: number | null;
  /** Index of the failing operation in a `commit` bundle (`0` for a single write). */
  readonly failedOperation: number | undefined;

  constructor(
    serverMessage: string,
    extras: {
      queryId?: string | undefined;
      code?: string | undefined;
      typeUrl?: string | undefined;
      retryable?: boolean | undefined;
      requestId?: string | undefined;
      retryAfterSeconds?: number | undefined;
      currentVersion?: number | null | undefined;
      failedOperation?: number | undefined;
    } = {},
  ) {
    super(
      `Precondition failed: ${serverMessage}`,
      412,
      serverMessage,
      extras.queryId,
      extras,
    );
    this.name = "PreconditionFailedError";
    this.currentVersion = extras.currentVersion ?? null;
    this.failedOperation = extras.failedOperation;
  }
}

/**
 * Thrown when the server returns HTTP 422 — the request body failed
 * validation.
 */
export class ValidationError extends RelataError {
  constructor(
    serverMessage: string,
    extras: {
      queryId?: string | undefined;
      code?: string | undefined;
      typeUrl?: string | undefined;
      retryable?: boolean | undefined;
      requestId?: string | undefined;
      retryAfterSeconds?: number | undefined;
    } = {},
  ) {
    super(
      `Validation error: ${serverMessage}`,
      422,
      serverMessage,
      extras.queryId,
      extras,
    );
    this.name = "ValidationError";
  }
}

// ---------------------------------------------------------------------------
// HTTP 429 — Too many requests / quota / rate limited
// ---------------------------------------------------------------------------

/**
 * Thrown when the per-principal query cost quota (`RELATA_QUERY_QUOTA`) is
 * exhausted (SPECS §17.19 / ADR-059).
 *
 * The `costUnits` field reports the cost of the query that triggered the cap,
 * when the server includes it in the error envelope. `retryAfterSeconds` is
 * populated from the `Retry-After` header.
 *
 * `RateLimitedError` extends this class; `mapHttpError` emits the richer
 * `RateLimitedError` for HTTP 429 so existing `catch (e instanceof QuotaError)`
 * callers keep working while new callers can catch the v1.1 name.
 */
export class QuotaError extends RelataError {
  /** Cost units consumed by the query that hit the cap (if reported). */
  readonly costUnits: number | undefined;

  constructor(
    serverMessage: string,
    costUnits?: number,
    retryAfterSeconds?: number,
    queryId?: string,
    extras: {
      code?: string | undefined;
      typeUrl?: string | undefined;
      retryable?: boolean | undefined;
      requestId?: string | undefined;
      retryAfterSeconds?: number | undefined;
    } = {},
  ) {
    super(
      `Query cost quota exhausted: ${serverMessage}` +
        (retryAfterSeconds !== undefined
          ? ` Retry after ${retryAfterSeconds}s.`
          : ""),
      429,
      serverMessage,
      queryId,
      { ...extras, retryAfterSeconds: retryAfterSeconds ?? extras.retryAfterSeconds },
    );
    this.name = "QuotaError";
    this.costUnits = costUnits;
  }
}

/**
 * Thrown when the server returns HTTP 429 with a `Retry-After` header or a
 * `retry_after` field in the problem+json body — a rate-limit or quota hit
 * (v1.1 typed subclass). This extends `QuotaError` so existing
 * `catch (e instanceof QuotaError)` callers keep working.
 */
export class RateLimitedError extends QuotaError {
  /** `X-RateLimit-Limit` — per-window request budget (#1321). */
  readonly rateLimitLimit: number | undefined;
  /** `X-RateLimit-Remaining` — requests remaining in the current window. */
  readonly rateLimitRemaining: number | undefined;
  /** `X-RateLimit-Reset` — unix seconds when the window resets. */
  readonly rateLimitReset: number | undefined;

  constructor(
    serverMessage: string,
    retryAfterSeconds?: number,
    extras: {
      costUnits?: number | undefined;
      queryId?: string | undefined;
      code?: string | undefined;
      typeUrl?: string | undefined;
      retryable?: boolean | undefined;
      requestId?: string | undefined;
      retryAfterSeconds?: number | undefined;
      rateLimitLimit?: number | undefined;
      rateLimitRemaining?: number | undefined;
      rateLimitReset?: number | undefined;
    } = {},
  ) {
    super(
      `Rate limited: ${serverMessage}` +
        (retryAfterSeconds !== undefined
          ? ` Retry after ${retryAfterSeconds}s.`
          : ""),
      extras.costUnits,
      retryAfterSeconds,
      extras.queryId,
      {
        code: extras.code,
        typeUrl: extras.typeUrl,
        retryable: extras.retryable,
        requestId: extras.requestId,
        retryAfterSeconds: extras.retryAfterSeconds,
      },
    );
    this.name = "RateLimitedError";
    this.rateLimitLimit = extras.rateLimitLimit;
    this.rateLimitRemaining = extras.rateLimitRemaining;
    this.rateLimitReset = extras.rateLimitReset;
  }
}

// ---------------------------------------------------------------------------
// HTTP 5xx — Server errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the server responds with an HTTP 5xx status code.
 */
export class ServerError extends RelataError {
  constructor(
    statusCode: number,
    serverMessage: string,
    queryId?: string,
    extras: {
      code?: string | undefined;
      typeUrl?: string | undefined;
      retryable?: boolean | undefined;
      requestId?: string | undefined;
      retryAfterSeconds?: number | undefined;
    } = {},
  ) {
    super(
      `Server error (HTTP ${statusCode}): ${serverMessage}`,
      statusCode,
      serverMessage,
      queryId,
      extras,
    );
    this.name = "ServerError";
  }
}

// ---------------------------------------------------------------------------
// Network / transport errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the request fails to reach the server entirely (DNS failure,
 * connection refused, request timeout via `AbortController`, etc.).
 *
 * `statusCode` is `0` because no HTTP response was received.
 */
export class NetworkError extends RelataError {
  /** Underlying fetch/network error. */
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message, 0, message);
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/**
 * Thrown when a request is cancelled because `timeoutMs` was exceeded.
 */
export class TimeoutError extends NetworkError {
  /** Timeout value that was exceeded, in milliseconds. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Request timed out after ${timeoutMs}ms. ` +
        `Increase RelataClientOptions.timeoutMs or QueryOptions.timeoutMs to allow more time.`,
      new Error("AbortError"),
    );
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// Client-side guards (#3214)
// ---------------------------------------------------------------------------

/**
 * Thrown when a response body exceeds the client's `maxResponseBytes` cap, so
 * a malicious or buggy server cannot exhaust memory by streaming an unbounded
 * body (#3214). Streaming surfaces are not capped.
 */
export class ResponseTooLargeError extends RelataError {
  /** The configured cap that was exceeded, in bytes. */
  readonly maxResponseBytes: number;

  constructor(maxResponseBytes: number) {
    super(
      `Response body exceeds the maxResponseBytes cap of ${maxResponseBytes} bytes. ` +
        `Increase RelataClientOptions.maxResponseBytes or use a streaming surface.`,
      0,
      `response body exceeds ${maxResponseBytes} bytes`,
    );
    this.name = "ResponseTooLargeError";
    this.maxResponseBytes = maxResponseBytes;
  }
}

/**
 * Thrown for every request issued after `close()` — the bearer token has been
 * zeroized and the client is unusable (#3214).
 */
export class ClientClosedError extends RelataError {
  constructor() {
    super(
      "Client is closed (credentials zeroized). Create a new client to make requests.",
      0,
      "client is closed",
    );
    this.name = "ClientClosedError";
  }
}

// ---------------------------------------------------------------------------
// Redirect guard (#2364)
// ---------------------------------------------------------------------------

/**
 * @internal
 * Every `fetch()` call site in this SDK passes `redirect: "manual"` so a
 * request never silently follows a 3xx response and resends the bearer
 * token to a redirect target the caller did not choose — the TS-SDK
 * equivalent HTTP transport policy used by the maintained clients (#1416).
 * A spec-compliant runtime that honors `redirect: "manual"` resolves with an
 * opaque response (`response.type === "opaqueredirect"`, `status === 0`); a
 * runtime or an injected `opts.fetch` that only partially honors it may
 * instead hand back the raw 3xx response with `Location` intact. Either
 * shape is treated as a redirect here.
 */
export function isRedirectResponse(response: Response): boolean {
  return (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  );
}

/**
 * @internal
 * Throws a {@link NetworkError} if `response` is a redirect (see
 * {@link isRedirectResponse}). Call this immediately after every `fetch()`
 * in the SDK, before the response body or headers are inspected further —
 * this is the code-level guarantee that the `Authorization` header is never
 * replayed to a redirect target, independent of whatever the bound/injected
 * `fetch` implementation would otherwise default to.
 */
export function assertNotRedirected(response: Response, url: string): void {
  if (!isRedirectResponse(response)) return;
  throw new NetworkError(
    `Refusing to follow redirect from ${url}` +
      (response.status ? ` (HTTP ${response.status})` : "") +
      `. The Relata SDK sends every request with redirect: "manual" and ` +
      `treats a redirect response as a hard error instead of resending ` +
      `credentials to a target it did not request.`,
    new Error("redirect blocked"),
  );
}

// ---------------------------------------------------------------------------
// Internal helper — map HTTP status + server body to a typed error
// ---------------------------------------------------------------------------

/**
 * @internal
 * Given an HTTP response and an optional parsed error body, return the most
 * specific typed error for that status code.
 *
 * The `extras` bag carries both the per-call dispatch context (purpose,
 * retry-after, cost-units) and the RFC 7807 problem+json fields (code,
 * typeUrl, retryable, requestId) so every typed subclass can surface them.
 */
export function mapHttpError(
  status: number,
  serverMessage: string,
  extras: {
    purpose?: string | undefined;
    queryId?: string | undefined;
    retryAfterSeconds?: number | undefined;
    costUnits?: number | undefined;
    code?: string | undefined;
    typeUrl?: string | undefined;
    retryable?: boolean | undefined;
    requestId?: string | undefined;
    rateLimitLimit?: number | undefined;
    rateLimitRemaining?: number | undefined;
    rateLimitReset?: number | undefined;
    currentVersion?: number | null | undefined;
    failedOperation?: number | undefined;
  } = {},
): RelataError {
  const {
    purpose,
    queryId,
    retryAfterSeconds,
    costUnits,
    code,
    typeUrl,
    retryable,
    requestId,
    rateLimitLimit,
    rateLimitRemaining,
    rateLimitReset,
    currentVersion,
    failedOperation,
  } = extras;
  // Shared RFC 7807 bag handed to every subclass constructor below.
  const rfc7807 = { code, typeUrl, retryable, requestId, retryAfterSeconds };

  switch (status) {
    case 400: {
      // Purpose-specific detection — works for both legacy and problem+json.
      // Matches the Python `_classify_error` heuristic.
      const lc = serverMessage.toLowerCase();
      const isPurpose =
        (code !== undefined && code.toLowerCase().includes("purpose")) ||
        lc.includes("purpose");
      if (isPurpose) {
        // PurposeError retains its narrower constructor for back-compat.
        return new PurposeError(purpose, serverMessage, queryId, rfc7807);
      }
      return new BadRequestError(serverMessage, queryId, rfc7807);
    }
    case 401:
      return new AuthError(serverMessage, { queryId, ...rfc7807 });
    case 403:
      return new ForbiddenError(serverMessage, queryId, rfc7807);
    case 404:
      return new NotFoundError(serverMessage, { queryId, ...rfc7807 });
    case 409:
      return new ConflictError(serverMessage, { queryId, ...rfc7807 });
    case 412:
      return new PreconditionFailedError(serverMessage, {
        queryId,
        ...rfc7807,
        currentVersion,
        failedOperation,
      });
    case 422:
      return new ValidationError(serverMessage, { queryId, ...rfc7807 });
    case 429:
      return new RateLimitedError(serverMessage, retryAfterSeconds, {
        costUnits,
        queryId,
        ...rfc7807,
        rateLimitLimit,
        rateLimitRemaining,
        rateLimitReset,
      });
    default:
      if (status >= 500) {
        return new ServerError(status, serverMessage, queryId, rfc7807);
      }
      return new RelataError(
        `Unexpected HTTP ${status}: ${serverMessage}`,
        status,
        serverMessage,
        queryId,
        rfc7807,
      );
  }
}

/** @internal Shared problem/header metadata for specialized HTTP clients. */
export function httpProblemMetadata(
  body: Record<string, unknown>,
  headers?: Headers,
): {
  code: string | undefined;
  typeUrl: string | undefined;
  queryId: string | undefined;
  requestId: string | undefined;
  retryable: boolean;
  retryAfterSeconds: number | undefined;
  currentVersion: number | null | undefined;
  failedOperation: number | undefined;
} {
  const retry = headers?.get("Retry-After");
  let retryAfterSeconds: number | undefined;
  if (retry !== null && retry !== undefined) {
    if (/^\d+$/.test(retry.trim())) {
      const seconds = Number(retry);
      if (Number.isSafeInteger(seconds)) retryAfterSeconds = seconds;
    } else if (/^[A-Za-z]{3}/.test(retry.trim())) {
      const timestamp = Date.parse(retry);
      if (Number.isFinite(timestamp)) {
        retryAfterSeconds = Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
      }
    }
  }
  if (retryAfterSeconds === undefined && typeof body["retry_after"] === "number"
      && Number.isFinite(body["retry_after"]) && body["retry_after"] >= 0
      && body["retry_after"] <= Number.MAX_SAFE_INTEGER) {
    retryAfterSeconds = body["retry_after"];
  }
  return {
    code: typeof body["code"] === "string" ? body["code"] : undefined,
    typeUrl: typeof body["type"] === "string" ? body["type"] : undefined,
    queryId: typeof body["query_id"] === "string" ? body["query_id"] : undefined,
    requestId: typeof body["request_id"] === "string" ? body["request_id"]
      : headers?.get("x-request-id") ?? undefined,
    retryable: body["retryable"] === true,
    retryAfterSeconds,
    // #5766: the live version a failed precondition reports (412 only).
    currentVersion: typeof body["current_version"] === "number" ? body["current_version"]
      : body["current_version"] === null ? null : undefined,
    failedOperation: typeof body["failed_operation"] === "number" ? body["failed_operation"] : undefined,
  };
}
