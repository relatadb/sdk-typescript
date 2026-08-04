/**
 * MCP client — Model Context Protocol tool surface (#77 Phase 2).
 *
 * Wraps `/mcp/initialize`, `/mcp/tools`, `/mcp/tools/call`. The server
 * responds with the MCP envelope
 * `{"content": [{"type": "text", "text": "..."}], "isError": false}`;
 * the `unwrapMcp` helper extracts the inner JSON.
 *
 * TypeScript is async-native, so every method returns a `Promise`. There is
 * no separate `AsyncMcpClient` (the SDK-wide parity decision).
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

// ---------------------------------------------------------------------------
// unwrapMcp helper
// ---------------------------------------------------------------------------

/**
 * Unwrap the MCP envelope. Extracted here (and re-used by `Memory`) so every
 * MCP caller shares one implementation. The server replies
 * `{"content": [{"type": "text", "text": "<json>"}], "isError": false}` where
 * the actual result is JSON encoded inside `content[0].text`.
 */
export function unwrapMcp(
  resp: Record<string, unknown>,
): Record<string, unknown> {
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

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

/**
 * Synchronous MCP client (async in TS) — `initialize` / `listTools` /
 * `callTool` plus typed convenience wrappers for the most-used MCP tools.
 */
export class McpClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): McpClient {
    return new McpClient(TypedClientBase.clientToCtor(client));
  }

  // -------------------------------------------------------------------------
  // Core MCP protocol
  // -------------------------------------------------------------------------

  /** Send the MCP initialize handshake. Wraps `POST /mcp/initialize`. */
  async initialize(
    opts: { clientId?: string; version?: string } = {},
  ): Promise<Record<string, unknown>> {
    return unwrapMcp(
      await this._post("/mcp/initialize", {
        client_id: opts.clientId ?? "relata-typescript-sdk",
        version: opts.version ?? "1.0",
      }),
    );
  }

  /** List every MCP tool the server exposes (30+). Wraps `GET /mcp/tools`. */
  async listTools(): Promise<Record<string, unknown>[]> {
    const data = unwrapMcp(await this._get("/mcp/tools"));
    const tools =
      typeof data === "object" && data !== null && Array.isArray(data["tools"])
        ? data["tools"]
        : Array.isArray(data)
          ? data
          : [];
    return tools as Record<string, unknown>[];
  }

  /**
   * Invoke an MCP tool by name with a typed arguments map.
   * Wraps `POST /mcp/tools/call`.
   */
  async callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { name };
    if (args !== undefined) payload["arguments"] = args;
    return unwrapMcp(await this._post("/mcp/tools/call", payload));
  }

  // -------------------------------------------------------------------------
  // Convenience wrappers for the most-used MCP tools.
  // Server dispatch table: crates/relata-cli/src/serve/mcp.rs:212-245.
  // -------------------------------------------------------------------------

  // --- Knowledge / query ---

  /** `query_knowledge` — governed SQL query. */
  async queryKnowledge(
    sql: string,
    purpose: string,
  ): Promise<Record<string, unknown>> {
    return this.callTool("query_knowledge", { sql, purpose });
  }

  /** `search_knowledge` — hybrid BM25 + vector search. */
  async searchKnowledge(
    query: string,
    purpose: string,
    opts: { topK?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("search_knowledge", {
      query,
      purpose,
      top_k: opts.topK ?? 10,
    });
  }

  /**
   * `explain_policy` — show the ACL / org-isolation policy that would apply
   * to `sql` without executing it.
   */
  async explainPolicy(
    sql: string,
    purpose: string,
  ): Promise<Record<string, unknown>> {
    return this.callTool("explain_policy", { sql, purpose });
  }

  /** `suggest_extensions` — type/canonical-kind autocomplete. */
  async suggestExtensions(prefix: string): Promise<Record<string, unknown>> {
    return this.callTool("suggest_extensions", { prefix });
  }

  // --- Entity / type discovery ---

  /** `list_entity_types` — every registered ontology type. */
  async listEntityTypes(): Promise<Record<string, unknown>> {
    return this.callTool("list_entity_types", {});
  }

  /** `get_entities` — paginated entity list. */
  async getEntities(
    objectType: string,
    opts: { filterExpr?: string; limit?: number } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      object_type: objectType,
      limit: opts.limit ?? 50,
    };
    if (opts.filterExpr !== undefined) args["filter"] = opts.filterExpr;
    return this.callTool("get_entities", args);
  }

  /** `search_entities` — free-text entity search. */
  async searchEntities(
    query: string,
    opts: { objectType?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { query };
    if (opts.objectType !== undefined) args["object_type"] = opts.objectType;
    return this.callTool("search_entities", args);
  }

  /** `get_domain_summary` — counts + freshness per type. */
  async getDomainSummary(
    opts: { objectType?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {};
    if (opts.objectType !== undefined) args["object_type"] = opts.objectType;
    return this.callTool("get_domain_summary", args);
  }

  /** `find_in_social_corpus` — search the ingested social-media corpus. */
  async findInSocialCorpus(
    query: string,
    opts: { corpus?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { query };
    if (opts.corpus !== undefined) args["corpus"] = opts.corpus;
    return this.callTool("find_in_social_corpus", args);
  }

  // --- Identity ---

  /** `lookup_identity` — universal identity lookup. */
  async lookupIdentity(
    value: string,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("lookup_identity", {
      value,
      purpose: opts.purpose ?? "analytics",
    });
  }

  // --- Case / investigation ---

  /** `get_entity_profile` — rich per-entity dossier. */
  async getEntityProfile(
    entityId: string,
    purpose: string,
  ): Promise<Record<string, unknown>> {
    return this.callTool("get_entity_profile", {
      entity_id: entityId,
      purpose,
    });
  }

  /** `get_timeline` — chronological event list for an entity. */
  async getTimeline(
    entityId: string,
    purpose: string,
    opts: { sinceNs?: number; untilNs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { entity_id: entityId, purpose };
    if (opts.sinceNs !== undefined) args["since_ns"] = opts.sinceNs;
    if (opts.untilNs !== undefined) args["until_ns"] = opts.untilNs;
    return this.callTool("get_timeline", args);
  }

  /**
   * `find_connections` — surface entities connected to a target via
   * relationships or shared attributes.
   */
  async findConnections(
    entity: string,
    purpose: string,
    opts: { limit?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("find_connections", {
      entity,
      limit: opts.limit ?? 50,
      purpose,
    });
  }

  /** `get_relationships` — direct neighbours of `entityId`. */
  async getRelationships(
    entityId: string,
    purpose: string,
    opts: { depth?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("get_relationships", {
      entity_id: entityId,
      depth: opts.depth ?? 1,
      purpose,
    });
  }

  /** `add_case_note` — append an investigative note to a case. */
  async addCaseNote(
    caseId: string,
    note: string,
    opts: { author?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { case_id: caseId, note };
    if (opts.author !== undefined) args["author"] = opts.author;
    return this.callTool("add_case_note", args);
  }

  /** `get_audit_trail` — provenance chain for a case or entity. */
  async getAuditTrail(
    opts: { caseId?: string; entityId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {};
    if (opts.caseId !== undefined) args["case_id"] = opts.caseId;
    if (opts.entityId !== undefined) args["entity_id"] = opts.entityId;
    return this.callTool("get_audit_trail", args);
  }

  /** `get_case_summary` — LLM-generated narrative summary of a case. */
  async getCaseSummary(
    caseId: string,
    purpose: string,
  ): Promise<Record<string, unknown>> {
    return this.callTool("get_case_summary", { case_id: caseId, purpose });
  }

  // --- RAG / ingest ---

  /** `rag_store_answer` — persist a Q&A pair for downstream RAG. */
  async ragStoreAnswer(
    question: string,
    answer: string,
    purpose: string,
    opts: { sourceIds?: string[] } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { question, answer, purpose };
    if (opts.sourceIds !== undefined) args["source_ids"] = opts.sourceIds;
    return this.callTool("rag_store_answer", args);
  }

  /** `rag_store_elements` — bulk persist structured RAG elements. */
  async ragStoreElements(
    elements: Record<string, unknown>[],
    purpose: string,
  ): Promise<Record<string, unknown>> {
    return this.callTool("rag_store_elements", { elements, purpose });
  }

  /** `ingest_document` — datagrep-envelope document ingest via MCP. */
  async ingestDocument(
    chunksJsonl: string,
    manifestJson: string,
    purpose: string,
  ): Promise<Record<string, unknown>> {
    return this.callTool("ingest_document", {
      chunks_jsonl: chunksJsonl,
      manifest_json: manifestJson,
      purpose,
    });
  }

  // --- Memory (the cognitive verbs are reachable via MCP too) ---
  // The dedicated `Memory` class is the typed surface; these MCP wrappers
  // exist for parity when an agent drives everything through /mcp/tools/call.

  /** `remember` MCP tool — store a memory (same shape as `Memory.add`). */
  async remember(
    content: string,
    purpose: string,
    opts: { confidence?: number; memoryClass?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("remember", {
      content,
      purpose,
      confidence: opts.confidence ?? 1.0,
      memory_class: opts.memoryClass ?? "semantic",
    });
  }

  /**
   * `recall` MCP tool.
   *
   * The five `min*`/`recency*`/`budget*`/`stability*`/`cancel*` options are
   * the ADR-145 retrieval-quality operators (`min_confidence` = CONFIDENCE,
   * `recency_half_life_secs` = RECENCY, `budget_tokens` = BUDGET,
   * `stability_days` = FORGETTING_CURVE, `cancel_threshold` = CANCEL_WHEN).
   * Each is omitted from the tool call when left `undefined`, so the server
   * applies its own default. The returned envelope carries the read-only
   * `recall_cost_tokens`/`cancelled` fields once unwrapped (see `unwrapMcp`).
   */
  async recall(
    query: string,
    purpose: string,
    opts: {
      topK?: number;
      minConfidence?: number;
      recencyHalfLifeSecs?: number;
      budgetTokens?: number;
      stabilityDays?: number;
      cancelThreshold?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      query,
      purpose,
      top_k: opts.topK ?? 5,
    };
    if (opts.minConfidence !== undefined) args["min_confidence"] = opts.minConfidence;
    if (opts.recencyHalfLifeSecs !== undefined) {
      args["recency_half_life_secs"] = opts.recencyHalfLifeSecs;
    }
    if (opts.budgetTokens !== undefined) args["budget_tokens"] = opts.budgetTokens;
    if (opts.stabilityDays !== undefined) args["stability_days"] = opts.stabilityDays;
    if (opts.cancelThreshold !== undefined) args["cancel_threshold"] = opts.cancelThreshold;
    return this.callTool("recall", args);
  }

  // -------------------------------------------------------------------------
  // #2322 — 42 (+4) previously Rust-only MCP tool wrappers, ported to TS.
  // -------------------------------------------------------------------------

  /** `remember_batch` — bulk `remember` write. */
  async rememberBatch(
    items: Record<string, unknown>[],
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { items };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("remember_batch", args);
  }

  /** `recognize` — look up a stored memory item by id. */
  async recognize(
    memoryId: string,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { id: memoryId };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("recognize", args);
  }

  /** `episodes_in` — list Episodes within an AgentSession. */
  async episodesIn(
    sessionId: string,
    opts: { limit?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      session_id: sessionId,
      limit: opts.limit ?? 20,
    };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("episodes_in", args);
  }

  /** `justify` — provenance/audit chain for a memory object. */
  async justify(
    memoryId: string,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { id: memoryId };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("justify", args);
  }

  /** `consolidate` — supersede a memory item with an updated belief. */
  async consolidate(
    memoryId: string,
    content: string,
    opts: { confidence?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      id: memoryId,
      content,
      confidence: opts.confidence ?? 1.0,
    };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("consolidate", args);
  }

  /** `forget` — apply a retention policy to a memory item. */
  async forget(
    memoryId: string,
    opts: { retainDays?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      id: memoryId,
      retain_days: opts.retainDays ?? 0,
    };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("forget", args);
  }

  /** `remember_procedure` — store a versioned agent procedure (T16/#2233). */
  async rememberProcedure(
    agentId: string,
    name: string,
    instructionText: string,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      agent_id: agentId,
      name,
      instruction_text: instructionText,
    };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("remember_procedure", args);
  }

  /** `recall_procedure` — read back stored procedures for an agent (T16/#2233). */
  async recallProcedure(
    agentId: string,
    opts: {
      name?: string;
      allVersions?: boolean;
      limit?: number;
      purpose?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      agent_id: agentId,
      all_versions: opts.allVersions ?? false,
      limit: opts.limit ?? 20,
    };
    if (opts.name !== undefined) args["name"] = opts.name;
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("recall_procedure", args);
  }

  /** `associate` — link two memory items/entities with a typed relation. */
  async associate(
    fromId: string,
    toId: string,
    opts: { relation?: string; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      from_id: fromId,
      to_id: toId,
      relation: opts.relation ?? "related_to",
    };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("associate", args);
  }

  /** `resolve` — follow a memory's supersession chain to its canonical head. */
  async resolve(
    memoryId: string,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { id: memoryId };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("resolve", args);
  }

  /** `summarise` — governed, provenance-stamped summary of a session/topic. */
  async summarise(
    opts: {
      ids?: string[];
      sessionId?: string;
      scope?: string;
      contents?: string[];
      purpose?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {};
    if (opts.ids !== undefined) args["ids"] = opts.ids;
    if (opts.sessionId !== undefined) args["session_id"] = opts.sessionId;
    if (opts.scope !== undefined) args["scope"] = opts.scope;
    if (opts.contents !== undefined) args["contents"] = opts.contents;
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("summarise", args);
  }

  /**
   * `nl_query` — natural-language question translated to SQL and executed.
   *
   * A dialect router (#3267) classifies each question as SQL, Cypher, or a governed
   * graph operator and prompts accordingly; the response carries a `dialect` field.
   * Pass `maxSubQuestions > 1` to decompose a multi-part question (e.g. "find X, and
   * who X is linked to") into independently-routed sub-questions — the response then
   * carries `decomposed: true` and a `sub_results` array instead of a single result.
   * Capped at 5 server-side regardless of the value given.
   */
  async nlQuery(
    query: string,
    opts: { purpose?: string; interpret?: boolean; maxSubQuestions?: number } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      query,
      interpret: opts.interpret ?? false,
    };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    if (opts.maxSubQuestions !== undefined) args["max_sub_questions"] = opts.maxSubQuestions;
    return this.callTool("nl_query", args);
  }

  /** `erase_subject` — GDPR Art. 17 crypto-shred erasure with a signed receipt. */
  async eraseSubject(
    subject: string,
    opts: { reason?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("erase_subject", {
      subject,
      reason: opts.reason ?? "gdpr-art17-request",
    });
  }

  /** `ingest_media` — ingest an image/audio/video (base64) or text payload. */
  async ingestMedia(
    objectType: string,
    opts: {
      modality?: string;
      codec?: string;
      bytesB64?: string;
      text?: string;
      tenantId?: string;
      partitionKey?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      object_type: objectType,
      modality: opts.modality ?? "image",
    };
    if (opts.codec !== undefined) args["codec"] = opts.codec;
    if (opts.bytesB64 !== undefined) args["bytes_b64"] = opts.bytesB64;
    if (opts.text !== undefined) args["text"] = opts.text;
    if (opts.tenantId !== undefined) args["tenant_id"] = opts.tenantId;
    if (opts.partitionKey !== undefined)
      args["partition_key"] = opts.partitionKey;
    return this.callTool("ingest_media", args);
  }

  /** `similar_multimodal` — governed cross-modal similarity search (ADR-106). */
  async similarMultimodal(
    entityType: string,
    entityId: string,
    opts: { topK?: number; modality?: string; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      entity_type: entityType,
      id: entityId,
      top_k: opts.topK ?? 10,
      modality: opts.modality ?? "text",
    };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("similar_multimodal", args);
  }

  /** `hybrid_search` — governed BM25 ⊕ vector retrieval fused via RRF. */
  async hybridSearch(
    entityType: string,
    query: string,
    opts: { topK?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      entity_type: entityType,
      query,
      top_k: opts.topK ?? 10,
    };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("hybrid_search", args);
  }

  /** `paths_between` — governed relationship/identity graph walk. */
  async pathsBetween(
    fromId: string,
    toId: string,
    opts: { maxHops?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      from: fromId,
      to: toId,
      max_hops: opts.maxHops ?? 4,
    };
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("paths_between", args);
  }

  /** `list_link_types` — every governed edge type defined in the ontology. */
  async listLinkTypes(): Promise<Record<string, unknown>> {
    return this.callTool("list_link_types", {});
  }

  /** `server_health` — readiness snapshot for an ops agent. */
  async serverHealth(): Promise<Record<string, unknown>> {
    return this.callTool("server_health", {});
  }

  /** `job_status` — list continuous detection jobs with live status. */
  async jobStatus(): Promise<Record<string, unknown>> {
    return this.callTool("job_status", {});
  }

  /** `metrics` — operational counters for a monitoring agent. */
  async metrics(): Promise<Record<string, unknown>> {
    return this.callTool("metrics", {});
  }

  /** `list_rules` — list detection rules (ADR-162). */
  async listRules(): Promise<Record<string, unknown>> {
    return this.callTool("list_rules", {});
  }

  /** `create_rule` — create a detection rule (ADR-162). */
  async createRule(
    name: string,
    conditionSql: string,
    opts: { severity?: string; description?: string; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      name,
      condition_sql: conditionSql,
      purpose: opts.purpose ?? "security",
    };
    if (opts.severity !== undefined) args["severity"] = opts.severity;
    if (opts.description !== undefined) args["description"] = opts.description;
    return this.callTool("create_rule", args);
  }

  /** `import_sigma` — import a Sigma detection rule (YAML). */
  async importSigma(
    sigmaYaml: string,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("import_sigma", {
      yaml: sigmaYaml,
      purpose: opts.purpose ?? "security",
    });
  }

  /** `list_jobs` — list all registered detection jobs with live status. */
  async listJobs(): Promise<Record<string, unknown>> {
    return this.callTool("list_jobs", {});
  }

  /** `schedule_job` — trigger an immediate run of a named detection job. */
  async scheduleJob(name: string): Promise<Record<string, unknown>> {
    return this.callTool("schedule_job", { name });
  }

  /** `list_workflows` — list all registered workflow definitions. */
  async listWorkflows(): Promise<Record<string, unknown>> {
    return this.callTool("list_workflows", {});
  }

  /** `run_workflow` — start a workflow execution by name. */
  async runWorkflow(name: string): Promise<Record<string, unknown>> {
    return this.callTool("run_workflow", { name });
  }

  /** `workflow_status` — query step-level status of a workflow run. */
  async workflowStatus(runId: string): Promise<Record<string, unknown>> {
    return this.callTool("workflow_status", { run_id: runId });
  }

  /** `trace_crypto` — follow a cryptocurrency address hop-by-hop. */
  async traceCrypto(
    address: string,
    opts: { maxHops?: number; minAmount?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("trace_crypto", {
      address,
      max_hops: opts.maxHops ?? 5,
      min_amount: opts.minAmount ?? 0,
      purpose: opts.purpose ?? "analytics",
    });
  }

  /** `beneficial_ownership` — trace the beneficial ownership chain for a party. */
  async beneficialOwnership(
    party: string,
    opts: { maxDepth?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("beneficial_ownership", {
      party,
      max_depth: opts.maxDepth ?? 6,
      purpose: opts.purpose ?? "analytics",
    });
  }

  /** `reconstruct_wire` — reconstruct a wire-transfer chain for an account. */
  async reconstructWire(
    account: string,
    opts: { tolerancePct?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("reconstruct_wire", {
      account,
      tolerance_pct: opts.tolerancePct ?? 5.0,
      purpose: opts.purpose ?? "analytics",
    });
  }

  /** `trace_hawala` — trace informal hawala value-transfer networks. */
  async traceHawala(
    seed: string,
    opts: { maxHops?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("trace_hawala", {
      seed,
      max_hops: opts.maxHops ?? 5,
      purpose: opts.purpose ?? "analytics",
    });
  }

  /** `geofence` — spatial fence query over a circular area. */
  async geofence(
    lat: number,
    lon: number,
    opts: { radiusM?: number; targetType?: string; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("geofence", {
      lat,
      lon,
      radius_m: opts.radiusM ?? 1000,
      target_type: opts.targetType ?? "MovementEvent",
      purpose: opts.purpose ?? "analytics",
    });
  }

  /** `resolve_entity_identity` — resolve the canonical identity cluster. */
  async resolveEntityIdentity(
    identity: string,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("resolve_entity_identity", {
      identity,
      purpose: opts.purpose ?? "analytics",
    });
  }

  /** `detect_communities` — Louvain/Leiden community detection. */
  async detectCommunities(
    entityType: string,
    opts: { algo?: string; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("detect_communities", {
      entity_type: entityType,
      algo: opts.algo ?? "louvain",
      purpose: opts.purpose ?? "analytics",
    });
  }

  /** `rank_key_nodes` — rank entities by PageRank or centrality metric. */
  async rankKeyNodes(
    entityType: string,
    opts: {
      metric?: string;
      damping?: number;
      maxIter?: number;
      purpose?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("rank_key_nodes", {
      entity_type: entityType,
      metric: opts.metric ?? "pagerank",
      damping: opts.damping ?? 0.85,
      max_iter: opts.maxIter ?? 20,
      purpose: opts.purpose ?? "analytics",
    });
  }

  /** `hub_authority` — HITS hub/authority scores for an entity type. */
  async hubAuthority(
    entityType: string,
    opts: { maxIter?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("hub_authority", {
      entity_type: entityType,
      max_iter: opts.maxIter ?? 20,
      purpose: opts.purpose ?? "analytics",
    });
  }

  /** `predict_links` — score candidate edges between entities. */
  async predictLinks(
    entityType: string,
    opts: {
      fromId?: string;
      toId?: string;
      method?: string;
      purpose?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      entity_type: entityType,
      method: opts.method ?? "common_neighbors",
      purpose: opts.purpose ?? "analytics",
    };
    if (opts.fromId !== undefined) args["from_id"] = opts.fromId;
    if (opts.toId !== undefined) args["to_id"] = opts.toId;
    return this.callTool("predict_links", args);
  }

  /** `find_scc` — find strongly connected components in an entity type's graph. */
  async findScc(
    entityType: string,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("find_scc", {
      entity_type: entityType,
      purpose: opts.purpose ?? "analytics",
    });
  }

  /** `screen_sanctions` — screen a name/entity against sanctions lists. */
  async screenSanctions(
    name: string,
    opts: { threshold?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      name,
      purpose: opts.purpose ?? "compliance_review",
    };
    if (opts.threshold !== undefined) args["threshold"] = opts.threshold;
    return this.callTool("screen_sanctions", args);
  }

  /** `aggregate_stats` — governed aggregate query over an entity type. */
  async aggregateStats(
    entityType: string,
    opts: { agg?: string; column?: string; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("aggregate_stats", {
      entity_type: entityType,
      agg: opts.agg ?? "COUNT",
      column: opts.column ?? "*",
      purpose: opts.purpose ?? "analytics",
    });
  }

  /** `investigate_entity` — composite profile + timeline + connections + risk. */
  async investigateEntity(
    entityType: string,
    entityId: string,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("investigate_entity", {
      entity_type: entityType,
      id: entityId,
      purpose: opts.purpose ?? "security_incident",
    });
  }

  /** `find_threats` — composite threat hunt over an entity type. */
  async findThreats(
    entityType: string,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("find_threats", {
      entity_type: entityType,
      purpose: opts.purpose ?? "security_incident",
    });
  }

  /** `search_video_frames` — similarity search over video frames/segments. */
  async searchVideoFrames(
    queryId: string,
    opts: { mediaType?: string; topK?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("search_video_frames", {
      query_id: queryId,
      media_type: opts.mediaType ?? "VideoFrame",
      top_k: opts.topK ?? 20,
      purpose: opts.purpose ?? "security_incident",
    });
  }

  /** `face_match` — GATED: match a probe face against indexed media. */
  async faceMatch(
    probeId: string,
    opts: { threshold?: number; topK?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("face_match", {
      probe_id: probeId,
      threshold: opts.threshold ?? 0.8,
      top_k: opts.topK ?? 10,
      purpose: opts.purpose ?? "security_incident",
    });
  }
}
