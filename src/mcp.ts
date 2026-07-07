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

  /** `recall` MCP tool. */
  async recall(
    query: string,
    purpose: string,
    opts: { topK?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.callTool("recall", {
      query,
      purpose,
      top_k: opts.topK ?? 5,
    });
  }
}
