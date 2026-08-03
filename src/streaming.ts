/**
 * Streaming SDK (#75) — SSE consumers + NDJSON row streams + Arrow IPC.
 *
 * The server ships streaming surfaces at:
 * - `POST /query/arrow` → Arrow IPC stream (columnar).
 * - `POST /query` with `Accept: text/event-stream` (or NDJSON body) → row stream.
 * - `GET /watch/stream` → SSE — pushes `RowsAppended` events on commits.
 * - `GET /alerts/stream` → SSE — pushes alerts to subscribed principals.
 * - `GET /a2a/tasks/:id/stream` → SSE — A2A task lifecycle events.
 *
 * TypeScript is async-native, so every surface is exposed as an
 * `AsyncIterable<T>`. SSE consumers parse the
 * `event: <type>\n\ndata: <json>` framing per the spec and yield one parsed
 * event per server-sent event.
 */

import { RelataClient } from "./client.ts";
import { assertNotRedirected, PurposeError } from "./errors.ts";

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
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.#client.extraHeaders,
    };
    if (this.#client.internalBearerToken !== undefined) {
      headers["Authorization"] = `Bearer ${this.#client.internalBearerToken}`;
    }
    if (extra !== undefined) {
      for (const [k, v] of Object.entries(extra)) headers[k] = v;
    }
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
    const url = `${this.#client.baseUrl}/query`;
    const response = await this.#client.fetchImpl(url, {
      method: "POST",
      headers: this.#headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ purpose, sql }),
      redirect: "manual",
    });
    assertNotRedirected(response, url);
    if (!response.ok) {
      const text = await response.text();
      throw new StreamingHttpError(response.status, text);
    }
    yield* ndjsonStream<Record<string, unknown>>(response);
  }

  // -------------------------------------------------------------------------
  // Arrow IPC stream
  // -------------------------------------------------------------------------

  /**
   * Stream the raw Arrow IPC byte stream from `POST /query/arrow`.
   * Yields raw byte chunks. Wrap with a columnar reader for typed
   * record-batch consumption.
   */
  async *queryArrowRaw(
    sql: string,
    opts: { purpose?: string } = {},
  ): AsyncIterable<Uint8Array> {
    const purpose = this.#purpose(opts.purpose);
    const url = `${this.#client.baseUrl}/query/arrow`;
    const response = await this.#fetchImpl()(url, {
      method: "POST",
      headers: this.#headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ purpose, sql }),
      redirect: "manual",
    });
    assertNotRedirected(response, url);
    if (!response.ok) {
      await drainBody(response);
      throw new StreamingHttpError(response.status, await response.text());
    }
    const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader();
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
   * SSE consumer for `GET /watch/stream`. Yields `RowsAppended` events as
   * commits matching the watch SQL land.
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
      `/watch/stream?${params}`,
      opts.reconnect ?? true,
    );
  }

  /**
   * SSE consumer for `GET /alerts/stream`. Yields alert events addressed to
   * the caller's principal / tenant.
   */
  async *alerts(
    opts: { reconnect?: boolean } = {},
  ): AsyncIterable<Record<string, unknown>> {
    yield* this.sseStream("/alerts/stream", opts.reconnect ?? true);
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
        await drainBody(response);
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
export class StreamingHttpError extends Error {
  readonly statusCode: number;
  readonly bodyText: string;

  constructor(statusCode: number, bodyText: string) {
    super(`[HTTP ${statusCode}] ${bodyText.slice(0, 200)}`);
    this.name = "StreamingHttpError";
    this.statusCode = statusCode;
    this.bodyText = bodyText;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @internal Walk a `Response.body` ReadableStream and yield parsed NDJSON rows. */
async function* ndjsonStream<T>(
  response: Response,
): AsyncIterable<T> {
  const body = response.body ?? new ReadableStream<Uint8Array>();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) {
          yield JSON.parse(line) as T;
        }
      }
    }
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
  const body = response.body ?? new ReadableStream<Uint8Array>();
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

/** @internal Drain a response body so the connection can be reused. */
async function drainBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // ignore
  }
}

/** @internal Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
