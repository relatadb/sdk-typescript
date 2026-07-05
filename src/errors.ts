/**
 * Typed error classes for the Relata SDK.
 *
 * All errors extend `RelataError`, which extends the native `Error`.
 * Catch by type to handle specific failure modes:
 *
 * ```typescript
 * import { PurposeError, QuotaError, AuthError } from "@relata/sdk";
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
 */
export class RelataError extends Error {
  /** HTTP status code (0 = network-level failure; no HTTP response received). */
  readonly statusCode: number;
  /** Raw error message from the server's `{ "error": "..." }` envelope. */
  readonly serverMessage: string;
  /** Server-assigned query ID, present when the error occurred mid-execution. */
  readonly queryId: string | undefined;

  constructor(
    message: string,
    statusCode: number,
    serverMessage: string,
    queryId?: string,
  ) {
    super(message);
    this.name = "RelataError";
    this.statusCode = statusCode;
    this.serverMessage = serverMessage;
    this.queryId = queryId ?? undefined;

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
  constructor(serverMessage: string, queryId?: string) {
    super(
      `Bad request: ${serverMessage}`,
      400,
      serverMessage,
      queryId,
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
  constructor(serverMessage: string) {
    super(
      `Authentication failed: ${serverMessage}. ` +
        `Provide a valid bearer token via RelataClientOptions.bearerToken or ` +
        `the RELATA_TOKEN environment variable.`,
      401,
      serverMessage,
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
  constructor(serverMessage: string, queryId?: string) {
    super(
      `Access denied: ${serverMessage}`,
      403,
      serverMessage,
      queryId,
    );
    this.name = "ForbiddenError";
  }
}

// ---------------------------------------------------------------------------
// HTTP 429 — Too many requests / quota
// ---------------------------------------------------------------------------

/**
 * Thrown when the per-principal query cost quota (`RELATA_QUERY_QUOTA`) is
 * exhausted (SPECS §17.19 / ADR-059).
 *
 * The `costUnits` field reports the cost of the query that triggered the cap,
 * when the server includes it in the error envelope.
 */
export class QuotaError extends RelataError {
  /** Cost units consumed by the query that hit the cap (if reported). */
  readonly costUnits: number | undefined;
  /** Seconds until the quota window resets (if the server sends `Retry-After`). */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    serverMessage: string,
    costUnits?: number,
    retryAfterSeconds?: number,
    queryId?: string,
  ) {
    super(
      `Query cost quota exhausted: ${serverMessage}` +
        (retryAfterSeconds !== undefined
          ? ` Retry after ${retryAfterSeconds}s.`
          : ""),
      429,
      serverMessage,
      queryId,
    );
    this.name = "QuotaError";
    this.costUnits = costUnits;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// HTTP 5xx — Server errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the server responds with an HTTP 5xx status code.
 */
export class ServerError extends RelataError {
  constructor(statusCode: number, serverMessage: string, queryId?: string) {
    super(
      `Server error (HTTP ${statusCode}): ${serverMessage}`,
      statusCode,
      serverMessage,
      queryId,
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
// Internal helper — map HTTP status + server body to a typed error
// ---------------------------------------------------------------------------

/**
 * @internal
 * Given an HTTP response and an optional parsed error body, return the most
 * specific typed error for that status code.
 */
export function mapHttpError(
  status: number,
  serverMessage: string,
  extras: {
    purpose?: string | undefined;
    queryId?: string | undefined;
    retryAfterSeconds?: number | undefined;
    costUnits?: number | undefined;
  } = {},
): RelataError {
  const { purpose, queryId, retryAfterSeconds, costUnits } = extras;

  switch (status) {
    case 400: {
      // Heuristic: if the server message mentions "purpose", surface PurposeError.
      const lc = serverMessage.toLowerCase();
      if (lc.includes("purpose")) {
        return new PurposeError(purpose, serverMessage, queryId);
      }
      return new BadRequestError(serverMessage, queryId);
    }
    case 401:
      return new AuthError(serverMessage);
    case 403:
      return new ForbiddenError(serverMessage, queryId);
    case 429:
      return new QuotaError(serverMessage, costUnits, retryAfterSeconds, queryId);
    default:
      if (status >= 500) {
        return new ServerError(status, serverMessage, queryId);
      }
      return new RelataError(
        `Unexpected HTTP ${status}: ${serverMessage}`,
        status,
        serverMessage,
        queryId,
      );
  }
}
