/**
 * `RelataCheckpointer` — a real langgraphjs `BaseCheckpointSaver` backed by
 * RelataDB (#2312, mirroring the Python `relata_langgraph.RelataCheckpointer`
 * from #2229 / #340).
 *
 * `RelataCheckpointer` subclasses `@langchain/langgraph-checkpoint`'s
 * `BaseCheckpointSaver` and implements its full required surface
 * (`getTuple` / `list` / `put` / `putWrites` / `deleteThread`), so it can be
 * passed directly to `workflow.compile({ checkpointer })`. LangGraph's Pregel
 * runtime does `instanceof` checks on the checkpointer in several places, so
 * — unlike the duck-typed `adapters/langchain.ts` / `adapters/llamaindex.ts`
 * adapters — this module genuinely needs to import `@langchain/langgraph-checkpoint`
 * (and its `@langchain/core` peer) at class-definition time. Both are
 * **optional peer dependencies** of this package (`peerDependenciesMeta`
 * marks them optional) — install them yourself to use this adapter:
 *
 * ```sh
 * npm install @langchain/langgraph-checkpoint @langchain/core
 * ```
 *
 * Checkpoints persist via the governed A2A checkpoint door
 * (`PUT/GET /a2a/checkpoints/{thread_id}/{checkpoint_id}`,
 * `GET /a2a/checkpoints/{thread_id}`) — the server keeps an exact, lossless
 * read-back store and mirrors each write as a governed `MemoryItem` (audit +
 * provenance). Retained checkpoints FIFO-evict server-side.
 *
 * Unlike the Python SDK (which ships a separate sync `RelataCheckpointer`
 * and `AsyncRelataCheckpointer`, because Python needs an explicit async
 * variant), TypeScript is async-native: `BaseCheckpointSaver`'s methods are
 * all `Promise`-returning already, so **one** class covers both `.invoke()`
 * and `.stream()` call sites — there is no separate async class.
 *
 * Example:
 *
 * ```typescript
 * import { StateGraph, END } from "@langchain/langgraph";
 * import { RelataCheckpointer } from "@zysec-ai/relata-sdk/adapters/langgraph";
 *
 * const checkpointer = new RelataCheckpointer({
 *   endpoint: process.env.RELATA_ENDPOINT!,
 *   token: process.env.RELATA_BEARER_TOKEN,
 * });
 *
 * const workflow = new StateGraph(MyAnnotation)
 *   .addNode("echo", (state) => ({ output: `echo: ${state.input}` }))
 *   .addEdge("__start__", "echo")
 *   .addEdge("echo", END);
 *
 * const app = workflow.compile({ checkpointer });
 * const config = { configurable: { thread_id: "session-42" } };
 * await app.invoke({ input: "hello" }, config);
 * ```
 *
 * See `docs/src/guides/langgraph-checkpointer.md` for the storage format and
 * current known limitations (namespaced/cross-thread listing, thread
 * deletion) — identical contract to the Python implementation.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  getCheckpointId,
  WRITES_IDX_MAP,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";

import { A2AClient } from "../a2a.ts";
import { RelataClient } from "../client.ts";
import { RelataError } from "../errors.ts";

// ---------------------------------------------------------------------------
// Segment encoding — mirrors `relata_langgraph`'s `_checkpoint_segment` (#2229)
// ---------------------------------------------------------------------------

const NS_SEP = ":";
const WRITES_SUFFIX = "__writes";

/**
 * Encode `(checkpointNs, checkpointId)` into the single path segment the
 * `/a2a/checkpoints/{thread_id}/{checkpoint_id}` route expects.
 *
 * `checkpointNs` is percent-encoded (it may be empty, or a subgraph
 * namespace containing arbitrary characters); `checkpointId` is a LangGraph
 * `uuid6` string (hex + hyphens only) and passes through verbatim. Splitting
 * on the first literal `:` after a single round of URL-decoding recovers
 * both parts unambiguously, since any `:` that was originally inside
 * `checkpointNs` is itself percent-encoded.
 */
function checkpointSegment(checkpointNs: string, checkpointId: string): string {
  return `${encodeURIComponent(checkpointNs)}${NS_SEP}${checkpointId}`;
}

/** Inverse of {@link checkpointSegment}. */
function splitCheckpointSegment(segment: string): { checkpointNs: string; checkpointId: string } {
  const sepIdx = segment.indexOf(NS_SEP);
  if (sepIdx === -1) return { checkpointNs: "", checkpointId: segment };
  return {
    checkpointNs: decodeURIComponent(segment.slice(0, sepIdx)),
    checkpointId: segment.slice(sepIdx + 1),
  };
}

/**
 * Pending task writes for a checkpoint are stored as their own record,
 * independent of (and possibly created before) the checkpoint record itself:
 * LangGraph's Pregel loop may call `putWrites` for a checkpoint id that
 * hasn't been `put()` yet (writes for the *next* tick are attached
 * pre-emptively). `uuid6` checkpoint ids never contain `_`, so this suffix
 * can't collide with a real checkpoint id.
 */
function writesSegment(checkpointNs: string, checkpointId: string): string {
  return checkpointSegment(checkpointNs, `${checkpointId}${WRITES_SUFFIX}`);
}

// ---------------------------------------------------------------------------
// Typed-blob (de)serialization — mirrors `_encode_typed`/`_decode_typed`
// ---------------------------------------------------------------------------

/** Base64-encode bytes without depending on Node's `Buffer` (browser/Deno safe). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Inverse of {@link bytesToBase64}. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface TypedBlob {
  type: string;
  data: string;
}

async function encodeTyped(serde: SerializerProtocol, value: unknown): Promise<TypedBlob> {
  const [type, bytes] = await serde.dumpsTyped(value);
  return { type, data: bytesToBase64(bytes) };
}

async function decodeTyped(serde: SerializerProtocol, blob: TypedBlob): Promise<unknown> {
  return serde.loadsTyped(blob.type, base64ToBytes(blob.data));
}

// ---------------------------------------------------------------------------
// Metadata filter — mirrors `_matches_filter`
// ---------------------------------------------------------------------------

function matchesFilter(
  metadata: CheckpointMetadata,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (!filter) return true;
  const meta = metadata as unknown as Record<string, unknown>;
  return Object.entries(filter).every(([key, value]) => meta[key] === value);
}

// ---------------------------------------------------------------------------
// Thread-id requirement — mirrors `_require_thread_id`
// ---------------------------------------------------------------------------

function requireThreadId(config: RunnableConfig | undefined): {
  threadId: string;
  checkpointNs: string;
} {
  const threadId = config?.configurable?.["thread_id"] as string | undefined;
  if (!threadId) {
    throw new Error(
      "RelataCheckpointer requires a thread_id in config.configurable " +
        '(e.g. { configurable: { thread_id: "..." } }) — the Relata /a2a/checkpoints ' +
        "door has no cross-thread listing route.",
    );
  }
  const checkpointNs = (config?.configurable?.["checkpoint_ns"] as string | undefined) ?? "";
  return { threadId, checkpointNs };
}

const DELETE_THREAD_UNSUPPORTED =
  "RelataCheckpointer does not support thread deletion: the Relata " +
  "/a2a/checkpoints door has no delete route (checkpoints FIFO-evict " +
  "server-side — see docs/src/guides/langgraph-checkpointer.md). For explicit " +
  "governed erasure of the audit-trail MemoryItem mirror, call " +
  "`DELETE /memory/forget/:id` directly against the underlying memory item id.";

// ---------------------------------------------------------------------------
// RelataCheckpointer
// ---------------------------------------------------------------------------

/** Options for constructing a {@link RelataCheckpointer}. */
export interface RelataCheckpointerOptions {
  /** An existing {@link RelataClient} or {@link A2AClient} to reuse (inherits its auth + tenant context). */
  client?: RelataClient | A2AClient;
  /** Base URL of the Relata HTTP endpoint, e.g. `"http://localhost:9090"`. Required when `client` is not supplied. */
  endpoint?: string;
  /** Bearer token for authentication. Omit in unauthenticated dev mode. */
  token?: string;
  /** Per-request timeout in milliseconds. `0` means no timeout (default). */
  timeoutMs?: number;
  /** Override `fetch` (testing / observability). */
  fetch?: typeof globalThis.fetch;
  /** Optional LangGraph serializer override; defaults to `BaseCheckpointSaver`'s `JsonPlusSerializer`. */
  serde?: SerializerProtocol;
}

/**
 * Sync-free langgraphjs `BaseCheckpointSaver` backed by RelataDB.
 *
 * The `MemorySaver`-equivalent of this integration: pass it directly as
 * `checkpointer` to `workflow.compile()`. See the module docstring for a full
 * example.
 */
export class RelataCheckpointer extends BaseCheckpointSaver {
  readonly #a2a: A2AClient;

  constructor(options: RelataCheckpointerOptions = {}) {
    super(options.serde);
    if (options.client) {
      this.#a2a =
        options.client instanceof A2AClient
          ? options.client
          : A2AClient.fromClient(options.client);
      return;
    }
    if (!options.endpoint) {
      throw new Error("RelataCheckpointer requires either `client`, or `endpoint`.");
    }
    const ctor: {
      baseUrl: string;
      bearerToken?: string;
      timeoutMs?: number;
      fetch?: typeof globalThis.fetch;
    } = { baseUrl: options.endpoint };
    if (options.token !== undefined) ctor.bearerToken = options.token;
    if (options.timeoutMs !== undefined) ctor.timeoutMs = options.timeoutMs;
    if (options.fetch !== undefined) ctor.fetch = options.fetch;
    this.#a2a = new A2AClient(ctor);
  }

  // -- internal HTTP helpers -------------------------------------------------

  /** @internal Load a stored segment's `state` blob, or `undefined` on 404. */
  async #tryLoad(
    threadId: string,
    segment: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const resp = await this.#a2a.loadCheckpoint(threadId, segment);
      const state = resp["state"];
      return typeof state === "object" && state !== null
        ? (state as Record<string, unknown>)
        : undefined;
    } catch (err) {
      // NB: #2731 routed A2AClient's typed-error path through the same
      // AuthError/ForbiddenError/NotFoundError/... hierarchy RelataClient
      // uses, so a 404 here is a `NotFoundError` (not the generic
      // `TypedHttpError` this used to always throw) — check the shared
      // `RelataError.statusCode` so both classes keep working.
      if (err instanceof RelataError && err.statusCode === 404) return undefined;
      throw err;
    }
  }

  /** @internal The checkpoint-id segments retained for a thread + namespace, unsorted. */
  async #listIds(threadId: string, checkpointNs: string): Promise<string[]> {
    // The server returns a bare `string[]` of opaque segments (`{ns}:{id}`);
    // `A2AClient.listCheckpoints`'s declared `Record<string, unknown>[]` return
    // type doesn't reflect that at the type level, so read the raw strings.
    const raw = (await this.#a2a.listCheckpoints(threadId)) as unknown as string[];
    const out: string[] = [];
    for (const seg of raw) {
      const { checkpointNs: ns, checkpointId } = splitCheckpointSegment(seg);
      if (ns === checkpointNs && !checkpointId.endsWith(WRITES_SUFFIX)) out.push(checkpointId);
    }
    return out;
  }

  /** @internal Fetch + decode a full checkpoint tuple, or `undefined` if not retained. */
  async #fetchTuple(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<CheckpointTuple | undefined> {
    const state = await this.#tryLoad(threadId, checkpointSegment(checkpointNs, checkpointId));
    if (state === undefined) return undefined;
    const writesState = await this.#tryLoad(threadId, writesSegment(checkpointNs, checkpointId));

    const checkpoint = (await decodeTyped(
      this.serde,
      state["checkpoint"] as TypedBlob,
    )) as Checkpoint;
    const metadata = (await decodeTyped(
      this.serde,
      state["metadata"] as TypedBlob,
    )) as CheckpointMetadata;

    const rawWrites = Array.isArray(writesState?.["writes"])
      ? (writesState["writes"] as Record<string, unknown>[])
      : [];
    const pendingWrites: CheckpointPendingWrite[] = [];
    for (const write of rawWrites) {
      const value = await decodeTyped(this.serde, write["value"] as TypedBlob);
      pendingWrites.push([String(write["task_id"]), String(write["channel"]), value]);
    }

    const tuple: CheckpointTuple = {
      config: {
        configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };
    const parentId = state["parent_checkpoint_id"];
    if (typeof parentId === "string" && parentId) {
      tuple.parentConfig = {
        configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: parentId },
      };
    }
    return tuple;
  }

  // -- BaseCheckpointSaver ----------------------------------------------------

  /**
   * Fetch a checkpoint tuple, or the latest one for the thread if no
   * `checkpoint_id` is given in `config`.
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, checkpointNs } = requireThreadId(config);
    let checkpointId: string | undefined = getCheckpointId(config) || undefined;
    if (checkpointId === undefined) {
      const ids = await this.#listIds(threadId, checkpointNs);
      if (ids.length === 0) return undefined;
      checkpointId = [...ids].sort().at(-1); // uuid6 ids sort lexicographically by time
    }
    return checkpointId ? this.#fetchTuple(threadId, checkpointNs, checkpointId) : undefined;
  }

  /**
   * List checkpoints for `config`'s thread, newest first.
   *
   * `config` (with a `thread_id`) is required — the Relata checkpoint store
   * has no cross-thread listing route, unlike `MemorySaver`.
   */
  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const { before, limit, filter } = options;
    const { threadId, checkpointNs } = requireThreadId(config);
    const beforeId = before ? getCheckpointId(before) || undefined : undefined;
    const ids = (await this.#listIds(threadId, checkpointNs)).sort().reverse();
    let yielded = 0;
    for (const checkpointId of ids) {
      if (beforeId !== undefined && checkpointId >= beforeId) continue;
      if (limit !== undefined && yielded >= limit) break;
      const tuple = await this.#fetchTuple(threadId, checkpointNs, checkpointId);
      if (!tuple || !matchesFilter(tuple.metadata as CheckpointMetadata, filter)) continue;
      yielded += 1;
      yield tuple;
    }
  }

  /**
   * Persist a checkpoint. `PUT /a2a/checkpoints/{thread_id}/{checkpoint_id}`
   * stores the checkpoint + metadata verbatim; overwrites any existing
   * checkpoint for the same id (re-saves don't accumulate duplicates).
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.["thread_id"] as string | undefined;
    if (!threadId) {
      throw new Error(
        'RelataCheckpointer.put() requires config.configurable.thread_id (e.g. { configurable: { thread_id: "..." } }).',
      );
    }
    const checkpointNs = (config.configurable?.["checkpoint_ns"] as string | undefined) ?? "";
    const checkpointId = checkpoint.id;
    const body: Record<string, unknown> = {
      checkpoint: await encodeTyped(this.serde, checkpoint),
      metadata: await encodeTyped(this.serde, metadata),
      parent_checkpoint_id: config.configurable?.["checkpoint_id"] ?? null,
    };
    await this.#a2a.saveCheckpoint(threadId, checkpointSegment(checkpointNs, checkpointId), body);
    return {
      configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId },
    };
  }

  /**
   * Attach intermediate task writes to a checkpoint.
   *
   * Stored as an independent record ({@link writesSegment}) from the
   * checkpoint itself: LangGraph may call this for a checkpoint id that
   * hasn't been `put()` yet (writes for the *next* tick, attached
   * pre-emptively), so this must not depend on the checkpoint existing.
   * Read-modify-write over that record (no server-side CAS — acceptable for
   * the same reason `MemorySaver` needs no locking: concurrent `putWrites`
   * calls to the *same* checkpoint id from different tasks could still race,
   * a known limitation of a REST-backed adapter with no compare-and-swap
   * primitive server-side).
   */
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = config.configurable?.["thread_id"] as string | undefined;
    const checkpointNs = (config.configurable?.["checkpoint_ns"] as string | undefined) ?? "";
    const checkpointId = config.configurable?.["checkpoint_id"] as string | undefined;
    if (!threadId || !checkpointId) {
      throw new Error(
        "RelataCheckpointer.putWrites() requires config.configurable.thread_id and .checkpoint_id.",
      );
    }
    const segment = writesSegment(checkpointNs, checkpointId);
    const existing = await this.#tryLoad(threadId, segment);
    const list = Array.isArray(existing?.["writes"])
      ? (existing["writes"] as Record<string, unknown>[])
      : [];
    const existingKeys = new Set(list.map((w) => `${w["task_id"]}:${w["idx"]}`));
    for (let idx = 0; idx < writes.length; idx++) {
      const write = writes[idx];
      if (!write) continue;
      const [channel, value] = write;
      const keyIdx = WRITES_IDX_MAP[channel] ?? idx;
      // Matches BaseCheckpointSaver's own dedup rule (see MemorySaver.putWrites):
      // non-special writes only ever get their first attempt recorded.
      if (keyIdx >= 0 && existingKeys.has(`${taskId}:${keyIdx}`)) continue;
      list.push({ task_id: taskId, idx: keyIdx, channel, value: await encodeTyped(this.serde, value) });
    }
    await this.#a2a.saveCheckpoint(threadId, segment, { writes: list });
  }

  /** Not supported — see the module docstring / {@link DELETE_THREAD_UNSUPPORTED}. */
  override async deleteThread(_threadId: string): Promise<void> {
    throw new Error(DELETE_THREAD_UNSUPPORTED);
  }
}
