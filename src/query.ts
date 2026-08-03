/**
 * QueryBuilder — fluent API for constructing and executing Relata SQL queries.
 *
 * ```typescript
 * const results = await relata
 *   .select("Person")
 *   .purpose("analytics")
 *   .where("name LIKE 'Ahmed%'")
 *   .asOf("2025-01-01T00:00:00Z")
 *   .withProvenance()
 *   .orderBy("name")
 *   .limit(20)
 *   .execute<{ id: string; name: string; _prov: unknown }>();
 * ```
 *
 * The builder assembles a SQL string that is valid in Relata's extended SQL
 * dialect. Call `toSQL()` to inspect the generated query without executing it.
 */

import type { RelataClient } from "./client.ts";
import type { QueryResult } from "./types.ts";
import { escapeSqlString, validateIdentifier } from "./_sql.ts";

// ---------------------------------------------------------------------------
// Sort direction
// ---------------------------------------------------------------------------

/** Column sort direction. */
export type SortDirection = "ASC" | "DESC";

// ---------------------------------------------------------------------------
// QueryBuilder
// ---------------------------------------------------------------------------

/**
 * Fluent query builder for the Relata SQL dialect.
 *
 * Obtain an instance via `relataClient.select("TypeName")`.
 * Every method returns `this` (the builder) so calls can be chained.
 * Call `.execute()` or `.toSQL()` to finalise.
 */
export class QueryBuilder {
  readonly #client: RelataClient;
  readonly #fromType: string;

  #purpose: string | undefined;
  #columns: string[] = ["*"];
  #conditions: string[] = [];
  #asOfTimestamp: string | undefined;
  #provenance = false;
  #limitValue: number | undefined;
  #offsetValue: number | undefined;
  #orderByClauses: string[] = [];

  /** @internal Called by RelataClient.select() */
  constructor(client: RelataClient, fromType: string) {
    this.#client = client;
    this.#fromType = fromType;
  }

  // -------------------------------------------------------------------------
  // Column selection
  // -------------------------------------------------------------------------

  /**
   * Specify which columns to return.
   *
   * Passing no arguments resets to `SELECT *` (default).
   *
   * @example
   * ```typescript
   * relata.select("Person").columns("id", "name", "dob")
   * // → SELECT id, name, dob FROM Person
   *
   * relata.select("BankAccount").columns("account_number", "balance_usd")
   * ```
   */
  columns(...cols: string[]): this {
    this.#columns = cols.length > 0 ? cols : ["*"];
    return this;
  }

  // -------------------------------------------------------------------------
  // Purpose
  // -------------------------------------------------------------------------

  /**
   * Set the purpose token for this query.
   *
   * If not called, falls back to `RelataClientOptions.defaultPurpose`.
   * Every query must have a purpose (SPECS §5.22.4).
   *
   * @param purpose - Registered purpose string, e.g. `"analytics"`, `"audit"`.
   *
   * @example
   * ```typescript
   * relata.select("Person").purpose("analytics")
   * ```
   */
  purpose(purpose: string): this {
    this.#purpose = purpose;
    return this;
  }

  // -------------------------------------------------------------------------
  // Filtering
  // -------------------------------------------------------------------------

  /**
   * Append a `WHERE` condition (or additional `AND` condition).
   *
   * Multiple `.where()` calls are joined with `AND`.
   *
   * @param condition - SQL condition fragment (not parameterised — caller is
   *   responsible for sanitising values or using literal constants).
   *
   * @example
   * ```typescript
   * relata.select("Person")
   *   .where("name LIKE 'Ahmed%'")
   *   .where("dob < '1990-01-01'")
   * // → WHERE name LIKE 'Ahmed%' AND dob < '1990-01-01'
   * ```
   */
  where(condition: string): this {
    if (condition.trim()) this.#conditions.push(condition.trim());
    return this;
  }

  // -------------------------------------------------------------------------
  // Bi-temporal
  // -------------------------------------------------------------------------

  /**
   * Add an `AS OF 'timestamp'` clause to query the state of the data at a
   * specific point in time (bi-temporal snapshot, SPECS §5.4).
   *
   * @param timestamp - RFC 3339 timestamp with `Z` suffix, e.g.
   *   `"2025-01-01T00:00:00Z"`. Also accepts `YYYY-MM-DD` (interpreted as
   *   `00:00:00Z` by the server).
   *
   * @example
   * ```typescript
   * relata.select("BankAccount")
   *   .asOf("2024-06-01T00:00:00Z")
   *   .where("organization_id = 'ED-MUM-001'")
   * ```
   */
  asOf(timestamp: string): this {
    this.#asOfTimestamp = timestamp;
    return this;
  }

  // -------------------------------------------------------------------------
  // Provenance
  // -------------------------------------------------------------------------

  /**
   * Append `WITH PROVENANCE` to request PROV-O provenance metadata attached
   * to each row (SPECS §5.11).
   *
   * Provenance columns are prefixed with `_prov_` in the result rows, e.g.:
   * `_prov_source`, `_prov_collector`, `_prov_confidence`, `_prov_observed_at`.
   *
   * @example
   * ```typescript
   * relata.select("PhoneCall")
   *   .purpose("audit")
   *   .withProvenance()
   *   .limit(50)
   * // → SELECT * FROM PhoneCall WITH PROVENANCE LIMIT 50
   * ```
   */
  withProvenance(): this {
    this.#provenance = true;
    return this;
  }

  // -------------------------------------------------------------------------
  // Ordering, limit, offset
  // -------------------------------------------------------------------------

  /**
   * Add an `ORDER BY` clause.
   *
   * Multiple `.orderBy()` calls are applied in call order.
   *
   * @param column - Column name.
   * @param direction - `"ASC"` (default) or `"DESC"`.
   *
   * @example
   * ```typescript
   * relata.select("Transaction")
   *   .orderBy("amount_usd", "DESC")
   *   .orderBy("occurred_at")
   *   .limit(100)
   * ```
   */
  orderBy(column: string, direction: SortDirection = "ASC"): this {
    this.#orderByClauses.push(`${column} ${direction}`);
    return this;
  }

  /**
   * Limit the number of rows returned.
   *
   * @param n - Maximum row count. Must be a positive integer.
   *
   * @example
   * ```typescript
   * relata.select("Person").limit(10)
   * // → SELECT * FROM Person LIMIT 10
   * ```
   */
  limit(n: number): this {
    if (!Number.isInteger(n) || n < 1) {
      throw new RangeError(`limit() requires a positive integer, got ${n}`);
    }
    this.#limitValue = n;
    return this;
  }

  /**
   * Skip the first `n` rows (pagination).
   *
   * @param n - Number of rows to skip. Must be a non-negative integer.
   *
   * @example
   * ```typescript
   * relata.select("AuditEntry")
   *   .orderBy("recorded_at", "DESC")
   *   .limit(25)
   *   .offset(50)
   * ```
   */
  offset(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`offset() requires a non-negative integer, got ${n}`);
    }
    this.#offsetValue = n;
    return this;
  }

  // -------------------------------------------------------------------------
  // Graph operators (convenience wrappers)
  // -------------------------------------------------------------------------

  /**
   * Produce a `PATHS_BETWEEN(source, target, max_hops => N)` query fragment.
   *
   * Replaces the `FROM` clause; `.where()`, `.limit()`, etc. still apply.
   *
   * @param sourceId - Starting node identity (UUID or canonical identifier).
   * @param targetId - Target node identity.
   * @param maxHops - Maximum graph hops (default `4`; server cap in ADR-059).
   *
   * @example
   * ```typescript
   * const paths = await relata
   *   .pathsBetween("person-001", "org-042", { maxHops: 3 })
   *   .purpose("analytics")
   *   .limit(100)
   *   .execute();
   * ```
   */
  pathsBetween(
    sourceId: string,
    targetId: string,
    options: { maxHops?: number } = {},
  ): PathsQueryBuilder {
    return new PathsQueryBuilder(
      this.#client,
      sourceId,
      targetId,
      options.maxHops ?? 4,
      this.#purpose,
    );
  }

  // -------------------------------------------------------------------------
  // Finalise
  // -------------------------------------------------------------------------

  /**
   * Materialise the SQL string that would be executed by `.execute()`.
   *
   * Useful for debugging, logging, or sending the query through a different
   * transport (e.g. MCP server).
   *
   * @example
   * ```typescript
   * const sql = relata
   *   .select("Person")
   *   .where("name LIKE 'Ali%'")
   *   .limit(10)
   *   .toSQL();
   * console.log(sql);
   * // → SELECT * FROM Person WHERE name LIKE 'Ali%' LIMIT 10
   * ```
   */
  toSQL(): string {
    validateIdentifier(this.#fromType, "object_type");
    const parts: string[] = [];

    // SELECT
    parts.push(`SELECT ${this.#columns.join(", ")}`);

    // FROM
    parts.push(`FROM ${this.#fromType}`);

    // AS OF — the timestamp is escaped into a contained literal (#3211).
    if (this.#asOfTimestamp) {
      parts.push(`AS OF '${escapeSqlString(this.#asOfTimestamp)}'`);
    }

    // WITH PROVENANCE
    if (this.#provenance) {
      parts.push("WITH PROVENANCE");
    }

    // WHERE
    if (this.#conditions.length > 0) {
      parts.push(`WHERE ${this.#conditions.join(" AND ")}`);
    }

    // ORDER BY
    if (this.#orderByClauses.length > 0) {
      parts.push(`ORDER BY ${this.#orderByClauses.join(", ")}`);
    }

    // LIMIT / OFFSET
    if (this.#limitValue !== undefined) {
      parts.push(`LIMIT ${this.#limitValue}`);
    }
    if (this.#offsetValue !== undefined) {
      parts.push(`OFFSET ${this.#offsetValue}`);
    }

    return parts.join(" ");
  }

  /**
   * Execute the query and return typed results.
   *
   * @typeParam T - Row shape. Defaults to `Record<string, unknown>`.
   *
   * @throws {PurposeError} No purpose declared.
   * @throws {AuthError} Bearer token missing or invalid.
   * @throws {QuotaError} Query cost quota exhausted.
   * @throws {BadRequestError} SQL syntax error.
   * @throws {NetworkError} Server unreachable.
   * @throws {TimeoutError} Request timed out.
   *
   * @example
   * ```typescript
   * interface Person { id: string; name: string }
   * const r = await relata
   *   .select("Person")
   *   .purpose("analytics")
   *   .limit(10)
   *   .execute<Person>();
   * r.rows[0]?.name; // string | undefined
   * ```
   */
  async execute<T = Record<string, unknown>>(): Promise<QueryResult<T>> {
    const opts: { purpose?: string } = {};
    if (this.#purpose !== undefined) opts.purpose = this.#purpose;
    return this.#client.query<T>(this.toSQL(), opts);
  }
}

// ---------------------------------------------------------------------------
// PathsQueryBuilder — specialised builder for PATHS_BETWEEN
// ---------------------------------------------------------------------------

/**
 * Fluent builder for `PATHS_BETWEEN` graph traversal queries.
 *
 * Returned by `QueryBuilder.pathsBetween()` or `relata.select().pathsBetween()`.
 */
export class PathsQueryBuilder {
  readonly #client: RelataClient;
  readonly #sourceId: string;
  readonly #targetId: string;
  readonly #maxHops: number;

  #purpose: string | undefined;
  #limitValue: number | undefined;
  #provenance = false;
  #asOfTimestamp: string | undefined;

  /** @internal */
  constructor(
    client: RelataClient,
    sourceId: string,
    targetId: string,
    maxHops: number,
    purpose: string | undefined,
  ) {
    this.#client = client;
    this.#sourceId = sourceId;
    this.#targetId = targetId;
    this.#maxHops = maxHops;
    this.#purpose = purpose;
  }

  /** Set the query purpose. */
  purpose(purpose: string): this {
    this.#purpose = purpose;
    return this;
  }

  /** Limit the number of paths returned. */
  limit(n: number): this {
    this.#limitValue = n;
    return this;
  }

  /** Request PROV-O provenance on each path edge. */
  withProvenance(): this {
    this.#provenance = true;
    return this;
  }

  /** Bi-temporal snapshot for the path query. */
  asOf(timestamp: string): this {
    this.#asOfTimestamp = timestamp;
    return this;
  }

  /** Return the SQL string for inspection. */
  toSQL(): string {
    const parts: string[] = [];

    // #3211: the node ids are escaped into contained literals.
    parts.push(`SELECT * FROM PATHS_BETWEEN(`);
    parts.push(`  '${escapeSqlString(this.#sourceId)}',`);
    parts.push(`  '${escapeSqlString(this.#targetId)}',`);
    parts.push(`  max_hops => ${this.#maxHops}`);
    parts.push(`)`);

    if (this.#asOfTimestamp) {
      parts.push(`AS OF '${escapeSqlString(this.#asOfTimestamp)}'`);
    }
    if (this.#provenance) {
      parts.push("WITH PROVENANCE");
    }
    if (this.#limitValue !== undefined) {
      parts.push(`LIMIT ${this.#limitValue}`);
    }

    return parts.join(" ");
  }

  /** Execute the `PATHS_BETWEEN` query. */
  async execute<T = Record<string, unknown>>(): Promise<QueryResult<T>> {
    const opts: { purpose?: string } = {};
    if (this.#purpose !== undefined) opts.purpose = this.#purpose;
    return this.#client.query<T>(this.toSQL(), opts);
  }
}
