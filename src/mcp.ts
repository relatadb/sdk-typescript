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

  /**
   * Send the MCP initialize handshake. Wraps `POST /mcp/initialize`.
   *
   * `clientId`/`version` are accepted for API stability but currently have
   * no server-side effect: `mcp_initialize` (`crates/relata-cli/src/serve/mcp.rs`)
   * takes no body extractor at all, so the request body is never parsed (#4657).
   */
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

  /**
   * `search_knowledge` — hybrid BM25 + vector search. `opts.topK` is sent
   * as the server's `limit` key (`mcp_tool_search_knowledge` in
   * `crates/relata-cli/src/serve/mcp/knowledge_search.rs` reads `limit`,
   * not `top_k`, #4652).
   */
  async searchKnowledge(
    query: string,
    purpose: string,
    opts: { topK?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("search_knowledge", {
      query,
      purpose,
      limit: opts.topK ?? 10,
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

  /**
   * `suggest_extensions` — type/canonical-kind autocomplete.
   *
   * The server's `mcp_tool_suggest_extensions` takes no `args` at all — the
   * dispatch table calls it with no arguments forwarded — so it always
   * returns the full, unfiltered extension-pack list; there is no `prefix`
   * filter to send (#4657).
   */
  async suggestExtensions(): Promise<Record<string, unknown>> {
    return this.callTool("suggest_extensions", {});
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

  /**
   * `get_domain_summary` — counts + freshness per type for one domain.
   *
   * The server's `mcp_tool_get_domain_summary` requires a `domain` key
   * (e.g. `"financial"`, `"telco"`, `"cyber"`, `"humint"`, `"narcotics"`,
   * `"fara"`, `"maritime"`, `"border"`, `"sanctions"`) — `object_type` is
   * never read (#4645).
   */
  async getDomainSummary(domain: string): Promise<Record<string, unknown>> {
    return this.callTool("get_domain_summary", { domain });
  }

  /**
   * `find_in_social_corpus` — search the ingested social-media corpus.
   *
   * The server's `mcp_tool_find_in_social_corpus` requires `object_type`
   * and reads the free-text leg from `text_query`, not `query`; `corpus`
   * is not read anywhere in the handler (#4644).
   */
  async findInSocialCorpus(
    objectType: string,
    textQuery: string,
    opts: { user?: string; userField?: string; blobField?: string; topK?: number } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      object_type: objectType,
      text_query: textQuery,
    };
    if (opts.user !== undefined) args["user"] = opts.user;
    if (opts.userField !== undefined) args["user_field"] = opts.userField;
    if (opts.blobField !== undefined) args["blob_field"] = opts.blobField;
    if (opts.topK !== undefined) args["top_k"] = opts.topK;
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

  /**
   * `get_entity_profile` — rich per-entity dossier.
   *
   * The server's `mcp_tool_get_entity_profile` requires a `name` key (a
   * case-insensitive name search across profile-relevant types) and never
   * reads `entity_id` (#4647).
   */
  async getEntityProfile(
    name: string,
    purpose: string,
  ): Promise<Record<string, unknown>> {
    return this.callTool("get_entity_profile", { name, purpose });
  }

  /**
   * `get_timeline` — chronological event list for an entity.
   *
   * The server's `mcp_tool_get_timeline` reads the entity filter from
   * `entity`, not `entity_id`, and has no time-range concept — `since_ns`/
   * `until_ns` were dead parameters with no server-side effect and have
   * been dropped; `limit` (real, server-side, capped at 1000) is exposed
   * instead (#4649).
   */
  async getTimeline(
    entity: string,
    purpose: string,
    opts: { limit?: number } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { entity, purpose };
    if (opts.limit !== undefined) args["limit"] = opts.limit;
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

  /**
   * `get_relationships` — filtered read over `KnowledgeTriple` rows.
   *
   * The server's `mcp_tool_get_relationships` never reads `entity_id`/
   * `depth` (there is no hop-depth graph walk here, only a flat triple
   * filter) — it reads `purpose`, `limit`, and lowercase `subject`/
   * `predicate`/`object`/`source` filters. This wrapper now exposes that
   * real filter shape directly (#4646).
   */
  async getRelationships(
    purpose: string,
    opts: {
      subject?: string;
      predicate?: string;
      object?: string;
      source?: string;
      limit?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { purpose };
    if (opts.subject !== undefined) args["subject"] = opts.subject;
    if (opts.predicate !== undefined) args["predicate"] = opts.predicate;
    if (opts.object !== undefined) args["object"] = opts.object;
    if (opts.source !== undefined) args["source"] = opts.source;
    if (opts.limit !== undefined) args["limit"] = opts.limit;
    return this.callTool("get_relationships", args);
  }

  /**
   * `add_case_note` — append an investigative note to a case.
   *
   * `opts.author` is accepted for API stability but currently has no
   * server-side effect: `mcp_tool_add_case_note_with_gate` never reads an
   * `author` field (#4657).
   */
  async addCaseNote(
    caseId: string,
    note: string,
    opts: { author?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { case_id: caseId, note };
    if (opts.author !== undefined) args["author"] = opts.author;
    return this.callTool("add_case_note", args);
  }

  /**
   * `get_audit_trail` — provenance chain, optionally filtered by principal.
   *
   * The server's `mcp_tool_get_audit_trail` never reads `case_id`/
   * `entity_id` — it filters by `principal_filter` and `limit`, and treats
   * `purpose: "all"` as a sentinel that bypasses the usual purpose
   * allowlist check (#4650).
   */
  async getAuditTrail(
    opts: { principalFilter?: string; limit?: number; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {};
    if (opts.principalFilter !== undefined) args["principal_filter"] = opts.principalFilter;
    if (opts.limit !== undefined) args["limit"] = opts.limit;
    if (opts.purpose !== undefined) args["purpose"] = opts.purpose;
    return this.callTool("get_audit_trail", args);
  }

  /**
   * `get_case_summary` — tenant-wide data inventory + knowledge-graph
   * stats + analyst notes.
   *
   * NOT case-scoped: `mcp_tool_get_case_summary` never reads a `case_id`
   * argument anywhere — there is no case-scoping capability in this
   * handler at all (confirmed by reading the full function body), so the
   * previously-required `caseId` parameter was dropped rather than kept as
   * a misleading filter (#4651, same treatment as `dnsTunnelDetect` in
   * #4637). `includeGraph`/`includeNotes`/`includeAnswers` are real,
   * server-read toggles (each defaults `true` server-side when omitted).
   */
  async getCaseSummary(
    purpose: string,
    opts: { includeGraph?: boolean; includeNotes?: boolean; includeAnswers?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { purpose };
    if (opts.includeGraph !== undefined) args["include_graph"] = opts.includeGraph;
    if (opts.includeNotes !== undefined) args["include_notes"] = opts.includeNotes;
    if (opts.includeAnswers !== undefined) args["include_answers"] = opts.includeAnswers;
    return this.callTool("get_case_summary", args);
  }

  // --- RAG / ingest ---

  /**
   * `rag_store_answer` — persist a Q&A pair for downstream RAG.
   *
   * The server's `mcp_tool_rag_store_answer_with_gate` reads a `sources`
   * array of objects (each with an `id`/`url`, `source`/`title`, and
   * `score`/`relevance` field) — `source_ids` is never read anywhere in
   * the handler, so citation data supplied that way was silently dropped
   * (#4653).
   */
  async ragStoreAnswer(
    question: string,
    answer: string,
    purpose: string,
    opts: { sources?: Record<string, unknown>[] } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { question, answer, purpose };
    if (opts.sources !== undefined) args["sources"] = opts.sources;
    return this.callTool("rag_store_answer", args);
  }

  /**
   * `rag_store_elements` — bulk persist structured RAG elements.
   *
   * The server's `mcp_tool_rag_store_elements_with_gate` requires
   * `source_filename` (no default) — every call 400ed without it (#4654).
   * `sourceSha256`/`label` mirror the handler's other optional fields.
   */
  async ragStoreElements(
    elements: Record<string, unknown>[],
    sourceFilename: string,
    purpose: string,
    opts: { sourceSha256?: string; label?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      elements,
      source_filename: sourceFilename,
      purpose,
    };
    if (opts.sourceSha256 !== undefined) args["source_sha256"] = opts.sourceSha256;
    if (opts.label !== undefined) args["label"] = opts.label;
    return this.callTool("rag_store_elements", args);
  }

  /**
   * `ingest_document` — store a source document, its extracted text, and
   * (optionally) pre-extracted entities/relations.
   *
   * Rewritten (#4655): the previous `chunksJsonl`/`manifest_json` shape was
   * never read anywhere in `mcp_tool_ingest_document_with_gate` — the
   * handler has a flat schema instead (`source`, `text`, `label`,
   * `confidence`, `entities`, `relations`), and since `text` always fell
   * back to `""` (never sent by the old wrapper), the handler's
   * `if !text.is_empty()` storage branch never ran: every call returned
   * HTTP 200 but silently ingested nothing. This wrapper now matches the
   * real schema instead of a nonexistent chunked-document API.
   */
  async ingestDocument(
    source: string,
    text: string,
    purpose: string,
    opts: {
      label?: string;
      confidence?: number;
      entities?: Record<string, unknown>[];
      relations?: Record<string, unknown>[];
    } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { source, text, purpose };
    if (opts.label !== undefined) args["label"] = opts.label;
    if (opts.confidence !== undefined) args["confidence"] = opts.confidence;
    if (opts.entities !== undefined) args["entities"] = opts.entities;
    if (opts.relations !== undefined) args["relations"] = opts.relations;
    return this.callTool("ingest_document", args);
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

  /**
   * `create_rule` — create a detection rule (ADR-162).
   *
   * The underlying `POST /rules` handler (`rules_create_handler`,
   * `crates/relata-cli/src/serve/rules.rs`) requires `target_type` with no
   * default — every call 400ed without it (#4656). `description` has been
   * dropped: it is never read anywhere in `rules.rs` (a dead parameter,
   * same treatment as `dnsTunnelDetect` in #4637).
   */
  async createRule(
    name: string,
    conditionSql: string,
    targetType: string,
    opts: { severity?: string; purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      name,
      condition_sql: conditionSql,
      target_type: targetType,
      purpose: opts.purpose ?? "security",
    };
    if (opts.severity !== undefined) args["severity"] = opts.severity;
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
