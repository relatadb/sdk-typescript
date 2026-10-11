/**
 * A2A client — Agent-to-Agent task surface (#77 Phase 3).
 *
 * Wraps `/a2a/tasks` (create), `/a2a/tasks/:id` (status),
 * `/a2a/tasks/:id/stream` (SSE tail — pairs with the streaming ticket), and
 * `/a2a/checkpoints/:threadId` (process-local LangGraph checkpoint endpoints).
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

/**
 * A2A HTTP client. The server executes submitted tasks synchronously and
 * retains task status/checkpoint state only in bounded, process-local stores.
 */
export class A2AClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): A2AClient {
    return new A2AClient(TypedClientBase.clientToCtor(client));
  }

  /**
   * Submit an A2A task. The server executes it synchronously in this request.
   * The returned record is available only while retained in the server's
   * bounded, process-local task history; it is not a durable job receipt.
   * Payloads typically contain `name`, `input`, and `skill`.
   * Wraps `POST /a2a/tasks`.
   */
  async submitTask(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._post("/a2a/tasks", payload);
  }

  /**
   * Poll a task's status.
   * Wraps `GET /a2a/tasks/:id`. Returns
   * `{"id": ..., "status": ..., "result": ..., "error": ...}`.
   */
  async getTask(taskId: string): Promise<Record<string, unknown>> {
    return this._get(`/a2a/tasks/${encodeURIComponent(taskId)}`);
  }

  /**
   * List the LangGraph checkpoints for a thread.
   * Wraps `GET /a2a/checkpoints/:threadId`.
   */
  async listCheckpoints(
    threadId: string,
  ): Promise<Record<string, unknown>[]> {
    const data = await this._get<Record<string, unknown>>(
      `/a2a/checkpoints/${encodeURIComponent(threadId)}`,
    );
    const checkpoints =
      typeof data === "object" && data !== null && Array.isArray(data["checkpoints"])
        ? data["checkpoints"]
        : Array.isArray(data)
          ? data
          : [];
    return checkpoints as Record<string, unknown>[];
  }

  /**
   * Load a specific checkpoint by id.
   * Wraps `GET /a2a/checkpoints/:threadId/:checkpointId`.
   */
  async loadCheckpoint(
    threadId: string,
    checkpointId: string,
  ): Promise<Record<string, unknown>> {
    return this._get(
      `/a2a/checkpoints/${encodeURIComponent(threadId)}/${encodeURIComponent(checkpointId)}`,
    );
  }

  /**
   * Save (PUT) a checkpoint.
   * Wraps `PUT /a2a/checkpoints/:threadId/:checkpointId`. The `payload`
   * matches the LangGraph checkpointer shape
   * (`{"checkpoint": ..., "metadata": ...}`). Returns the server's save
   * receipt.
   */
  async saveCheckpoint(
    threadId: string,
    checkpointId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._put(
      `/a2a/checkpoints/${encodeURIComponent(threadId)}/${encodeURIComponent(checkpointId)}`,
      payload,
    );
  }

  /**
   * Fetch the A2A agent card.
   * Wraps `GET /.well-known/agent.json`. The card advertises the server's
   * A2A capabilities, skills, and authentication modes to discovery clients.
   */
  async agentCard(): Promise<Record<string, unknown>> {
    return this._get("/.well-known/agent.json");
  }
}
