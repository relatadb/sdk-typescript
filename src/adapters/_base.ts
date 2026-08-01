/**
 * @internal
 * Shared, framework-agnostic backend for the agent-framework memory adapters
 * (#2312, mirroring the Python `relata_adapters._base` module from #683).
 *
 * Each adapter (LangChain.js / LlamaIndex.TS) maps its framework's memory
 * interface onto these primitives, which in turn call Relata's governed
 * `/memory/*` verbs via {@link Memory}. The adapters never import their
 * target framework — they just duck-type its expected `BaseMemory`-shaped
 * interface, so they load with or without the framework installed.
 *
 * The mapping is the semantic-memory model — `record` (store) + `recall`
 * (relevance search) — the same Mem0 paradigm every one of these frameworks'
 * memory abstractions supports.
 */

import { Memory } from "../memory.ts";

// ---------------------------------------------------------------------------
// message parts
// ---------------------------------------------------------------------------

/**
 * Duck-type a framework message into `[role, content]`.
 *
 * Works for plain objects (`{role`/`type`, `content}`) — the shape LangChain
 * and LlamaIndex messages both expose — without importing either framework.
 * Falls back to `String(message)` for anything else.
 */
export function messageParts(message: unknown): [string | undefined, string] {
  if (typeof message === "object" && message !== null) {
    const obj = message as Record<string, unknown>;
    const roleRaw = obj["role"] ?? obj["type"];
    const role = typeof roleRaw === "string" ? roleRaw : undefined;
    const content = obj["content"];
    return [role, content !== undefined && content !== null ? String(content) : ""];
  }
  return [undefined, String(message)];
}

// ---------------------------------------------------------------------------
// RelataMemoryBackend
// ---------------------------------------------------------------------------

/** Options for constructing a {@link RelataMemoryBackend}. */
export interface RelataMemoryBackendOptions {
  /** An existing {@link Memory} client to reuse. Takes priority over `baseUrl`/`purpose`. */
  memory?: Memory;
  /** Relata server URL, required when `memory` is not supplied. */
  baseUrl?: string;
  /** Declared purpose token, required when `memory` is not supplied. */
  purpose?: string;
  /** Default session id applied to `record`/`recall`. */
  sessionId?: string;
  /** Optional bearer token, forwarded to a constructed {@link Memory}. */
  bearerToken?: string;
  /** Override `fetch` (testing / observability), forwarded to a constructed {@link Memory}. */
  fetch?: typeof globalThis.fetch;
}

/**
 * @internal
 * Framework-agnostic store/recall backend over {@link Memory}.
 *
 * Either pass an existing {@link Memory}, or `baseUrl` + `purpose` to
 * construct one. `record` remembers the ids it stores so `wipe` can issue a
 * governed retract for exactly those memories.
 */
export class RelataMemoryBackend {
  readonly #memory: Memory;
  readonly #ids: string[] = [];

  constructor(options: RelataMemoryBackendOptions = {}) {
    if (options.memory) {
      this.#memory = options.memory;
    } else {
      if (!options.baseUrl || !options.purpose) {
        throw new Error(
          "RelataMemoryBackend requires either `memory`, or both `baseUrl` and `purpose`.",
        );
      }
      const memOpts: {
        purpose: string;
        sessionId?: string;
        bearerToken?: string;
        fetch?: typeof globalThis.fetch;
      } = { purpose: options.purpose };
      if (options.sessionId !== undefined) memOpts.sessionId = options.sessionId;
      if (options.bearerToken !== undefined) memOpts.bearerToken = options.bearerToken;
      if (options.fetch !== undefined) memOpts.fetch = options.fetch;
      this.#memory = new Memory(options.baseUrl, memOpts);
    }
  }

  /** Store `text` (optionally tagged with a `role`) and return its id. */
  async record(text: string, role?: string): Promise<string> {
    const content = role ? `${role}: ${text}` : text;
    const memId = await this.#memory.add(content);
    if (memId) this.#ids.push(memId);
    return memId;
  }

  /** Return memories relevant to `query` (ranked rows from recall). */
  async recall(query: string, topK = 5): Promise<Record<string, unknown>[]> {
    return this.#memory.search(query, { topK });
  }

  /**
   * Retract every memory this backend stored; return the count.
   *
   * Best-effort governed retract (not a hard delete) of exactly the ids this
   * instance recorded — reliable for a session's lifetime without a
   * bulk-delete endpoint.
   */
  async wipe(): Promise<number> {
    let count = 0;
    for (const memId of this.#ids.splice(0)) {
      await this.#memory.forget(memId);
      count += 1;
    }
    return count;
  }

  /** Close the underlying HTTP connection. */
  async close(): Promise<void> {
    await this.#memory.close();
  }
}
