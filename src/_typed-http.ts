/**
 * @internal
 * Shared HTTP plumbing for the typed v1.1 clients.
 *
 * Each typed client (governance, mcp, a2a, audit, identity, objects, ingest,
 * vectors, system, tenants, backup, tokens, log) extends
 * {@link TypedClientBase} to inherit transport, auth, tenant header
 * propagation, X-Request-ID generation, a bounded request timeout, an
 * idempotent-verb retry-with-backoff loop, and full RFC 7807 typed-error
 * classification (#2731) — the same resilience contract `RelataClient`
 * (`client.ts`) implements for the untyped surface. Each method on the
 * subclasses is a thin wrapper that picks a path, a method, and a body
 * shape — copied verbatim from the Python reference.
 *
 * The base class mirrors the Python `_http.HttpTransport` semantics: per-
 * attempt X-Request-ID, `application/json` body for POST/PUT/PATCH, query-
 * string builders for GET with params.
 */

import {
  assertNotRedirected,
  mapHttpError,
  NetworkError,
  RelataError,
  TimeoutError,
} from "./errors.ts";
import {
  DEFAULT_RETRY_BACKOFF_MS,
  isIdempotentMethod,
  RETRYABLE_STATUS_CODES,
} from "./_retry.ts";
// `import type` only — erased at runtime (`--experimental-strip-types`), so
// this does NOT create a runtime dependency edge back to `client.ts`. That
// edge (importing the retry constants above as *values* from `client.ts`)
// used to close an ESM circular-import cycle: `client.ts` → `namespace.ts`
// → `ingest.ts` (`IngestClient extends TypedClientBase`) → `_typed-http.ts`
// → back to `client.ts`. Depending on which module Node resolved first
// along that chain, `TypedClientBase` could still be in its temporal dead
// zone when `ingest.ts` evaluated `class IngestClient extends
// TypedClientBase`, throwing `ReferenceError: Cannot access
// 'TypedClientBase' before initialization` (#2879, reproduced by
// `admin-listener-split.test.ts`, which imports `./_typed-http.ts` before
// `./index.ts`). Moving the retry constants to the dependency-free
// `_retry.ts` leaf module removes the runtime `_typed-http.ts` → `client.ts`
// edge entirely, breaking the cycle.
import type { RelataClient } from "./client.ts";

// ---------------------------------------------------------------------------
// Options shared by every typed client constructor
// ---------------------------------------------------------------------------

/** @internal */
export interface TypedClientCtor {
  baseUrl: string;
  /**
   * Base URL of the loopbound admin control-plane listener (#2321,
   * ADR-0261). `/admin/*`/`/platform/*` requests route here instead of
   * `baseUrl` when set — see {@link TypedClientBase.clientToCtor} and
   * `#resolveBaseUrl`. `undefined` preserves prior behaviour (every request
   * goes to `baseUrl`).
   */
  adminBaseUrl?: string;
  bearerToken?: string;
  /**
   * Request timeout in milliseconds. Default 30000 (parity with
   * `RelataClient`, #2494/#2731).
   */
  timeoutMs?: number;
  /**
   * Retry ceiling for idempotent verbs (`GET`/`HEAD`/`OPTIONS`) on
   * `{502,503,504}` and network errors. Default `0` (no retry) — parity
   * with `RelataClient`'s default (#2731).
   */
  maxRetries?: number;
  /** Base exponential backoff (ms) for the retry loop. Default 500. */
  retryBackoffMs?: number;
  extraHeaders?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

/**
 * @internal
 * #2321 (ADR-0261): `true` for a path mounted only on the loopbound admin
 * control-plane listener (`RELATA_ADMIN_BIND`, default `127.0.0.1:9091`) —
 * `/admin/*` and `/platform/*` — never the main data-plane listener. See
 * `crates/relata-cli/src/serve/admin_listener.rs`.
 */
export function isAdminOnlyPath(path: string): boolean {
  return path.startsWith("/admin/") || path.startsWith("/platform/");
}

/**
 * @internal
 * `true` when a non-2xx response body carries no human-readable error text
 * at all — the shape the server's own RFC 7807 normalisation
 * (`normalize_error_body`, `crates/relata-cli/src/serve.rs`) leaves behind
 * for a request that matched no route on the listener that answered
 * (`{"type":"about:blank","status":404,"title":"Not Found","detail":""}`),
 * as opposed to a real business error, which always carries a non-empty
 * `detail`/`error`/`message` by convention across this codebase. `isJson`
 * reflects whether `body` was decoded as JSON; `body` is the already-decoded
 * value (an object when `isJson`, otherwise raw text).
 */
export function responseDetailIsBlank(isJson: boolean, body: unknown): boolean {
  if (isJson) {
    if (typeof body !== "object" || body === null) return true;
    const v = body as Record<string, unknown>;
    const blank = (k: string): boolean => {
      const val = v[k];
      return !(typeof val === "string" && val.trim() !== "");
    };
    return blank("detail") && blank("error") && blank("message");
  }
  return typeof body !== "string" || body.trim() === "";
}

/**
 * @internal
 * Build the "you're probably pointed at the wrong port" hint for a bare 404
 * against an admin/platform-only `path` (#2321).
 */
export function adminListenerHint(path: string): string {
  return (
    `${path} returned a bare 404 with no error detail. This route is served ` +
    "only by Relata's loopbound admin control-plane listener " +
    "(RELATA_ADMIN_BIND, default 127.0.0.1:9091 per ADR-0261) — it is never " +
    "mounted on the main data-plane listener, so a bare 404 here almost " +
    "always means this client's baseUrl points at the data-plane port " +
    "instead. Pass adminBaseUrl to point admin-only calls at the admin " +
    "listener, or verify RELATA_ADMIN_BIND. See " +
    "docs/src/decisions/0261-zero-trust-authorization-model.md."
  );
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

/**
 * @internal
 * Common ancestor of every typed v1.1 client. Holds the transport config and
 * exposes `get`/`post`/`put`/`patch`/`delete` helpers that return the decoded
 * JSON body (or throw a typed RelataError). Subclasses inherit
 * `fromClient(client)` to mirror the Python `from_client` classmethod.
 */
export class TypedClientBase {
  readonly #baseUrl: string;
  readonly #adminBaseUrl: string | undefined;
  readonly #bearerToken: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryBackoffMs: number;
  readonly #extraHeaders: Record<string, string>;
  readonly #fetch: typeof globalThis.fetch;

  constructor(opts: TypedClientCtor) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#adminBaseUrl = opts.adminBaseUrl?.replace(/\/+$/, "");
    this.#bearerToken = opts.bearerToken;
    // Default 30000ms (not 0/unbounded) — parity with RelataClient's own
    // default (#2494) so a typed client constructed standalone (not via
    // fromClient) doesn't inherit the old hang-forever footgun (#2731).
    this.#timeoutMs = opts.timeoutMs ?? 30000;
    this.#maxRetries = opts.maxRetries ?? 0;
    this.#retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.#extraHeaders = opts.extraHeaders ?? {};
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * @internal
   * Build a fresh options bag from a parent RelataClient — inherits
   * `timeoutMs`/`maxRetries`/`retryBackoffMs` (#2731) in addition to the
   * existing baseUrl/auth/header/fetch context.
   */
  static clientToCtor(client: RelataClient): TypedClientCtor {
    const ctor: TypedClientCtor = {
      baseUrl: client.baseUrl,
      extraHeaders: client.extraHeaders,
      // Propagate the parent's fetch override (testing / observability).
      fetch: client.fetchImpl,
      timeoutMs: client.timeoutMs,
      maxRetries: client.maxRetries,
      retryBackoffMs: client.retryBackoffMs,
    };
    if (client.internalBearerToken !== undefined) ctor.bearerToken = client.internalBearerToken;
    if (client.adminBaseUrl !== undefined) ctor.adminBaseUrl = client.adminBaseUrl;
    return ctor;
  }

  /**
   * @internal
   * Resolve the base URL a request to `path` should target: `adminBaseUrl`
   * for `/admin/*`/`/platform/*` when configured (#2321), `baseUrl`
   * otherwise — unchanged behaviour when `adminBaseUrl` is unset.
   */
  #resolveBaseUrl(path: string): string {
    if (this.#adminBaseUrl !== undefined && isAdminOnlyPath(path)) {
      return this.#adminBaseUrl;
    }
    return this.#baseUrl;
  }

  // -------------------------------------------------------------------------
  // Verbs
  // -------------------------------------------------------------------------

  /** @internal */
  protected async _get<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.#send<T>("GET", path, undefined);
  }

  /** @internal */
  protected async _post<T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown> | undefined,
  ): Promise<T> {
    return this.#send<T>("POST", path, body);
  }

  /** @internal */
  protected async _put<T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown> | undefined,
  ): Promise<T> {
    return this.#send<T>("PUT", path, body);
  }

  /** @internal */
  protected async _patch<T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown> | undefined,
  ): Promise<T> {
    return this.#send<T>("PATCH", path, body);
  }

  /** @internal */
  protected async _delete<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.#send<T>("DELETE", path, undefined);
  }

  /** @internal Send a raw NDJSON / CSV / bytes body. Returns parsed JSON. */
  protected async _sendRaw<T = Record<string, unknown>>(
    method: "POST" | "PUT",
    path: string,
    body: string,
    contentType: string,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.#resolveBaseUrl(path)}${path}`;
    const headers = this.#buildHeaders();
    headers["Content-Type"] = contentType;
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        if (v !== undefined && v !== "") headers[k] = v;
      }
    }
    // POST/PUT are not idempotent, so #dispatch never retries this call
    // (matches `RelataClient`'s `#postRaw`, #2489) — it still gets the
    // shared timeout + network-error handling.
    const response = await this.#dispatch(method, url, {
      method,
      headers,
      body,
      redirect: "manual",
    });
    return await this.#parse<T>(response, path);
  }

  /**
   * @internal
   * Send a JSON POST and return the **raw response bytes** (used by
   * `AuditClient.exportPdf` for PDF bodies that are not JSON-decodable).
   * Error responses are still classified into `RelataError` subclasses.
   */
  protected async _sendJsonExpectBytes(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Uint8Array> {
    const url = `${this.#resolveBaseUrl(path)}${path}`;
    const headers = this.#buildHeaders();
    headers["Content-Type"] = "application/json";
    const response = await this.#dispatch("POST", url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
    });
    if (!response.ok) {
      let errBody: unknown;
      try {
        errBody = await response.json();
      } catch {
        errBody = { error: `HTTP ${response.status}` };
      }
      throw this.#classify(response.status, path, true, errBody, response.headers);
    }
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** @internal */
  async #send<T>(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
  ): Promise<T> {
    const url = `${this.#resolveBaseUrl(path)}${path}`;
    const headers = this.#buildHeaders();
    const init: RequestInit = { method, headers, redirect: "manual" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      (init as RequestInit & { body: string }).body = JSON.stringify(body);
    }
    const response = await this.#dispatch(method, url, init);
    return await this.#parse<T>(response, path);
  }

  /**
   * @internal
   * Core dispatcher shared by every verb helper: per-attempt timeout via
   * `AbortController`, and an idempotent-verb (`GET`/`HEAD`/`OPTIONS`)
   * retry-with-backoff loop on `{502,503,504}` and raw network errors — the
   * exact policy `RelataClient`'s `#send` already implements (#2489),
   * shared via the exported `isIdempotentMethod`/`RETRYABLE_STATUS_CODES`
   * from `client.ts` rather than re-diverging a second copy (#2731).
   *
   * Returns the raw `Response` (2xx or a non-retried non-2xx) for the
   * caller to decode/classify; only timeouts and exhausted network errors
   * throw from here.
   */
  async #dispatch(method: string, url: string, init: RequestInit): Promise<Response> {
    const maxAttempts = Math.max(1, this.#maxRetries + 1);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer =
        this.#timeoutMs > 0
          ? setTimeout(() => controller.abort(), this.#timeoutMs)
          : undefined;

      try {
        const response = await this.#fetch(url, {
          ...init,
          signal: controller.signal,
        });
        assertNotRedirected(response, url);
        const canRetryStatus =
          !response.ok &&
          isIdempotentMethod(method) &&
          RETRYABLE_STATUS_CODES.has(response.status);
        if (canRetryStatus && attempt + 1 < maxAttempts) {
          await this.#sleep(this.#retryBackoffMs * 2 ** attempt);
          continue;
        }
        return response;
      } catch (err) {
        if (err instanceof Error && this.#isAbortError(err)) {
          // Timeout — never retry (the operation may have side effects).
          throw new TimeoutError(this.#timeoutMs);
        }
        if (err instanceof RelataError) throw err;
        if (err instanceof Error) {
          const wrapped = new NetworkError(
            `Failed to reach Relata at ${url}: ${err.message}`,
            err,
          );
          lastError = wrapped;
          if (isIdempotentMethod(method) && attempt + 1 < maxAttempts) {
            await this.#sleep(this.#retryBackoffMs * 2 ** attempt);
            continue;
          }
          throw wrapped;
        }
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    // Defensive: the loop above always returns or throws on the final
    // attempt. If we ever reach here, surface whatever we last saw.
    throw lastError;
  }

  /**
   * @internal
   * `path` is the request path as sent (not derived from `response.url`,
   * which is the empty string for a `Response` built without going through a
   * real `fetch()` call — e.g. in tests).
   */
  async #parse<T>(response: Response, path: string): Promise<T> {
    const contentType = response.headers.get("content-type") ?? "";
    const isJson =
      contentType.includes("application/json") ||
      contentType.includes("application/problem+json");
    const body: unknown = isJson
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw this.#classify(response.status, path, isJson, body, response.headers);
    }
    return (body ?? {}) as T;
  }

  /**
   * @internal
   * Classify a decoded non-2xx response body into the typed `RelataError`
   * subclass `mapHttpError` (`errors.ts`) selects for `status` —
   * `AuthError` (401), `ForbiddenError` (403), `NotFoundError` (404),
   * `ConflictError` (409), `ValidationError` (422), `RateLimitedError`
   * (429), `ServerError` (5xx) — instead of always collapsing to the
   * generic `TypedHttpError` (#2731). Any status `mapHttpError` doesn't
   * specialize falls back to the same generic `RelataError` shape the main
   * `RelataClient` uses for that case.
   */
  #classify(
    status: number,
    path: string,
    isJson: boolean,
    body: unknown,
    headers: Headers,
  ): RelataError {
    const err =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : { error: typeof body === "string" ? body : "empty response" };
    let serverMessage =
      (typeof err["detail"] === "string" && err["detail"]) ||
      (typeof err["error"] === "string" && err["error"]) ||
      (typeof err["message"] === "string" && err["message"]) ||
      `HTTP ${status}`;
    // #2321 (ADR-0261): a bare 404 with no detail text against an
    // admin/platform-only path almost always means this client is pointed
    // at the data-plane listener rather than the loopbound admin listener
    // those routes are exclusively mounted on — surface a hint instead of
    // an uninformative bare 404.
    if (status === 404 && isAdminOnlyPath(path) && responseDetailIsBlank(isJson, body)) {
      serverMessage = adminListenerHint(path);
    }
    const requestId = headers.get("x-request-id") ?? undefined;
    const retryAfter = headers.get("Retry-After");
    const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
    // #1321: surface the X-RateLimit-* quota headers on 429s, same as
    // RelataClient's #parseResponse.
    const parseRateLimit = (h: string): number | undefined => {
      const v = headers.get(h);
      const n = v ? parseInt(v, 10) : NaN;
      return Number.isFinite(n) ? n : undefined;
    };
    return mapHttpError(status, serverMessage, {
      queryId: typeof err["query_id"] === "string" ? err["query_id"] : undefined,
      code: typeof err["code"] === "string" ? err["code"] : undefined,
      typeUrl: typeof err["type"] === "string" ? err["type"] : undefined,
      retryable: err["retryable"] === true,
      requestId,
      retryAfterSeconds,
      rateLimitLimit: parseRateLimit("X-RateLimit-Limit"),
      rateLimitRemaining: parseRateLimit("X-RateLimit-Remaining"),
      rateLimitReset: parseRateLimit("X-RateLimit-Reset"),
    });
  }

  /** @internal */
  #buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.#extraHeaders,
    };
    if (this.#bearerToken !== undefined) {
      headers["Authorization"] = `Bearer ${this.#bearerToken}`;
    }
    headers["X-Request-ID"] =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `relata-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return headers;
  }

  /** @internal */
  #isAbortError(err: Error): boolean {
    return err.name === "AbortError" || err.message.includes("aborted");
  }

  /** @internal Promise-based sleep for the retry backoff (#2731). */
  async #sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// TypedHttpError
// ---------------------------------------------------------------------------

/**
 * @internal
 * Carries the decoded error body so callers can inspect RFC 7807 `code`,
 * `type`, `retryable`, `request_id` fields — mirrors the Python
 * `_classify_error` output shape.
 *
 * As of #2731, typed-client requests no longer throw this class for
 * classifiable statuses: `TypedClientBase.#classify` routes every non-2xx
 * response through `mapHttpError()` (`errors.ts`), so 401/403/404/409/422/
 * 429/5xx responses now throw `AuthError`/`ForbiddenError`/`NotFoundError`/
 * `ConflictError`/`ValidationError`/`RateLimitedError`/`ServerError`
 * respectively — the same typed hierarchy `RelataClient` throws — instead of
 * always collapsing to this generic class. `TypedHttpError` is retained here
 * as part of this module's exported surface for any external caller still
 * constructing or referencing it directly.
 */
export class TypedHttpError extends RelataError {
  readonly body: Record<string, unknown>;

  constructor(
    statusCode: number,
    serverMessage: string,
    body: Record<string, unknown>,
    requestId: string | undefined,
  ) {
    super(
      `[HTTP ${statusCode}] ${serverMessage}`,
      statusCode,
      serverMessage,
      typeof body["query_id"] === "string" ? body["query_id"] : undefined,
      {
        code: typeof body["code"] === "string" ? body["code"] : undefined,
        typeUrl: typeof body["type"] === "string" ? body["type"] : undefined,
        retryable: body["retryable"] === true,
        requestId,
      },
    );
    this.name = "TypedHttpError";
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Query-string helper
// ---------------------------------------------------------------------------

/**
 * @internal
 * Build a query string from a record, skipping `undefined` values. Used by
 * every typed client that sends GET filters.
 */
export function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    sp.set(k, String(v));
  }
  const out = sp.toString();
  return out ? `?${out}` : "";
}
