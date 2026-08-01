/**
 * LangChain.js memory adapter (#2312) — governed semantic memory backed by
 * Relata, mirroring the Python `relata_adapters.langchain.RelataMemory` (#683).
 *
 * Implements the LangChain.js `BaseMemory` interface shape
 * (`memoryKeys` / `loadMemoryVariables` / `saveContext`, from
 * `@langchain/core/memory`) **without importing LangChain**, so it loads
 * with or without the framework installed — the same duck-typing pattern the
 * Python adapters use. Plug it into a chain as the `memory` field:
 *
 * ```typescript
 * import { RelataMemory } from "@zysec-ai/relata-sdk/adapters/langchain";
 *
 * const memory = new RelataMemory({
 *   baseUrl: "http://localhost:9090",
 *   purpose: "agent",
 * });
 * // chain = new ConversationChain({ llm, memory });
 * ```
 *
 * `saveContext` stores the turn; `loadMemoryVariables` recalls the most
 * relevant prior memories for the incoming input. Governance (purpose + ACL)
 * is always on — `RelataMemoryBackend` requires a non-empty `purpose`.
 */

import { RelataMemoryBackend, type RelataMemoryBackendOptions } from "./_base.ts";

/** Options for constructing a {@link RelataMemory} LangChain.js adapter. */
export interface RelataMemoryOptions extends RelataMemoryBackendOptions {
  /** The memory-variable key injected into the chain context. Defaults to `"history"`. */
  memoryKey?: string;
  /** How many relevant memories to recall per `loadMemoryVariables` call. Defaults to `5`. */
  topK?: number;
}

/**
 * LangChain.js `BaseMemory`-shaped semantic memory over Relata.
 *
 * Structurally compatible with `@langchain/core`'s `BaseMemory` abstract
 * class: exposes `memoryKeys`, `loadMemoryVariables`, and `saveContext` with
 * matching signatures, so it can be passed anywhere a `BaseMemory` is
 * expected without extending the class (LangChain.js does not require
 * `instanceof` checks for memory, unlike its LangGraph checkpointer — see
 * `adapters/langgraph.ts`).
 */
export class RelataMemory {
  readonly #backend: RelataMemoryBackend;
  readonly #memoryKey: string;
  readonly #topK: number;

  constructor(options: RelataMemoryOptions) {
    this.#backend = new RelataMemoryBackend(options);
    this.#memoryKey = options.memoryKey ?? "history";
    this.#topK = options.topK ?? 5;
  }

  /** The keys this memory injects into the chain context. */
  get memoryKeys(): string[] {
    return [this.#memoryKey];
  }

  /** Recall memories relevant to `values` and return them under `memoryKey`. */
  async loadMemoryVariables(
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const query = values ? Object.values(values).map(String).join(" ") : "";
    const rows = query ? await this.#backend.recall(query, this.#topK) : [];
    const history = rows.map((r) => String(r["content"] ?? "")).join("\n");
    return { [this.#memoryKey]: history };
  }

  /** Store the human input and the AI output of a turn as memories. */
  async saveContext(
    inputValues: Record<string, unknown>,
    outputValues: Record<string, unknown>,
  ): Promise<void> {
    for (const value of Object.values(inputValues ?? {})) {
      await this.#backend.record(String(value), "human");
    }
    for (const value of Object.values(outputValues ?? {})) {
      await this.#backend.record(String(value), "ai");
    }
  }

  /** Retract every memory this instance stored (governed). Not part of `BaseMemory`, provided for parity with the Python adapter. */
  async clear(): Promise<void> {
    await this.#backend.wipe();
  }
}
