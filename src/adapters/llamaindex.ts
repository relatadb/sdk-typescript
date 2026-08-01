/**
 * LlamaIndex.TS memory adapter (#2312) — governed semantic memory backed by
 * Relata, mirroring the Python `relata_adapters.llamaindex.RelataMemory` (#683).
 *
 * Implements the LlamaIndex.TS `BaseMemoryBlock` interface shape (`get` /
 * `put`, from `@llamaindex/core/memory`) **without importing LlamaIndex**, so
 * it loads with or without the framework installed. `get` performs a
 * relevance recall seeded from the incoming messages (the same pattern
 * LlamaIndex's own `VectorMemoryBlock` uses); governance (purpose + ACL) is
 * always on.
 *
 * ```typescript
 * import { RelataMemory } from "@zysec-ai/relata-sdk/adapters/llamaindex";
 *
 * const memory = new RelataMemory({
 *   baseUrl: "http://localhost:9090",
 *   purpose: "agent",
 * });
 * await memory.put([{ role: "user", content: "remember dark mode" }]);
 * const relevant = await memory.get([{ role: "user", content: "theme preference" }]);
 * ```
 */

import { messageParts, RelataMemoryBackend, type RelataMemoryBackendOptions } from "./_base.ts";

/** Options for constructing a {@link RelataMemory} LlamaIndex.TS adapter. */
export interface RelataMemoryOptions extends RelataMemoryBackendOptions {
  /** How many relevant memories to recall per `get` call. Defaults to `5`. */
  topK?: number;
  /** Block id, matching `BaseMemoryBlock.id`. Defaults to `"relata-memory"`. */
  id?: string;
  /** Block priority, matching `BaseMemoryBlock.priority` (`0` = always included). Defaults to `0`. */
  priority?: number;
  /** Matching `BaseMemoryBlock.isLongTerm`. Defaults to `true`. */
  isLongTerm?: boolean;
}

/**
 * LlamaIndex.TS `BaseMemoryBlock`-shaped semantic memory over Relata.
 *
 * `id` / `priority` / `isLongTerm` / `get` / `put` match `BaseMemoryBlock`'s
 * public member names and arity, so this can be composed into LlamaIndex.TS's
 * `Memory` alongside e.g. a `StaticMemoryBlock` without extending anything
 * (LlamaIndex.TS's memory blocks are duck-typed, not `instanceof`-checked —
 * unlike LangGraph's checkpointer, see `adapters/langgraph.ts`). `get`
 * returns Relata's recall rows (`{id, content, confidence, score, ...}`)
 * rather than literal `MemoryMessage` objects — map them to your framework's
 * message shape at the call site, the same boundary the Python adapter
 * documents for its `get`.
 */
export class RelataMemory {
  readonly id: string;
  readonly priority: number;
  readonly isLongTerm: boolean;
  readonly #backend: RelataMemoryBackend;
  readonly #topK: number;

  constructor(options: RelataMemoryOptions) {
    this.#backend = new RelataMemoryBackend(options);
    this.#topK = options.topK ?? 5;
    this.id = options.id ?? "relata-memory";
    this.priority = options.priority ?? 0;
    this.isLongTerm = options.isLongTerm ?? true;
  }

  /**
   * Store one or more chat messages (each an object with `.role`/`.type` +
   * `.content`, or a plain dict of that shape).
   */
  async put(messages: unknown[] | unknown): Promise<void> {
    const list = Array.isArray(messages) ? messages : [messages];
    for (const message of list) {
      const [role, content] = messageParts(message);
      await this.#backend.record(content, role);
    }
  }

  /**
   * Recall memories relevant to `messages` (the ranked rows from recall).
   *
   * The query is derived from the last message's content, mirroring how
   * LlamaIndex's own `VectorMemoryBlock` seeds a similarity search from
   * recent conversation turns. Returns `[]` when `messages` is empty.
   */
  async get(messages: unknown[] = []): Promise<Record<string, unknown>[]> {
    if (messages.length === 0) return [];
    const [, content] = messageParts(messages[messages.length - 1]);
    if (!content) return [];
    return this.#backend.recall(content, this.#topK);
  }

  /**
   * Not supported for semantic memory — recall is relevance-ranked, not a
   * full scan. Use {@link get} with messages. Returns `[]` rather than a
   * misleading partial history.
   */
  async getAll(): Promise<Record<string, unknown>[]> {
    return [];
  }

  /** Retract every memory this instance stored (governed). */
  async reset(): Promise<void> {
    await this.#backend.wipe();
  }
}
