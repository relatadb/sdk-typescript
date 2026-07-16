/**
 * Memory — Mem0-style high-level memory client (#684).
 *
 * A thin convenience layer over Relata's governed `/memory/*` verbs (ADR-144)
 * so the common agent-memory case is a one-liner instead of hand-built
 * requests:
 *
 * ```typescript
 * import { Memory } from "@zysec-ai/relata-sdk";
 *
 * const m = new Memory("http://localhost:8080", { purpose: "agent-notes" });
 * const memId = await m.add("Alice prefers dark mode");
 * const hits = await m.search("ui preferences", { topK: 5 });
 * await m.forget(memId);
 * await m.close();
 * ```
 *
 * Governance stays on: a non-empty `purpose` is required (the server records
 * it for audit and enforces ACL). `forget` is a governed, retention-policy
 * retract, not a hard delete.
 *
 * TypeScript is async-native, so every method returns a `Promise` — there is
 * no separate `AsyncMemory` (the SDK-wide parity decision, see the README).
 */

import { NetworkError, PurposeError, TimeoutError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for constructing a {@link Memory} client.
 */
export interface MemoryOptions {
  /**
   * Declared purpose token, recorded for audit and enforced by ACL.
   * **Required and non-empty** — constructing a `Memory` without one throws.
   */
  purpose: string;
  /** Optional bearer token (required when the server sets `RELATA_BEARER_TOKEN`). */
  bearerToken?: string;
  /** Default session id applied to `add`/`search` when not overridden per call. */
  sessionId?: string;
  /** Per-request timeout in milliseconds. `0` means no timeout (default). */
  timeoutMs?: number;
  /** Optional caller-supplied headers overlaid on every request. */
  headers?: Record<string, string>;
  /** Override `fetch` (testing / observability). Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Unwrap the MCP envelope the memory verbs return.
 *
 * The server replies
 * `{"content": [{"type": "text", "text": "<json>"}], "isError": false}`
 * where the actual result is JSON encoded inside `content[0].text`. Returns
 * the decoded inner object, or the response unchanged when it is already flat.
 */
function unwrapMcp(resp: Record<string, unknown>): Record<string, unknown> {
  const content = resp["content"];
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0];
    const text = typeof first === "object" && first !== null
      ? (first as Record<string, unknown>)["text"]
      : undefined;
    if (typeof text === "string") {
      try {
        const inner: unknown = JSON.parse(text);
        if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
          return inner as Record<string, unknown>;
        }
        return { value: inner };
      } catch {
        return { text };
      }
    }
  }
  return resp;
}

/**
 * Normalise `addBatch` inputs into `remember/batch` item dicts.
 *
 * Each input is either a plain string (content) or a dict with `content`
 * and optional `confidence` / `memoryClass` / `sessionId` / `purpose`.
 * A missing `sessionId` inherits `defaultSession`.
 */
function batchItems(
  items: Array<string | Record<string, unknown>>,
  defaultSession: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const it of items) {
    if (typeof it === "string") {
      out.push({ content: it, session_id: defaultSession });
    } else {
      const d: Record<string, unknown> = { ...it };
      if (d["session_id"] === undefined) d["session_id"] = defaultSession;
      out.push(d);
    }
  }
  return out;
}

/**
 * Pull the per-item ids out of a `remember/batch` response.
 *
 * Positions that failed validation carry no `id` and yield `""` so the
 * returned list stays index-aligned with the submitted items.
 */
function batchIds(result: Record<string, unknown>): string[] {
  const rows = result["results"];
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    if (typeof r === "object" && r !== null) {
      const id = (r as Record<string, unknown>)["id"];
      return id !== undefined && id !== null ? String(id) : "";
    }
    return "";
  });
}

/** Percent-encode a string for safe use in a URL path or query segment. */
function enc(s: string): string {
  return encodeURIComponent(s);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * High-level memory client — `add` / `search` / `forget` plus the five
 * v1.1 cognitive verbs (`associate`, `episodes`, `justify`, `resolve`,
 * `summarise`).
 *
 * Construct with `new Memory(baseUrl, { purpose: "...", ... })`. A non-empty
 * `purpose` is mandatory — governance is always on.
 */
export class Memory {
  readonly #baseUrl: string;
  readonly #bearerToken: string | undefined;
  readonly #purpose: string;
  readonly #sessionId: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #extraHeaders: Record<string, string>;

  /**
   * Construct a high-level memory client.
   *
   * @param baseUrl - Relata server URL, e.g. `"http://localhost:8080"`.
   * @param options - Must include a non-empty `purpose`.
   *
   * @throws {PurposeError} When `purpose` is missing or empty.
   */
  constructor(baseUrl: string, options: MemoryOptions) {
    if (!options.purpose) {
      throw new PurposeError(
        undefined,
        "purpose is required and must be non-empty (governance is on)",
      );
    }
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#bearerToken = options.bearerToken;
    this.#purpose = options.purpose;
    this.#sessionId = options.sessionId ?? "";
    this.#timeoutMs = options.timeoutMs ?? 0;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#extraHeaders = options.headers ?? {};
  }

  // -------------------------------------------------------------------------
  // add / addBatch
  // -------------------------------------------------------------------------

  /**
   * Store a memory and return its id.
   *
   * @param content - The memory content to store.
   * @param opts - `confidence` (0–1, default 1.0), `memoryClass`
   *        (`"episodic" | "semantic" | "procedural"`, default `"semantic"`),
   *        `sessionId` (overrides the client default).
   */
  async add(
    content: string,
    opts: {
      confidence?: number;
      memoryClass?: string;
      sessionId?: string;
    } = {},
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      content,
      purpose: this.#purpose,
      confidence: opts.confidence ?? 1.0,
      memory_class: opts.memoryClass ?? "semantic",
      session_id: opts.sessionId ?? this.#sessionId,
    };
    const result = unwrapMcp(
      await this.#post("/memory/remember", payload),
    );
    const id = result["id"];
    return id !== undefined && id !== null ? String(id) : "";
  }

  /**
   * Store many memories in one request; return their ids in order.
   *
   * Each item is either a string (content) or a dict with `content` and
   * optional `confidence` / `memoryClass` / `sessionId` / `purpose`. This is
   * the high-throughput write path: the server amortises the full-text index
   * flush across the whole batch instead of once per record. Items that fail
   * validation yield `""` at their position; valid items still commit.
   */
  async addBatch(
    items: Array<string | Record<string, unknown>>,
    opts: { sessionId?: string } = {},
  ): Promise<string[]> {
    const defaultSession = opts.sessionId ?? this.#sessionId;
    const payload: Record<string, unknown> = {
      purpose: this.#purpose,
      items: batchItems(items, defaultSession),
    };
    const result = unwrapMcp(
      await this.#post("/memory/remember/batch", payload),
    );
    return batchIds(result);
  }

  // -------------------------------------------------------------------------
  // search / get / update / forget
  // -------------------------------------------------------------------------

  /**
   * Recall memories ranked by confidence × recency × relevance.
   *
   * @returns The ranked rows (each with `id`, `content`, `confidence`,
   *          `score`, `memory_class`).
   */
  async search(
    query: string,
    opts: {
      topK?: number;
      sessionId?: string;
      asOf?: string;
    } = {},
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams();
    params.set("q", query);
    params.set("purpose", this.#purpose);
    params.set("top_k", String(opts.topK ?? 5));
    const sid = opts.sessionId ?? this.#sessionId;
    if (sid) params.set("session_id", sid);
    if (opts.asOf) params.set("as_of", opts.asOf);
    const result = unwrapMcp(await this.#get(`/memory/recall?${params}`));
    const rows = result["rows"];
    return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
  }

  /**
   * Fetch a single memory by id, or `null` if not found.
   */
  async get(memoryId: string): Promise<Record<string, unknown> | null> {
    const path = `/memory/recognize/${enc(memoryId)}?purpose=${enc(this.#purpose)}`;
    const result = unwrapMcp(await this.#get(path));
    const memory = result["memory"];
    return typeof memory === "object" && memory !== null && !Array.isArray(memory)
      ? (memory as Record<string, unknown>)
      : null;
  }

  /**
   * Supersede `memoryId` with new `content` (governed); return the new id.
   */
  async update(memoryId: string, content: string): Promise<string> {
    const payload: Record<string, unknown> = {
      id: memoryId,
      content,
      purpose: this.#purpose,
    };
    const result = unwrapMcp(
      await this.#post("/memory/consolidate", payload),
    );
    const newId = result["new_id"];
    return newId !== undefined && newId !== null ? String(newId) : "";
  }

  /**
   * Schedule a governed retention-policy retract for `memoryId`.
   *
   * **Not a hard delete** — returns the policy decision (`memory_item_id`,
   * `policy`, `forget_at_ns`).
   */
  async forget(memoryId: string): Promise<Record<string, unknown>> {
    const path = `/memory/forget/${enc(memoryId)}?purpose=${enc(this.#purpose)}`;
    return unwrapMcp(await this.#delete(path));
  }

  // -------------------------------------------------------------------------
  // v1.1 — five cognitive verbs (#77)
  // -------------------------------------------------------------------------

  /**
   * Link two memories with a typed relation.
   *
   * Wraps `POST /memory/associate`. Returns the association record
   * (`source_id`, `target_id`, `relation`, `confidence`).
   */
  async associate(
    sourceId: string,
    targetId: string,
    relation: string,
    opts: { confidence?: number } = {},
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      source_id: sourceId,
      target_id: targetId,
      relation,
      confidence: opts.confidence ?? 1.0,
      purpose: this.#purpose,
    };
    return unwrapMcp(await this.#post("/memory/associate", payload));
  }

  /**
   * List episodes with full `Episode` detail.
   *
   * Wraps `GET /memory/episodes`. Optional `sessionId` filters to one
   * session; `asOf` makes the lookup bi-temporal.
   */
  async episodes(
    opts: { sessionId?: string; asOf?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams();
    params.set("purpose", this.#purpose);
    const sid = opts.sessionId ?? this.#sessionId;
    if (sid) params.set("session_id", sid);
    if (opts.asOf) params.set("as_of", opts.asOf);
    const result = unwrapMcp(await this.#get(`/memory/episodes?${params}`));
    const rows =
      typeof result === "object" && result !== null
        ? (result["rows"] ?? result)
        : result;
    return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
  }

  /**
   * Return the PROV-O assertion chain for `memoryId`.
   *
   * Wraps `GET /memory/justify/<id>`. The chain explains how the memory was
   * derived — source session, tool call, prior belief, etc.
   */
  async justify(memoryId: string): Promise<Record<string, unknown>> {
    const path = `/memory/justify/${enc(memoryId)}?purpose=${enc(this.#purpose)}`;
    return unwrapMcp(await this.#get(path));
  }

  /**
   * Resolve a contradiction between `memoryId` and a newer belief.
   *
   * Wraps `POST /memory/resolve/<id>`. The `policy` selects the resolver
   * (`"latest_wins"` / `"highest_confidence"` / `"manual"`). Returns the
   * resolution record.
   */
  async resolve(
    memoryId: string,
    opts: { policy?: string } = {},
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      policy: opts.policy ?? "latest_wins",
      purpose: this.#purpose,
    };
    return unwrapMcp(
      await this.#post(`/memory/resolve/${enc(memoryId)}`, payload),
    );
  }

  /**
   * Produce a summary belief from a set of source memories.
   *
   * Wraps `POST /memory/summarise`. `sourceIds` is the list of memory ids to
   * summarise; `summaryContent` lets the caller supply the summary text (the
   * server otherwise derives one). Returns the new summary memory.
   */
  async summarise(
    sourceIds: string[],
    opts: { summaryContent?: string } = {},
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      source_ids: sourceIds,
      purpose: this.#purpose,
    };
    if (opts.summaryContent !== undefined) {
      payload["summary_content"] = opts.summaryContent;
    }
    return unwrapMcp(await this.#post("/memory/summarise", payload));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Close the memory client. No-op on native `fetch` (there is no connection
   * pool to close); exists for API symmetry with the Python SDK and with
   * typed clients that do hold transport state.
   */
  async close(): Promise<void> {
    // Intentionally empty — native fetch has no pool to close.
  }

  // -------------------------------------------------------------------------
  // Internal HTTP helpers
  // -------------------------------------------------------------------------

  /** @internal */
  async #get(path: string): Promise<Record<string, unknown>> {
    return this.#send("GET", path, undefined);
  }

  /** @internal */
  async #post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.#send("POST", path, body);
  }

  /** @internal */
  async #delete(path: string): Promise<Record<string, unknown>> {
    return this.#send("DELETE", path, undefined);
  }

  /** @internal */
  async #send(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown>> {
    const url = `${this.#baseUrl}${path}`;
    const controller = new AbortController();
    const timer =
      this.#timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.#timeoutMs)
        : undefined;

    try {
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

      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        (init as RequestInit & { body: string }).body = JSON.stringify(body);
      }

      const response = await this.#fetch(url, init);
      const contentType = response.headers.get("content-type") ?? "";
      const isJson =
        contentType.includes("application/json") ||
        contentType.includes("application/problem+json");
      const payload: unknown = isJson
        ? await response.json()
        : { error: await response.text() };

      if (!response.ok) {
        const err = payload as Record<string, unknown>;
        const serverMessage =
          typeof err["detail"] === "string"
            ? err["detail"]
            : typeof err["error"] === "string"
              ? err["error"]
              : typeof err["message"] === "string"
                ? err["message"]
                : `HTTP ${response.status}`;
        // Surface the server message via a thrown Error subclass. Reuse
        // NetworkError for non-2xx so callers get a typed RelataError.
        throw new MemoryHttpError(
          response.status,
          serverMessage,
          err,
          response.headers.get("x-request-id") ?? undefined,
        );
      }
      return (payload ?? {}) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof MemoryHttpError) throw err;
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

  /** @internal */
  #isAbortError(err: Error): boolean {
    return err.name === "AbortError" || err.message.includes("aborted");
  }
}

// ---------------------------------------------------------------------------
// MemoryHttpError — local typed wrapper for non-2xx memory responses
// ---------------------------------------------------------------------------

/**
 * @internal
 * Typed error thrown by {@link Memory} when the server returns a non-2xx
 * response. Carries the RFC 7807 fields the server emits so callers can
 * inspect `code`, `retryable`, `requestId`, etc. without depending on the
 * core `mapHttpError` dispatcher.
 */
export class MemoryHttpError extends Error {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
  readonly requestId: string | undefined;

  constructor(
    statusCode: number,
    message: string,
    body: Record<string, unknown>,
    requestId: string | undefined,
  ) {
    super(`[HTTP ${statusCode}] ${message}`);
    this.name = "MemoryHttpError";
    this.statusCode = statusCode;
    this.body = body;
    this.requestId = requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
