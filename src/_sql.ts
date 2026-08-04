/**
 * @internal Shared SQL-building guards (#3211).
 *
 * Underscore-prefixed infra module (not a domain module) so every SQL-building
 * surface — `client.ts`, `vectors.ts`, `query.ts`, `identity.ts` — can share
 * one identifier allowlist, one metric allowlist, and one string-literal
 * escaper without introducing a runtime circular import through `client.ts`.
 */

import { ValidationError } from "./errors.ts";
import type { Matcher } from "./types.ts";

/** Identifier allowlist for SQL interpolation (#3211). */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reject anything that is not a bare SQL identifier (#3211). Used for values
 * interpolated into identifier positions (`object_type`, `embedding_slot`,
 * `FROM` clauses) where escaping cannot protect them.
 */
export function validateIdentifier(name: string, what: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new ValidationError(
      `invalid ${what} ${JSON.stringify(name)}: must match ^[A-Za-z_][A-Za-z0-9_]*$`,
    );
  }
}

/** Closed set of distance metrics the server's vector channel accepts (#3211). */
const METRIC_ALLOWLIST = new Set(["cosine", "l2", "dotproduct"]);

/** Confine `metric` to the server's known distance-metric set (#3211). */
export function validateMetric(metric: string): void {
  if (!METRIC_ALLOWLIST.has(metric)) {
    throw new ValidationError(
      `invalid metric ${JSON.stringify(metric)}: must be one of cosine, l2, dotproduct`,
    );
  }
}

/**
 * Escape a caller-supplied value for interpolation into a SQL string literal
 * (#3211). The server lexer (`relata_query::parser`) terminates a literal at
 * the first unescaped quote and honours backslash escapes, so both `\` and `'`
 * are backslash-escaped — the old `'`→`''` doubling neither contained a quote
 * correctly nor blocked a `\'` breakout.
 */
export function escapeSqlString(s: string): string {
  return s.replace(/[\\']/g, (ch) => `\\${ch}`);
}

/** Quote a string as a SQL string literal, escaping `\` and `'` (#3211). */
export function sqlLiteral(s: string): string {
  return `'${escapeSqlString(s)}'`;
}

/**
 * Prefix `sql` with a `/*+ matcher=…` hint comment selecting the subgraph
 * matcher for multi-hop Cypher patterns (#1189). `undefined` and `"auto"`
 * return `sql` unchanged so the server's default selection applies; `"vf3"`
 * forces the VF3 subgraph-isomorphism matcher and `"bfs"` the chained-BFS
 * fallback. Any other value is rejected client-side.
 */
export function injectMatcherHint(sql: string, matcher?: Matcher): string {
  if (matcher === undefined || matcher === "auto") return sql;
  if (matcher !== "vf3" && matcher !== "bfs") {
    throw new ValidationError(
      `invalid matcher ${JSON.stringify(matcher)}: must be one of auto, vf3, bfs`,
    );
  }
  return `/*+ matcher=${matcher} */ ${sql}`;
}
