/**
 * Streaming SDK (#75) — SSE consumers + NDJSON row streams + Arrow IPC.
 *
 * The server ships streaming surfaces at:
 * - `POST /v1/query/arrow` → Arrow IPC stream (columnar).
 * - `POST /v1/query/stream` with `Accept: text/event-stream` (or application/x-ndjson) → row stream.
 * - `GET /v1/watch/stream` → finite SSE polls — emits governed query-result
 *   notifications from the server's bounded background evaluator.
 * - `GET /v1/alerts/stream` → SSE — pushes alerts to subscribed principals.
 * - `GET /v1/a2a/tasks/:id/stream` → SSE — A2A task lifecycle events.
 * - `GET /v1/memory/recall/stream` → SSE — streaming memory recall.
 *
 * TypeScript is async-native, so every surface is exposed as an
 * `AsyncIterable<T>`. SSE consumers parse the
 * `event: <type>\n\ndata: <json>` framing per the spec and yield one parsed
 * event per server-sent event.
 */

import { RelataClient } from "./client.ts";
import { assertNotRedirected, httpProblemMetadata, PurposeError, RelataError, ResponseTooLargeError } from "./errors.ts";
import { bodyOrClosedStream, readCappedResponseBody } from "./_body.ts";

/** Streaming client — async iterators over every streaming surface. */
export class StreamingClient {
  readonly #client: RelataClient;

  constructor(client: RelataClient) {
    this.#client = client;
  }

  /** Inherit the parent client (queries execute under its auth/tenant). */
  static fromClient(client: RelataClient): StreamingClient {
    return new StreamingClient(client);
  }

  /** @internal Resolve the effective purpose or throw. */
  #purpose(purpose: string | undefined): string {
    const eff = purpose ?? this.#client.defaultPurpose;
    if (!eff) {
      throw new PurposeError(undefined, "Streaming queries require a purpose.");
    }
    return eff;
  }

  /** @internal Build the parent client's header bag for a streaming call. */
  #headers(extra?: Record<string, string>): Record<string, string> {
    const merged = new Headers({ Accept: "application/json" });
    for (const [key, value] of Object.entries(this.#client.extraHeaders)) merged.set(key, value);
    if (this.#client.internalBearerToken !== undefined) {
      merged.set("Authorization", `Bearer ${this.#client.internalBearerToken}`);
    }
    if (extra !== undefined) {
      for (const [key, value] of Object.entries(extra)) merged.set(key, value);
    }
    const headers: Record<string, string> = {};
    merged.forEach((value, key) => { headers[key] = value; });
    return headers;
  }

  // -------------------------------------------------------------------------
  // Row streaming (NDJSON)
  // -------------------------------------------------------------------------

  /**
   * Stream query results as NDJSON rows. Yields one `Record<string, unknown>`
   * per row. The response body is consumed lazily — the server does not
   * buffer the entire result.
   */
  async *queryRows(
    sql: string,
    opts: { purpose?: string } = {},
  ): AsyncIterable<Record<string, unknown>> {
    const purpose = this.#purpose(opts.purpose);
    const url = `${this.#client.baseUrl}/v1/query/stream`;
    const response = await this.#client.fetchImpl(url, {
      method: "POST",
      headers: this.#headers({ "Content-Type": "application/json", Accept: "application/x-ndjson" }),
      body: JSON.stringify({ purpose, sql }),
      redirect: "manual",
    });
    assertNotRedirected(response, url);
    if (!response.ok) {
      const text = new TextDecoder().decode(await readCappedResponseBody(response, this.#client.maxResponseBytes));
      throw new StreamingHttpError(response.status, text, response.headers);
    }
    yield* queryRowStream(response, this.#client.maxResponseBytes);
  }

  // -------------------------------------------------------------------------
  // Arrow IPC stream
  // -------------------------------------------------------------------------

  /**
   * Stream the raw Arrow IPC byte stream from `POST /v1/query/arrow`.
   * Yields raw byte chunks. Wrap with a columnar reader for typed
   * record-batch consumption.
   */
  async *queryArrowRaw(
    sql: string,
    opts: { purpose?: string } = {},
  ): AsyncIterable<Uint8Array> {
    const purpose = this.#purpose(opts.purpose);
    const url = `${this.#client.baseUrl}/v1/query/arrow`;
    const response = await this.#fetchImpl()(url, {
      method: "POST",
      headers: this.#headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ purpose, sql }),
      redirect: "manual",
    });
    assertNotRedirected(response, url);
    if (!response.ok) {
      throw new StreamingHttpError(response.status, new TextDecoder().decode(await readCappedResponseBody(response, this.#client.maxResponseBytes)), response.headers);
    }
    const reader = bodyOrClosedStream(response).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined && value.byteLength > 0) yield value;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore cancel errors
      }
    }
  }

  // -------------------------------------------------------------------------
  // SSE consumers (watch / alerts)
  // -------------------------------------------------------------------------

  /**
   * SSE poll consumer for `GET /v1/watch/stream`. The server emits
   * `result_changed` hashes, `gap`, and `evaluation_failed` notifications;
   * it does not stream changed row contents. Reconnects poll the same
   * consumptive queue for this authenticated principal, so concurrent polls
   * with the same principal share delivery. Registrations are in-memory and
   * must be re-established after a server restart.
   *
   * Reconnects with exponential backoff until the caller breaks out of the
   * `for await` loop.
   */
  async *watch(
    sql: string,
    purpose: string,
    opts: { reconnect?: boolean } = {},
  ): AsyncIterable<Record<string, unknown>> {
    const params = new URLSearchParams({ sql, purpose });
    yield* this.sseStream(
      `/v1/watch/stream?${params}`,
      opts.reconnect ?? true,
    );
  }

  /**
   * SSE consumer for `GET /v1/alerts/stream`. Yields alert events addressed to
   * the caller's principal / tenant.
   */
  async *alerts(
    opts: { reconnect?: boolean } = {},
  ): AsyncIterable<Record<string, unknown>> {
    yield* this.sseStream("/v1/alerts/stream", opts.reconnect ?? true);
  }

  /**
   * SSE consumer for `GET /v1/graph/changes` (real-time graph change stream).
   * `type` narrows to one object type; `tenantId` must match the caller's
   * authenticated tenant when supplied.
   */
  async *graphChanges(
    opts: { type?: string; tenantId?: string; reconnect?: boolean } = {},
  ): AsyncIterable<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (opts.type) params.set("type", opts.type);
    if (opts.tenantId) params.set("tenant_id", opts.tenantId);
    const q = params.toString();
    yield* this.sseStream(`/v1/graph/changes${q ? `?${q}` : ""}`, opts.reconnect ?? true);
  }

  /**
   * SSE consumer for `GET /v1/a2a/tasks/:id/stream` (A2A task lifecycle
   * events). A task stream is finite, so `reconnect` defaults to `false`.
   */
  async *a2aTaskStream(
    taskId: string,
    opts: { reconnect?: boolean } = {},
  ): AsyncIterable<Record<string, unknown>> {
    yield* this.sseStream(
      `/v1/a2a/tasks/${encodeURIComponent(taskId)}/stream`,
      opts.reconnect ?? false,
    );
  }

  /**
   * SSE consumer for `GET /v1/memory/recall/stream`. Yields the recall rows
   * as they are produced. A recall is finite, so `reconnect` defaults to
   * `false`.
   */
  async *recallStream(
    query: string,
    purpose: string,
    opts: { topK?: number; sessionId?: string; asOf?: string; reconnect?: boolean } = {},
  ): AsyncIterable<Record<string, unknown>> {
    const params = new URLSearchParams({ q: query, purpose });
    if (opts.topK !== undefined) params.set("top_k", String(opts.topK));
    if (opts.sessionId) params.set("session_id", opts.sessionId);
    if (opts.asOf) params.set("as_of", opts.asOf);
    yield* this.sseStream(`/v1/memory/recall/stream?${params}`, opts.reconnect ?? false);
  }

  /** @internal Generic SSE consumer with optional exponential-backoff reconnect. */
  private async *sseStream(
    path: string,
    reconnect: boolean,
  ): AsyncIterable<Record<string, unknown>> {
    const url = `${this.#client.baseUrl}${path}`;
    const maxRetries = 5;
    const baseBackoffMs = 1000;
    let retries = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.#fetchImpl()(url, {
          method: "GET",
          headers: this.#headers({ Accept: "text/event-stream" }),
          redirect: "manual",
        });
        assertNotRedirected(response, url);
      } catch {
        // A blocked redirect (see #2364) or a raw network failure both land
        // here — neither is worth retrying against the same origin.
        if (!reconnect || retries >= maxRetries) return;
        await sleep(baseBackoffMs * 2 ** Math.min(retries, 5));
        retries++;
        continue;
      }
      if (!response.ok) {
        await readCappedResponseBody(response, this.#client.maxResponseBytes);
        if (!reconnect || retries >= maxRetries) return;
        await sleep(baseBackoffMs * 2 ** Math.min(retries, 5));
        retries++;
        continue;
      }
      // Reset retry counter once we have a working connection.
      retries = 0;
      try {
        for await (const ev of sseEvents(response)) {
          yield ev;
        }
      } catch {
        // fall through to reconnect branch below
      }
      if (!reconnect) return;
      await sleep(baseBackoffMs * 2 ** Math.min(retries, 5));
      retries++;
      if (retries > maxRetries) return;
    }
  }

  /** @internal Reach the parent client's native fetch impl. */
  #fetchImpl(): typeof globalThis.fetch {
    return this.#client.fetchImpl;
  }
}

// ---------------------------------------------------------------------------
// StreamingHttpError
// ---------------------------------------------------------------------------

/** Error thrown by streaming helpers when the server returns a non-2xx status. */
export class StreamingHttpError extends RelataError {
  readonly bodyText: string;
  readonly body: Record<string, unknown>;

  constructor(statusCode: number, bodyText: string, headers?: Headers) {
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch { /* Proxy/plain-text errors retain their exact bodyText. */ }
    const metadata = httpProblemMetadata(body, headers);
    const message = typeof body["detail"] === "string" ? body["detail"]
      : typeof body["error"] === "string" ? body["error"] : bodyText.slice(0, 200);
    super(`[HTTP ${statusCode}] ${message}`, statusCode, message, metadata.queryId, metadata);
    this.name = "StreamingHttpError";
    this.bodyText = bodyText;
    this.body = body;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A status-200 stream ended without a verified complete answer. Never auto-retry
 * after partial rows; callers must discard or explicitly reconcile that answer. */
export class IncompleteQueryStreamError extends RelataError {
  readonly rowsReceived: number;

  constructor(
    message: string,
    queryId: string | undefined,
    rowsReceived: number,
  ) {
    super(message, 200, message, queryId, { retryable: false });
    this.name = "IncompleteQueryStreamError";
    this.rowsReceived = rowsReceived;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

async function* queryRowStream(response: Response, frameCap: number): AsyncIterable<Record<string, unknown>> {
  let queryId: string | undefined;
  let rows = 0;
  let started = false;
  let terminal = false;
  const fail = (message: string): never => {
    throw new IncompleteQueryStreamError(message, queryId, rows);
  };
  const known = new Set(["query_id", "started_at", "columns", "processing_time_ms", "row_count", "truncated", "error"]);
  const unsigned = (value: unknown): boolean => typeof value === "number"
    && Number.isSafeInteger(value) && value >= 0;
  try {
    for await (const frame of ndjsonStream<unknown>(response, frameCap)) {
      if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
        fail("Query stream contains a non-object frame");
      }
      const row = frame as Record<string, unknown>;
      const value = row["_meta"];
      const meta = Object.keys(row).length === 1 && value !== null
        && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).some(key => known.has(key))
        ? value as Record<string, unknown> : undefined;
      if (terminal) fail("Query stream contains data after its terminal frame");
      if (meta !== undefined) {
        if (!started) {
          if (typeof meta["query_id"] !== "string" || !unsigned(meta["started_at"])
              || !Array.isArray(meta["columns"]) || !meta["columns"].every(c => typeof c === "string")) {
            fail("Query stream has a malformed leading metadata frame");
          }
          queryId = meta["query_id"] as string;
          started = true;
          continue;
        }
        if (!unsigned(meta["processing_time_ms"]) || !unsigned(meta["row_count"])
            || typeof meta["truncated"] !== "boolean"
            || (meta["error"] !== undefined && typeof meta["error"] !== "string")) {
          fail("Query stream has a malformed terminal metadata frame");
        }
        if (meta["truncated"] === true || meta["error"] !== undefined) {
          fail("Query stream reports an incomplete answer");
        }
        if (meta["row_count"] !== rows) fail("Query stream terminal row count does not match received rows");
        terminal = true;
        continue;
      }
      if (!started) fail("Query stream is missing its leading metadata frame");
      rows++;
      yield row;
    }
    if (!terminal) fail("Query stream ended without a terminal completion frame");
  } catch (error) {
    if (error instanceof IncompleteQueryStreamError || error instanceof ResponseTooLargeError) throw error;
    fail("Query stream framing or transport failed before verified completion");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @internal Walk a `Response.body` ReadableStream and yield parsed NDJSON rows. */
async function* ndjsonStream<T>(
  response: Response,
  frameCap: number,
): AsyncIterable<T> {
  const body = bodyOrClosedStream(response);
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let frameBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      let start = 0;
      for (let end = 0; end <= value.byteLength; end++) {
        if (end !== value.byteLength && value[end] !== 10) continue;
        const bytes = end - start;
        if (bytes > frameCap - frameBytes) throw new ResponseTooLargeError(frameCap);
        frameBytes += bytes;
        buffer += decoder.decode(value.subarray(start, end), { stream: true });
        if (end !== value.byteLength) {
          buffer += decoder.decode();
          const line = buffer.trim();
          if (line.length > 0) yield JSON.parse(line) as T;
          buffer = "";
          frameBytes = 0;
        }
        start = end + 1;
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.length > 0) yield JSON.parse(tail) as T;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}

/** @internal Walk a `Response.body` ReadableStream and yield parsed SSE events. */
async function* sseEvents(
  response: Response,
): AsyncIterable<Record<string, unknown>> {
  const body = bodyOrClosedStream(response);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType: string | undefined;
  let dataLines: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = raw.replace(/\r$/, "");
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        } else if (line === "" && dataLines.length > 0) {
          const rawPayload = dataLines.join("\n");
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(rawPayload) as Record<string, unknown>;
          } catch {
            payload = { raw: rawPayload };
          }
          if (eventType !== undefined) payload["event"] = eventType;
          yield payload;
          eventType = undefined;
          dataLines = [];
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}

/** @internal Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
