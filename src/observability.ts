/**
 * Observability stream SDK (#3822, #3828) — SSE consumer for
 * `GET /observe/stream`.
 *
 * The server streams structured `ObservabilityEvent` JSON objects — one per
 * `data: {...}\n\n` SSE line. The endpoint is opt-in via
 * `RELATA_OBSERVE_STREAM=on`, requires bearer auth, and is tenant-scoped
 * server-side (the SDK forwards `X-Relata-Tenant-Id` via the parent client's
 * inherited header bag).
 *
 * TypeScript is async-native, so the stream is exposed as an
 * `AsyncGenerator<ObservabilityEvent>` —
 * `for await (const ev of observe.observeStream()) { ... }` — mirroring the
 * {@link StreamingClient} SSE consumers (`watch`, `alerts`).
 */

import { RelataClient } from "./client.ts";
import { assertNotRedirected } from "./errors.ts";
import { StreamingHttpError } from "./streaming.ts";

/**
 * A single structured observability event yielded by `GET /observe/stream`.
 *
 * Field names are preserved verbatim from the server's `ObservabilityEvent`
 * JSON wire shape (snake_case), so the SDK object is a structural match of
 * the wire payload — no client-side rename layer to drift out of sync.
 */
export interface ObservabilityEvent {
  ts_ns: number;
  level: string;
  target: string;
  kind: string;
  door: string | null;
  purpose: string | null;
  tenant_id: string | null;
  trace_id: string | null;
  stage: string | null;
  sql_template: string | null;
  rows: number | null;
  latency_ms: number | null;
  error: string | null;
  message: string;
}

/**
 * Observability SSE client — async-iterable stream of
 * {@link ObservabilityEvent} from the governed `/observe/stream` door.
 */
export class ObservabilityClient {
  readonly #client: RelataClient;

  constructor(client: RelataClient) {
    this.#client = client;
  }

  /** Inherit the parent client (the stream runs under its auth/tenant). */
  static fromClient(client: RelataClient): ObservabilityClient {
    return new ObservabilityClient(client);
  }

  /** @internal Build the parent client's header bag for the stream call. */
  #headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
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

  /**
   * Stream structured observability events from `GET /observe/stream`.
   *
   * The server emits one `data: {...}\n\n` SSE line per
   * {@link ObservabilityEvent}; this generator yields each parsed JSON object
   * as it arrives, with no buffering beyond a single SSE frame. The stream
   * stays open until the server closes it, the network drops, or the caller
   * breaks out of the `for await` loop (which cancels the underlying
   * `ReadableStream` reader via the `finally` block).
   *
   * Requires `RELATA_OBSERVE_STREAM=on` server-side and a valid bearer token.
   *
   * @throws {StreamingHttpError} The server returned a non-2xx status (e.g.
   *   404 when the door is disabled, 401 when the token is missing/invalid).
   *
   * @example
   * ```typescript
   * const observe = ObservabilityClient.fromClient(relata);
   * for await (const ev of observe.observeStream()) {
   *   console.log(`[${ev.level}] ${ev.target}: ${ev.message}`);
   *   if (ev.kind === "sql.query") {
   *     console.log(`  ${ev.rows} rows in ${ev.latency_ms}ms`);
   *   }
   * }
   * ```
   */
  async *observeStream(): AsyncGenerator<ObservabilityEvent> {
    const url = `${this.#client.baseUrl}/observe/stream`;
    const response = await this.#client.fetchImpl(url, {
      method: "GET",
      headers: this.#headers(),
      redirect: "manual",
    });
    assertNotRedirected(response, url);
    if (!response.ok) {
      const bodyText = await response.text();
      throw new StreamingHttpError(response.status, bodyText);
    }
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
        // SSE frames are separated by a blank line (`\n\n`). The trailing
        // partial frame is retained in `buffer` for the next chunk; complete
        // frames are processed now.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLine = frame
            .split("\n")
            .find((l) => l.startsWith("data:"));
          if (dataLine === undefined) continue;
          const json = dataLine.slice(5).trim();
          // Skip SSE comments / keep-alive blanks and non-JSON payloads.
          if (json.startsWith("{")) {
            yield JSON.parse(json) as ObservabilityEvent;
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore cancel errors
      }
    }
  }
}
