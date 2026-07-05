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
