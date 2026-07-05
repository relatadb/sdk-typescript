/**
 * Type definitions for the Relata JSON Query IR (v1).
 *
 * See `docs/api/query-ir.md` for the full schema. These types describe the
 * exact shape emitted by the typed builders in `./builder.ts`.
 *
 * @module
 */

/** Current IR schema version. */
export type IRVersion = "v1";

/** Supported filter operators in IR keyword form. */
export type WhereOp =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "in";

/** Scalar or scalar-array value accepted in a where clause. */
export type WhereValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<string | number | boolean | null>;

/** A single AND-conjoined filter clause. */
export interface WhereClause {
  col: string;
  op: WhereOp;
  val: WhereValue;
}

/** `kind: "select"` IR document. */
export interface SelectIR {
  relata_query_ir: IRVersion;
  kind: "select";
  purpose: string;
  from: string;
  select?: string[];
  where?: WhereClause[];
  limit?: number;
}

/** `kind: "paths_between"` IR document. */
export interface PathsBetweenIR {
  relata_query_ir: IRVersion;
  kind: "paths_between";
  purpose: string;
  from_id: string;
  to_id: string;
  max_hops?: number;
}

/** `kind: "lookup_identity"` IR document. */
export interface LookupIdentityIR {
  relata_query_ir: IRVersion;
  kind: "lookup_identity";
  purpose: string;
  value: string;
  kind_hint?: string;
}

/** `kind: "hybrid_search"` IR document. */
export interface HybridSearchIR {
  relata_query_ir: IRVersion;
  kind: "hybrid_search";
  purpose: string;
  from: string;
  query: string;
  top_k?: number;
  alpha?: number;
}

/** Discriminated union over all supported IR documents. */
export type QueryIR =
  | SelectIR
  | PathsBetweenIR
  | LookupIdentityIR
  | HybridSearchIR;
