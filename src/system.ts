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

  /** Status of a single background job by name. Wraps `GET /jobs/:name`. */
  async jobStatus(name: string): Promise<Record<string, unknown>> {
    return this._get(`/jobs/${encodeURIComponent(name)}`);
  }

  /** List registered workflow definition names. Wraps `GET /workflows`. */
  async listWorkflows(): Promise<Record<string, unknown>> {
    return this._get("/workflows");
  }

  /** Fetch one workflow definition. Wraps `GET /workflows/:name`. */
  async getWorkflow(name: string): Promise<Record<string, unknown>> {
    return this._get(`/workflows/${encodeURIComponent(name)}`);
  }

  /** Register a workflow definition. Wraps `POST /workflows`. */
  async registerWorkflow(
    name: string,
    steps: Record<string, unknown>[],
  ): Promise<Record<string, unknown>> {
    return this._post("/workflows", { name, steps });
  }

  /** Start a workflow execution; returns `run_id`. Wraps `POST /workflows/:name/run`. */
  async runWorkflow(name: string): Promise<Record<string, unknown>> {
    return this._post(`/workflows/${encodeURIComponent(name)}/run`, {});
  }

  /** Latest run status for a workflow by name. Wraps `GET /workflows/:name/status`. */
  async workflowStatus(name: string): Promise<Record<string, unknown>> {
    return this._get(`/workflows/${encodeURIComponent(name)}/status`);
  }

  /**
   * Step-level detail of a run by `run_id` — surfaces `attempt_count`,
   * `last_error`, per-step status. Wraps `GET /workflows/runs/:run_id`.
   */
  async workflowRun(runId: string): Promise<WorkflowRun> {
    return this._get(`/workflows/runs/${encodeURIComponent(runId)}`) as Promise<WorkflowRun>;
  }
}

/** Typed response for `workflowRun` — surfaces durable-resume fields from #711/#713. */
export interface WorkflowRun {
  run_id: string;
  workflow_name: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
  steps: WorkflowStepStatus[];
  created_at: string;
  updated_at: string;
}

/** Per-step status within a `WorkflowRun`. */
export interface WorkflowStepStatus {
  name: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
}
