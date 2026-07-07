/**
 * System / runtime SDK — LLM configuration, jobs status, agent card.
 *
 * Pairs the agent surfaces with the operator-side runtime config so a
 * TypeScript caller can drive the full agent lifecycle: configure the LLM,
 * submit an A2A task, watch the jobs queue, inspect the agent card.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

/** System / runtime client — LLM config + jobs. */
export class SystemClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): SystemClient {
    return new SystemClient(TypedClientBase.clientToCtor(client));
  }

  // -------------------------------------------------------------------------
  // LLM configuration (operator-side; agent-side is in McpClient)
  // -------------------------------------------------------------------------

  /**
   * Return the configured LLM endpoint + model roster.
   * Wraps `GET /config/llm`.
   */
  async llmConfig(): Promise<Record<string, unknown>> {
    return this._get("/config/llm");
  }

  /**
   * Send a test prompt to the configured LLM endpoint (or a specific
   * `model`) and return the round-trip result + latency. Used by operators
   * to verify connectivity before pointing agents at the server.
   * Wraps `POST /config/llm/test`.
   */
  async testLlm(
    prompt: string,
    opts: { model?: string } = {},
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { prompt };
    if (opts.model !== undefined) payload["model"] = opts.model;
    return this._post("/config/llm/test", payload);
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  /**
   * Return the status of every background job (continuous-pattern
   * detectors, MV refresh, embedder worker, orphan-blob sweep, ...).
   * Wraps `GET /jobs`.
   */
  async jobsStatus(): Promise<Record<string, unknown>> {
    return this._get("/jobs");
  }
}
