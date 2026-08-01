/**
 * @internal
 * Shared HTTP plumbing for the typed v1.1 clients.
 *
 * Each typed client (governance, mcp, a2a, audit, identity, objects, ingest,
 * vectors, system, tenants, backup, tokens, log) extends
 * {@link TypedClientBase} to inherit transport, auth, tenant header
 * propagation, X-Request-ID generation, and basic error mapping. Each method
 * on the subclasses is a thin wrapper that picks a path, a method, and a body
 * shape — copied verbatim from the Python reference.
 *
 * The base class mirrors the Python `_http.HttpTransport` semantics: per-
 * attempt X-Request-ID, `application/json` body for POST/PUT/PATCH, query-
 * string builders for GET with params.
 */

import { NetworkError, RelataError, TimeoutError } from "./errors.ts";
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
  timeoutMs?: number;
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
  readonly #extraHeaders: Record<string, string>;
  readonly #fetch: typeof globalThis.fetch;

  constructor(opts: TypedClientCtor) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#adminBaseUrl = opts.adminBaseUrl?.replace(/\/+$/, "");
    this.#bearerToken = opts.bearerToken;
    this.#timeoutMs = opts.timeoutMs ?? 0;
    this.#extraHeaders = opts.extraHeaders ?? {};
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** @internal Build a fresh options bag from a parent RelataClient. */
  static clientToCtor(client: RelataClient): TypedClientCtor {
    const ctor: TypedClientCtor = {
      baseUrl: client.baseUrl,
      extraHeaders: client.extraHeaders,
      // Propagate the parent's fetch override (testing / observability).
      fetch: client.fetchImpl,
    };
    if (client.bearerToken !== undefined) ctor.bearerToken = client.bearerToken;
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
  ): Promise<T> {
    const url = `${this.#resolveBaseUrl(path)}${path}`;
    const controller = new AbortController();
    const timer =
      this.#timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.#timeoutMs)
        : undefined;

    try {
      const headers = this.#buildHeaders();
      headers["Content-Type"] = contentType;

      const response = await this.#fetch(url, {
        method,
        headers,
        signal: controller.signal,
        body,
      });
      return await this.#parse<T>(response, path);
    } catch (err) {
      if (err instanceof Error && this.#isAbortError(err)) {
        throw new TimeoutError(this.#timeoutMs);
      }
      if (err instanceof RelataError) throw err;
      if (err instanceof Error) {
        throw new NetworkError(
          `Failed to reach Relata at ${url}: ${err.message}`,
          err,
        );
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
    const controller = new AbortController();
    const timer =
      this.#timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.#timeoutMs)
        : undefined;

    try {
      const headers = this.#buildHeaders();
      headers["Content-Type"] = "application/json";
      const response = await this.#fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        let errBody: Record<string, unknown>;
        try {
          errBody = (await response.json()) as Record<string, unknown>;
        } catch {
          errBody = { error: `HTTP ${response.status}` };
        }
        const serverMessage =
          (typeof errBody["detail"] === "string" && errBody["detail"]) ||
          (typeof errBody["error"] === "string" && errBody["error"]) ||
          (typeof errBody["message"] === "string" && errBody["message"]) ||
          `HTTP ${response.status}`;
        throw new TypedHttpError(
          response.status,
          serverMessage,
          errBody,
          response.headers.get("x-request-id") ?? undefined,
        );
      }
      const buf = await response.arrayBuffer();
      return new Uint8Array(buf);
    } catch (err) {
      if (err instanceof RelataError) throw err;
      if (err instanceof Error && this.#isAbortError(err)) {
        throw new TimeoutError(this.#timeoutMs);
      }
      if (err instanceof Error) {
        throw new NetworkError(
          `Failed to reach Relata at ${url}: ${err.message}`,
          err,
        );
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
    const controller = new AbortController();
    const timer =
      this.#timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.#timeoutMs)
        : undefined;

    try {
      const headers = this.#buildHeaders();
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        (init as RequestInit & { body: string }).body = JSON.stringify(body);
      }

      const response = await this.#fetch(url, init);
      return await this.#parse<T>(response, path);
    } catch (err) {
      if (err instanceof Error && this.#isAbortError(err)) {
        throw new TimeoutError(this.#timeoutMs);
      }
      if (err instanceof RelataError) throw err;
      if (err instanceof Error) {
        throw new NetworkError(
          `Failed to reach Relata at ${url}: ${err.message}`,
          err,
        );
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
      const err =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)
          : { error: typeof body === "string" ? body : "empty response" };
      let serverMessage =
        (typeof err["detail"] === "string" && err["detail"]) ||
        (typeof err["error"] === "string" && err["error"]) ||
        (typeof err["message"] === "string" && err["message"]) ||
        `HTTP ${response.status}`;
      // #2321 (ADR-0261): a bare 404 with no detail text against an
      // admin/platform-only path almost always means this client is pointed
      // at the data-plane listener rather than the loopbound admin listener
      // those routes are exclusively mounted on — surface a hint instead of
      // an uninformative bare 404.
      if (response.status === 404 && isAdminOnlyPath(path) && responseDetailIsBlank(isJson, body)) {
        serverMessage = adminListenerHint(path);
      }
      throw new TypedHttpError(
        response.status,
        serverMessage,
        err,
        response.headers.get("x-request-id") ?? undefined,
      );
    }
    return (body ?? {}) as T;
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
}

// ---------------------------------------------------------------------------
// TypedHttpError
// ---------------------------------------------------------------------------

/**
 * @internal
 * Typed error thrown by typed clients on non-2xx responses. Mirrors the
 * Python `_classify_error` output: carries the decoded body so callers can
 * inspect RFC 7807 `code`, `type`, `retryable`, `request_id` fields.
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
