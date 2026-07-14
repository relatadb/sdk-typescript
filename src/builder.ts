/**
 * Typed query builder for the Relata JSON IR (v1).
 *
 * Produces JSON documents matching the schema documented in
 * `docs/api/query-ir.md`. The same logical query produced by this builder
 * and the Rust `relata_sdk_rust::builder` serialises to identical JSON.
 *
 * ```ts
 * import { query, pathsBetween, lookupIdentity } from "@relata/sdk/builder";
 *
 * const ir = query()
 *   .purpose("analytics")
 *   .from("Person")
 *   .select("id", "name")
 *   .where("age", ">", 30)
 *   .limit(10)
 *   .build();
 * ```
 *
 * @module
 */

import type {
  HybridSearchIR,
  LookupIdentityIR,
  PathsBetweenIR,
  QueryIR,
  SelectIR,
  WhereClause,
  WhereOp,
  WhereValue,
} from "./ir-types.ts";

/** Current IR schema version. */
export const IR_VERSION = "v1" as const;

/** Operators accepted by the fluent `.where(col, op, val)` method. */
export type WhereOpInput =
  | "="
  | "!="
  | "<>"
  | ">"
  | ">="
  | "<"
  | "<="
  | "like"
  | "in"
  | WhereOp;

const OP_MAP: Record<string, WhereOp> = {
  "=": "eq",
  "!=": "ne",
  "<>": "ne",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
  like: "like",
  in: "in",
  eq: "eq",
  ne: "ne",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
};

function normaliseOp(op: WhereOpInput): WhereOp {
  const mapped = OP_MAP[op];
  if (!mapped) {
    throw new Error(`Unknown where operator: ${op}`);
  }
  return mapped;
}

/**
 * Fluent builder for a `kind: "select"` IR document.
 *
 * Construct with {@link query} (or `new QueryBuilder()`), chain configuration
 * methods, then call {@link QueryBuilder.build} to obtain the JSON payload.
 *
 * Every query MUST declare a `purpose` via {@link QueryBuilder.purpose}.
 */
export class QueryBuilder {
  #purpose: string | undefined;
  #from: string | undefined;
  #select: string[] = [];
  #where: WhereClause[] = [];
  #limit: number | undefined;
  #asOf: string | undefined;
  #withProvenance = false;

  /** Declare the query purpose (required). */
  purpose(p: string): this {
    this.#purpose = p;
    return this;
  }

  /** Set the source object type (required). */
  from(objectType: string): this {
    this.#from = objectType;
    return this;
  }

  /**
   * Project the given columns. Replaces any previous selection. If never
   * called, the IR omits the `select` field — the server returns all columns.
   */
  select(...columns: string[]): this {
    this.#select = [...columns];
    return this;
  }

  /**
   * Add a filter clause. Multiple calls are AND-conjoined.
   *
   * Operators accept either the symbolic form (`=`, `>`, `<=`, `!=`, `<>`)
   * or the IR keyword form (`eq`, `gt`, `lte`, `ne`, `like`, `in`).
   */
  where(col: string, op: WhereOpInput, val: WhereValue): this {
    this.#where.push({ col, op: normaliseOp(op), val });
    return this;
  }

  /** Set the row limit. */
  limit(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`limit must be a non-negative integer, got ${n}`);
    }
    this.#limit = n;
    return this;
  }

  /**
   * Bi-temporal point-in-time query: appends `AS OF '<ts>'` so the result
   * reflects the data as it was at `timestamp`.
   */
  asOf(timestamp: string): this {
    this.#asOf = timestamp;
    return this;
  }

  /** Append `WITH PROVENANCE` so each row carries its PROV-O derivation chain. */
  withProvenance(): this {
    this.#withProvenance = true;
    return this;
  }

  /** Serialise the builder state to the IR JSON document. */
  build(): SelectIR {
    if (this.#from === undefined) {
      throw new Error("QueryBuilder.build called without from()");
    }
    if (this.#purpose === undefined) {
      throw new Error("QueryBuilder.build called without purpose()");
    }

    const ir: SelectIR = {
      relata_query_ir: IR_VERSION,
      kind: "select",
      purpose: this.#purpose,
      from: this.#from,
    };

    if (this.#select.length > 0) {
      ir.select = [...this.#select];
    }
    if (this.#where.length > 0) {
      ir.where = [...this.#where];
    }
    if (this.#limit !== undefined) {
      ir.limit = this.#limit;
    }
    if (this.#asOf !== undefined) {
      ir.as_of = this.#asOf;
    }
    if (this.#withProvenance) {
      ir.with_provenance = true;
    }
    return ir;
  }
}

/** Start a new SELECT-kind {@link QueryBuilder}. */
export function query(): QueryBuilder {
  return new QueryBuilder();
}

/** Build a `kind: "paths_between"` IR document. */
export function pathsBetween(params: {
  purpose: string;
  fromId: string;
  toId: string;
  maxHops?: number;
}): PathsBetweenIR {
  const ir: PathsBetweenIR = {
    relata_query_ir: IR_VERSION,
    kind: "paths_between",
    purpose: params.purpose,
    from_id: params.fromId,
    to_id: params.toId,
  };
  if (params.maxHops !== undefined) {
    ir.max_hops = params.maxHops;
  }
  return ir;
}

/** Build a `kind: "lookup_identity"` IR document. */
export function lookupIdentity(params: {
  purpose: string;
  value: string;
  kindHint?: string;
}): LookupIdentityIR {
  const ir: LookupIdentityIR = {
    relata_query_ir: IR_VERSION,
    kind: "lookup_identity",
    purpose: params.purpose,
    value: params.value,
  };
  if (params.kindHint !== undefined) {
    ir.kind_hint = params.kindHint;
  }
  return ir;
}

/** Build a `kind: "hybrid_search"` IR document. */
export function hybridSearch(params: {
  purpose: string;
  from: string;
  query: string;
  topK?: number;
  alpha?: number;
}): HybridSearchIR {
  const ir: HybridSearchIR = {
    relata_query_ir: IR_VERSION,
    kind: "hybrid_search",
    purpose: params.purpose,
    from: params.from,
    query: params.query,
  };
  if (params.topK !== undefined) {
    ir.top_k = params.topK;
  }
  if (params.alpha !== undefined) {
    ir.alpha = params.alpha;
  }
  return ir;
}

// ── Graph traversal DSL (Phase 3) ────────────────────────────────────────────

/**
 * Fluent graph-traversal builder. Unlike the `pathsBetween()` function, this
 * class lets you compose link-type filters, max/min hops, and temporal
 * constraints incrementally.
 *
 * ```ts
 * import { graph } from "@relata/sdk/builder";
 *
 * const ir = graph("investigation")
 *   .from("alice@acme.com")
 *   .to("bob@acme.com")
 *   .maxHops(3)
 *   .withLinkType("knows")
 *   .build();
 * ```
 */
export class GraphTraversal {
  #purpose: string | undefined;
  #fromId: string | undefined;
  #toId: string | undefined;
  #maxHops: number | undefined;
  #minHops: number | undefined;
  #linkType: string | undefined;
  #asOf: string | undefined;

  /** Declare the query purpose (required). */
  purpose(p: string): this {
    this.#purpose = p;
    return this;
  }

  /** Source entity (identity value or object id). */
  from(id: string): this {
    this.#fromId = id;
    return this;
  }

  /** Destination entity. */
  to(id: string): this {
    this.#toId = id;
    return this;
  }

  /** Maximum path length (hops). */
  maxHops(n: number): this {
    this.#maxHops = n;
    return this;
  }

  /** Minimum path length — use `minHops(2)` to exclude direct edges. */
  minHops(n: number): this {
    this.#minHops = n;
    return this;
  }

  /** Restrict traversal to a specific link type. */
  withLinkType(linkType: string): this {
    this.#linkType = linkType;
    return this;
  }

  /** Bi-temporal constraint — only traverse edges valid at `timestamp`. */
  asOf(timestamp: string): this {
    this.#asOf = timestamp;
    return this;
  }

  /** Serialise to the canonical IR JSON document. */
  build(): PathsBetweenIR {
    if (this.#fromId === undefined || this.#toId === undefined || this.#purpose === undefined) {
      throw new Error("GraphTraversal.build requires purpose(), from(), and to()");
    }
    const ir: PathsBetweenIR = {
      relata_query_ir: IR_VERSION,
      kind: "paths_between",
      purpose: this.#purpose,
      from_id: this.#fromId,
      to_id: this.#toId,
    };
    if (this.#maxHops !== undefined) ir.max_hops = this.#maxHops;
    if (this.#minHops !== undefined) ir.min_hops = this.#minHops;
    if (this.#linkType !== undefined) ir.link_type = this.#linkType;
    if (this.#asOf !== undefined) ir.as_of = this.#asOf;
    return ir;
  }
}

/** Start a new {@link GraphTraversal} builder with the given purpose. */
export function graph(purpose: string): GraphTraversal {
  return new GraphTraversal().purpose(purpose);
}

export type {
  HybridSearchIR,
  LookupIdentityIR,
  PathsBetweenIR,
  QueryIR,
  SelectIR,
  WhereClause,
  WhereOp,
  WhereValue,
};
