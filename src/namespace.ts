/**
 * Namespace handle — T9 flagship retrieval surface (#1991, #2491; epic #1982).
 *
 * A {@link Namespace} binds a parent {@link RelataClient} to a single object
 * type (the retrieval-market word for which is "namespace" / "index" /
 * "collection"). It exposes the search-developer shape the market expects,
 * with no SQL on the client side:
 *
 * ```typescript
 * const relata = createClient("http://localhost:9090", { defaultPurpose: "rag" });
 * const docs = relata.namespace("Document");
 *
 * // Schemaless write — POST /ingest/auto auto-creates the type with fields
 * // inferred from the rows (T6, #1988 — no DDL):
 * await docs.write([
 *   { id: "d1", title: "Knowledge graphs 101", body: "..." },
 *   { id: "d2", title: "Vector search", body: "..." },
 * ]);
 *
 * // Typed ranked search (T1, #1983) — text compiles to a BM25 rank_by
 * // directive; filters narrow the set server-side:
 * const res = await docs.query({ text: "graph retrieval", limit: 10 });
 * for (const row of res.rows) console.log(row);
 * ```
 *
 * All requests run under the parent client's auth, tenant, and purpose
 * context (governance travels in the substrate). The connection pool is the
 * parent client's single shared transport — one pool, reused across every
 * namespace.
 *
 * TypeScript is async-native, so every method returns a `Promise` — there is
 * no separate `AsyncNamespace` (the SDK-wide parity decision). Mirrors the
 * Python `relata.namespace.Namespace` / `AsyncNamespace` surface.
 */

import { RelataClient } from "./client.ts";
import { IngestClient } from "./ingest.ts";
import { SearchClient } from "./search.ts";
import type { SearchFilter, SearchRankBy } from "./search.ts";
import type { QueryResult } from "./types.ts";

// Safe-identifier gate before embedding the namespace name into SQL / paths.
// Mirrors the Python `_TYPE_RE` (`relata/namespace.py`) and the server's
// validate rule (`^[A-Za-z_][A-Za-z0-9_]{0,127}$`).
const TYPE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @internal Validate a namespace/type name before embedding it in SQL/paths. */
export function validateNamespaceName(name: string): void {
  if (typeof name !== "string" || !TYPE_RE.test(name)) {
    throw new Error(
      `invalid namespace/type name ${JSON.stringify(name)}: must match ^[A-Za-z_][A-Za-z0-9_]*$`,
    );
  }
}

/** Options for {@link Namespace.query}. See {@link SearchClient.query} for details. */
export interface NamespaceQueryOptions {
  /** BM25 shorthand — compiles to `rank_by = ["bm25", matchColumn, text]`. */
  text?: string;
  /** Column for the `text` BM25 match (default `"*"` = whole-row). */
  matchColumn?: string;
  /** Explicit ranking directive (overrides `text`). */
  rankBy?: SearchRankBy;
  /** Filter clauses, or an equality dict `{ field: value }`. */
  filters?: SearchFilter[] | Record<string, unknown>;
  /** Max hits (server clamps to [1, 10000]); default 20. */
  limit?: number;
  /** Column projection (default `*`). */
  includeAttributes?: string[];
  /** `"strong"` (default) | `"eventual"`. */
  consistency?: "strong" | "eventual";
  /** Optional purpose override. */
  purpose?: string;
}

/** Options for {@link Namespace.write}. */
export interface NamespaceWriteOptions {
  /**
   * Optional field-type overrides. Pins a field's type
   * (`"text"`/`"int"`/`"float"`/`"bool"`/`"bytes"`/`"datetime"`/
   * `"<model>:<mod>:<ver>:<dim>"`) instead of relying on server-side
   * inference.
   */
  schema?: Record<string, string>;
  /** Optional purpose override. */
  purpose?: string;
}

/**
 * Namespace handle — bound to one object type (a "namespace").
 *
 * Construct via {@link RelataClient.namespace}; do not instantiate directly.
 */
export class Namespace {
  readonly #client: RelataClient;
  readonly #search: SearchClient;
  readonly #ingest: IngestClient;
  /** The bound object type. */
  readonly name: string;

  /** @internal Construct via {@link RelataClient.namespace}. */
  constructor(client: RelataClient, name: string) {
    validateNamespaceName(name);
    this.#client = client;
    this.name = name;
    this.#search = SearchClient.fromClient(client);
    this.#ingest = IngestClient.fromClient(client);
  }

  /**
   * Typed ranked search over this namespace — see
   * {@link SearchClient.query} for the full argument reference. Returns an
   * iterable {@link QueryResult}.
   */
  async query<T = Record<string, unknown>>(
    opts: NamespaceQueryOptions = {},
  ): Promise<QueryResult<T>> {
    return this.#search.query<T>({
      from: this.name,
      ...(opts.text !== undefined ? { text: opts.text } : {}),
      ...(opts.matchColumn !== undefined ? { matchColumn: opts.matchColumn } : {}),
      ...(opts.rankBy !== undefined ? { rankBy: opts.rankBy } : {}),
      ...(opts.filters !== undefined ? { filters: opts.filters } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.includeAttributes !== undefined
        ? { includeAttributes: opts.includeAttributes }
        : {}),
      ...(opts.consistency !== undefined ? { consistency: opts.consistency } : {}),
      ...(opts.purpose !== undefined ? { purpose: opts.purpose } : {}),
    });
  }

  /**
   * Schemaless upsert — auto-create the type with inferred fields.
   *
   * POSTs `{object_type, rows, schema?, purpose?}` to `/ingest/auto`
   * (T6, #1988). If the type does not yet exist the server creates it with
   * field types inferred from the rows; the response carries `type_created`
   * and `inferred_schema`. Optional `schema` overrides pin a field's type.
   */
  async write(
    rows: Record<string, unknown>[],
    opts: NamespaceWriteOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.#ingest.ingestAuto(this.name, rows, {
      ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
      ...(opts.purpose !== undefined ? { purpose: opts.purpose } : {}),
    });
  }

  /** Fetch a single row by id, or `null` if not found. */
  async get<T = Record<string, unknown>>(
    objectId: string,
    opts: { purpose?: string } = {},
  ): Promise<T | null> {
    const escaped = String(objectId).replace(/'/g, "''");
    const sql = `SELECT * FROM ${this.name} WHERE id = '${escaped}' LIMIT 1`;
    const result = await this.#client.query<T>(sql, opts.purpose !== undefined ? { purpose: opts.purpose } : undefined);
    return result.rows.length > 0 ? (result.rows[0] ?? null) : null;
  }

  /**
   * Governed bulk retract — bi-temporal tombstone every row in the namespace.
   *
   * Fetches all ids via a governed `SELECT id` then writes `_deleted: true`
   * tombstones through the ingest path. NOT a physical delete — rows remain
   * in the bi-temporal history for audit/provenance but are excluded from
   * subsequent reads. Returns `{deleted: <count>}`.
   */
  async deleteAll(
    opts: { purpose?: string } = {},
  ): Promise<{ deleted: number }> {
    const sql = `SELECT id FROM ${this.name}`;
    const result = await this.#client.query<{ id: unknown }>(
      sql,
      opts.purpose !== undefined ? { purpose: opts.purpose } : undefined,
    );
    const ids = result.rows
      .map((r) => r.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) return { deleted: 0 };
    const tombstones = ids.map((id) => ({ id, _deleted: true }));
    await this.#ingest.ingestAuto(this.name, tombstones, {
      ...(opts.purpose !== undefined ? { purpose: opts.purpose } : {}),
    });
    return { deleted: ids.length };
  }

  /**
   * Create this namespace as a copy-on-write branch of `sourceNamespace`.
   *
   * Targets `POST /v1/namespaces/{name}/branch` (T10, #1992). The
   * server-side door is pending #1992; this client method is ready for it.
   */
  async branchFrom(
    sourceNamespace: string,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    validateNamespaceName(sourceNamespace);
    const body: Record<string, unknown> = { from: sourceNamespace };
    if (opts.purpose !== undefined) body["purpose"] = opts.purpose;
    return this.#client.request<Record<string, unknown>>(
      "POST",
      `/v1/namespaces/${encodeURIComponent(this.name)}/branch`,
      body,
    );
  }
}
