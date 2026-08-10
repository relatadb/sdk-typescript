/**
 * structural-navigation.ts — Structural table-of-contents navigation — RAG
 * epic SDK-side agentic retrieval strategy (#4542). Port of
 * `sdks/python/relata/structural_navigation.py` (#4581, TS/Go parity —
 * epic #4576).
 *
 * The substrate half of #4542 (`crates/relata-storage/src/document_ingest.rs`
 * `document_structure_batch`) derives a `DocumentStructureNode` tree from
 * each document's `section_path`/`page_start`/`page_end` — one node per
 * distinct heading-breadcrumb prefix, plus a synthetic root, each carrying a
 * cheap LLM-free one-line `summary` and its direct `leaf_chunk_ids`.
 * `POST /rag/query`'s `search_mode: structural` (#4514/#4542,
 * `crates/relata-cli/src/serve/query/rag_query.rs`) is a single-shot,
 * one-hop approximation of tree navigation: it lexically matches node
 * title/summary, then ranks within the matched node(s)' own leaf chunks.
 *
 * This module is the **true multi-hop agent** the ticket's design section
 * describes: starting at the document root, {@link
 * StructuralNavigator.navigateStructuralTree} repeatedly fetches the current
 * node's children ({@link StructuralNavigator.fetchChildNodes}), asks a
 * `selectChild` strategy which subtree to descend into, and stops either
 * when a level has no children (a leaf) or the strategy declines to descend
 * further — then ranks that leaf's own `leaf_chunk_ids` via a governed
 * `RAG_RETRIEVE` call, exactly like every other `/rag/query` mode (same
 * ACL/cell-masking enforcement — no bypass, since this still goes through
 * `RelataClient.query`, the same governed `/query` surface `/rag/query`
 * itself delegates to server-side).
 *
 * Per ADR-0298, RelataDB has no server-side agent loop — the reasoning that
 * picks which child to descend into is a caller-supplied `selectChild`
 * callable, never called by RelataDB itself. {@link lexicalChildSelector}
 * (exposed as {@link StructuralNavigator.lexicalChildSelector}) is a
 * zero-dependency, LLM-free default (word-overlap between the question and
 * each candidate's title/summary) so this module is usable standalone; an
 * application wanting real judgement supplies its own LLM-backed selector
 * with the same signature.
 *
 * ```typescript
 * import { RelataClient, StructuralNavigator } from "@zysec-ai/relata-sdk";
 *
 * const client = new RelataClient({ baseUrl, defaultPurpose: "research" });
 * const nav = new StructuralNavigator(client);
 * const response = await nav.navigateStructuralTree({
 *   reportId: "doc_1",
 *   question: "What are the liquidity termination clauses?",
 *   type: "DocumentChunk",
 * });
 * ```
 */

import type { RelataClient } from "./client.ts";
import { PurposeError } from "./errors.ts";
import { sqlLiteral, validateIdentifier } from "./_sql.ts";
import { RAG_DEFAULT_TOP_K, type RagHit, type RagQueryResponse } from "./rag.ts";

/**
 * Hard ceiling on tree descent depth — a runaway `selectChild` (e.g. one
 * that always returns a child even on a cyclic/malformed tree) cannot loop
 * forever; #4542's node ids are acyclic by construction (a strict
 * prefix-of-`section_path` tree), so this should never actually bind.
 */
export const DEFAULT_MAX_DEPTH = 12;

/**
 * One `DocumentStructureNode` row (#4542), as returned by a plain
 * `SELECT * FROM DocumentStructureNode` via {@link RelataClient.query}.
 */
export interface StructureNode {
  nodeId: string;
  reportId: string;
  parentId: string | null;
  title: string;
  depth: number;
  pageStart: number | null;
  pageEnd: number | null;
  summary: string | null;
  childCount: number;
  leafChunkIds: string[];
  /** `true` when this node has no children (`childCount === 0`). */
  isLeaf: boolean;
}

/**
 * A caller-supplied reasoning strategy: given the question and the current
 * level's candidate children, return the child to descend into, or `null`
 * to stop descending (the current node is judged good enough already).
 * RelataDB never calls an LLM itself (ADR-013) — a real agentic strategy is
 * always supplied by the application; see {@link
 * StructuralNavigator.lexicalChildSelector} for the zero-dependency default.
 */
export type ChildSelector = (
  question: string,
  children: StructureNode[],
) => StructureNode | null;

/** Options for {@link StructuralNavigator.navigateStructuralTree}. */
export interface NavigateStructuralTreeOptions {
  reportId: string;
  question: string;
  /** Object type to rank the leaf's `leaf_chunk_ids` against (e.g. `"DocumentChunk"`). */
  type: string;
  /** Defaults to {@link StructuralNavigator.lexicalChildSelector}. */
  selectChild?: ChildSelector;
  /** PURPOSE token — falls back to the client's `defaultPurpose`. */
  purpose?: string;
  topK?: number;
  rerank?: boolean;
  /** Defaults to {@link DEFAULT_MAX_DEPTH}. */
  maxDepth?: number;
}

const WORD_RE = /[a-z0-9]+/g;

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(WORD_RE) ?? []);
}

function asStringOrNull(v: unknown): string | null {
  return v === undefined || v === null ? null : String(v);
}

function asNumberOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * Build a `{ purpose }` options fragment, omitting the key entirely when
 * `purpose` is `undefined` rather than setting it explicitly — required
 * under `exactOptionalPropertyTypes` (tsconfig.json), which treats "key
 * present with value `undefined`" as distinct from "key absent" for an
 * optional property typed `purpose?: string`.
 */
function purposeOpt(purpose: string | undefined): { purpose?: string } {
  return purpose === undefined ? {} : { purpose };
}

/**
 * Structural table-of-contents navigation over `RelataClient`. Every fetch
 * (`fetchRootNode`/`fetchChildNodes`/the final ranked `RAG_RETRIEVE`) goes
 * through `RelataClient.query` — the same governed `/query` surface — so
 * ACL/cell-masking apply identically at every level; there is no bypass path.
 */
export class StructuralNavigator {
  readonly #client: RelataClient;

  constructor(client: RelataClient) {
    this.#client = client;
  }

  /**
   * Build a {@link StructureNode} from one `/query` result row.
   *
   * `leafChunkIds` is stored server-side as a JSON array string
   * (`crates/relata-storage/src/document_ingest.rs` — no native array
   * `CanonicalValue` variant); this parses it back into a real list,
   * defaulting to `[]` on anything malformed rather than throwing, so a
   * node with no directly-attached chunks (an internal/structural-only
   * node) never breaks tree descent.
   */
  static structureNodeFromRow(row: Record<string, unknown>): StructureNode {
    const rawIds = row["leaf_chunk_ids"];
    let leafChunkIds: string[];
    if (Array.isArray(rawIds)) {
      leafChunkIds = rawIds.map((x) => String(x));
    } else if (typeof rawIds === "string" && rawIds) {
      try {
        const parsed: unknown = JSON.parse(rawIds);
        leafChunkIds = Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
      } catch {
        leafChunkIds = [];
      }
    } else {
      leafChunkIds = [];
    }
    const childCount = asNumberOrNull(row["child_count"]) ?? 0;
    return {
      nodeId: String(row["node_id"] ?? ""),
      reportId: String(row["report_id"] ?? ""),
      parentId: asStringOrNull(row["parent_id"]),
      title: String(row["title"] ?? ""),
      depth: asNumberOrNull(row["depth"]) ?? 0,
      pageStart: asNumberOrNull(row["page_start"]),
      pageEnd: asNumberOrNull(row["page_end"]),
      summary: asStringOrNull(row["summary"]),
      childCount,
      leafChunkIds,
      isLeaf: childCount === 0,
    };
  }

  /**
   * Zero-dependency, LLM-free default {@link ChildSelector}: picks the
   * child whose `title`/`summary` shares the most question words (simple
   * token-overlap count), or `null` when no child shares even one word
   * with the question — in which case {@link navigateStructuralTree} stops
   * descending at the current node rather than picking an unrelated child.
   *
   * Not a substitute for real reasoning over the child summaries (an
   * LLM-backed selector will pick better subtrees on paraphrased
   * questions); this exists so the module is usable standalone and as the
   * documented reference implementation of the {@link ChildSelector}
   * contract.
   */
  static lexicalChildSelector(question: string, children: StructureNode[]): StructureNode | null {
    const qTokens = tokenize(question);
    if (qTokens.size === 0) return null;
    let best: StructureNode | null = null;
    let bestOverlap = 0;
    for (const child of children) {
      const candidateTokens = tokenize(`${child.title} ${child.summary ?? ""}`);
      let overlap = 0;
      for (const t of qTokens) if (candidateTokens.has(t)) overlap++;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = child;
      }
    }
    return best;
  }

  /**
   * Fetch the direct children of `parentId` (or the synthetic root's
   * single row when `parentId` is `null`) for `reportId`'s
   * `DocumentStructureNode` tree, via a plain governed `SELECT` — the same
   * `/query` surface `/rag/query` itself delegates to server-side, so
   * ACL/cell-masking apply identically.
   */
  async fetchChildNodes(opts: {
    reportId: string;
    parentId: string | null;
    purpose?: string;
  }): Promise<StructureNode[]> {
    const parentClause =
      opts.parentId === null
        ? "parent_id IS NULL"
        : `parent_id = ${sqlLiteral(opts.parentId)}`;
    const sql =
      `SELECT * FROM DocumentStructureNode WHERE report_id = ${sqlLiteral(opts.reportId)} ` +
      `AND ${parentClause}`;
    const result = await this.#client.query(sql, purposeOpt(opts.purpose));
    return result.rows.map((row) =>
      StructuralNavigator.structureNodeFromRow(row as Record<string, unknown>),
    );
  }

  /**
   * Fetch `reportId`'s synthetic tree root (`parent_id IS NULL`), or
   * `null` when the document has no `DocumentStructureNode` tree at all —
   * e.g. it was ingested with no `section_path` anywhere
   * (`document_structure_batch` returns no batch in that case).
   */
  async fetchRootNode(opts: { reportId: string; purpose?: string }): Promise<StructureNode | null> {
    const roots = await this.fetchChildNodes({
      reportId: opts.reportId,
      parentId: null,
      ...purposeOpt(opts.purpose),
    });
    return roots[0] ?? null;
  }

  #rowToHit(row: Record<string, unknown>, rerankRequested: boolean): RagHit {
    const entityIdsRaw = row["canonical_entity_id"];
    let entityIds: string[];
    if (Array.isArray(entityIdsRaw)) {
      entityIds = entityIdsRaw.map((x) => String(x));
    } else if (typeof entityIdsRaw === "string" && entityIdsRaw) {
      entityIds = [entityIdsRaw];
    } else {
      entityIds = [];
    }
    return {
      bm25_score: asNumberOrNull(row["_bm25_score"]) ?? 0,
      vector_score: asNumberOrNull(row["_vector_score"]) ?? 0,
      rerank_score: rerankRequested ? asNumberOrNull(row["_rerank_score"]) : null,
      chunk_id: String(row["chunk_id"] ?? ""),
      report_id: String(row["report_id"] ?? ""),
      text: String(row["text_body"] ?? ""),
      section_path: Array.isArray(row["section_path"]) ? (row["section_path"] as string[]) : [],
      page_start: asNumberOrNull(row["page_start"]) ?? 0,
      page_end: asNumberOrNull(row["page_end"]) ?? 0,
      prev_chunk_id: asStringOrNull(row["prev_chunk_id"]),
      next_chunk_id: asStringOrNull(row["next_chunk_id"]),
      entity_ids: entityIds,
      // The raw RAG_RETRIEVE SQL operator (crates/relata-query/src/executor/
      // vector_search_exec.rs) only ever emits _bm25_score/_vector_score/
      // _rerank_score columns — relevance_confidence (#4520) is computed one
      // layer up, in the /rag/query HTTP handler
      // (crates/relata-cli/src/serve/query/rag_query.rs), which this SQL-only
      // path never goes through. null here mirrors the Python reference's
      // RagHit.relevance_confidence default (None) exactly.
      relevance_confidence: null,
    };
  }

  /**
   * Rank `chunkIds` (a leaf node's own `leafChunkIds`) against `question`
   * via a governed `RAG_RETRIEVE`, restricted with `WHERE chunk_id IN
   * (...)` — same grammar/ordering as the server's `search_mode:
   * structural` second-hop query.
   */
  async #fetchRankedLeafChunks(opts: {
    type: string;
    question: string;
    chunkIds: string[];
    purpose: string;
    topK: number;
    rerank: boolean;
  }): Promise<RagQueryResponse> {
    validateIdentifier(opts.type, "type");
    const inList = opts.chunkIds.map((id) => sqlLiteral(id)).join(", ");
    let sql =
      `PURPOSE ${sqlLiteral(opts.purpose)} RAG_RETRIEVE FROM ${opts.type} ` +
      `QUERY ${sqlLiteral(opts.question)} TOP_K ${Math.trunc(opts.topK)}`;
    if (opts.rerank) sql += " RERANK";
    sql += " WEIGHTS 0.33 0.34 0.33";
    sql += ` WHERE chunk_id IN (${inList})`;
    const result = await this.#client.query(sql, { purpose: opts.purpose });
    const hits = result.rows.map((row) =>
      this.#rowToHit(row as Record<string, unknown>, opts.rerank),
    );
    return { hits };
  }

  /**
   * Agentically navigate `reportId`'s `DocumentStructureNode` tree (#4542):
   * descend from the synthetic root, one level per {@link fetchChildNodes}
   * call, letting `selectChild` reason over each level's candidate
   * titles/summaries — until a level has no children (a leaf) or
   * `selectChild` returns `null` (stop here) — then rank that node's own
   * `leafChunkIds` against `question`.
   *
   * This is the true multi-hop agent loop #4542's design describes,
   * complementing (not replacing) `/rag/query`'s single-shot `search_mode:
   * structural` (#4514) — `selectChild` is where an application plugs in
   * real reasoning (e.g. an LLM call over the candidates' `summary`
   * fields); {@link lexicalChildSelector} is the LLM-free default.
   *
   * Every fetch goes through `RelataClient.query` — the same governed
   * `/query` surface — so ACL/cell-masking apply identically at every
   * level; there is no bypass path.
   *
   * Returns an empty {@link RagQueryResponse} when `reportId` has no
   * `DocumentStructureNode` tree at all, or the node reached has no
   * `leafChunkIds` — never throws for "nothing to navigate," matching
   * every other `search_mode`'s "genuinely nothing matched" shape.
   *
   * @throws {PurposeError} No purpose available (falls back to the
   *   client's `defaultPurpose` when `opts.purpose` is omitted).
   */
  async navigateStructuralTree(opts: NavigateStructuralTreeOptions): Promise<RagQueryResponse> {
    const effectivePurpose = opts.purpose ?? this.#client.defaultPurpose;
    if (!effectivePurpose) {
      throw new PurposeError(
        undefined,
        "navigateStructuralTree requires a purpose. Pass `purpose` in the " +
          "options or set `defaultPurpose` on the RelataClient.",
      );
    }

    let current = await this.fetchRootNode({ reportId: opts.reportId, purpose: effectivePurpose });
    if (current === null) {
      return { hits: [] };
    }

    const selectChild = opts.selectChild ?? StructuralNavigator.lexicalChildSelector;
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

    let depth = 0;
    while (depth < maxDepth) {
      const children = await this.fetchChildNodes({
        reportId: opts.reportId,
        parentId: current.nodeId,
        purpose: effectivePurpose,
      });
      if (children.length === 0) break;
      const chosen = selectChild(opts.question, children);
      if (chosen === null) break;
      current = chosen;
      depth++;
    }

    if (current.leafChunkIds.length === 0) {
      return { hits: [] };
    }

    return this.#fetchRankedLeafChunks({
      type: opts.type,
      question: opts.question,
      chunkIds: current.leafChunkIds,
      purpose: effectivePurpose,
      topK: opts.topK ?? RAG_DEFAULT_TOP_K,
      rerank: opts.rerank ?? false,
    });
  }
}
