/**
 * Identity + lookup + GDPR SDK (#79).
 *
 * Wraps `/v1/identity/label`, `/v1/identity/uncertainty`, `/v1/lookup`,
 * `/v1/lookup/register`, plus the `ERASE SUBJECT` SQL command. The
 * `eraseSubject` path goes through `POST /v1/query` because the server exposes
 * it as a SQL statement, not a dedicated HTTP route.
 */

import { RelataClient } from "./client.ts";
import { escapeSqlString } from "./_sql.ts";
import { type TypedClientCtor, TypedClientBase, qs } from "./_typed-http.ts";

/** Identity + lookup client. */
export class IdentityClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): IdentityClient {
    return new IdentityClient(TypedClientBase.clientToCtor(client));
  }

  // -------------------------------------------------------------------------
  // Identity (#79)
  // -------------------------------------------------------------------------

  /**
   * Record a human label on a candidate identity pair: `isMatch` says whether
   * `left` and `right` refer to the same entity. The server takes one learning
   * step on the caller's tenant resolver weights and persists the history.
   * Wraps `POST /v1/identity/label` with `{left, right, is_match}`.
   */
  async label(
    left: string,
    right: string,
    isMatch = true,
  ): Promise<Record<string, unknown>> {
    return this._post("/v1/identity/label", { left, right, is_match: isMatch });
  }

  /**
   * Record uncertainty about an identity match. The server surfaces these for
   * human review. Wraps `GET /v1/identity/uncertainty`.
   */
  async recordUncertainty(
    identity: string,
    reason: string,
    opts: { suggestedAlternatives?: string[]; k?: number; candidates?: string[] } = {},
  ): Promise<Record<string, unknown>> {
    // The server ranks `candidates` (`a|b` pairs, comma separated) and returns
    // the top `k` most uncertain; `identity`/`reason` are sent for audit only.
    const path = `/v1/identity/uncertainty${qs({
      identity,
      reason,
      suggested_alternatives: opts.suggestedAlternatives?.join(","),
      candidates: opts.candidates?.join(","),
      k: opts.k,
    })}`;
    return this._get(path);
  }

  // -------------------------------------------------------------------------
  // Lookup tables (#79) — Splunk `lookup` parity
  // -------------------------------------------------------------------------

  /**
   * Register a lookup table from a CSV file that already exists ON THE SERVER,
   * under `<data dir>/lookups` (files elsewhere, or over 16 MiB, are refused).
   * Wraps `POST /v1/lookup/register` with a `text/plain`
   * `REGISTER LOOKUP <name> FROM '<path>' KEY (<col>) FIELDS (<cols>)`
   * statement -- the only body the server accepts; it cannot receive CSV text.
   * Returns `{registered, rows}`.
   */
  async registerLookup(
    name: string,
    serverPath: string,
    opts: {
      keyColumn: string;
      valueColumns?: string[];
    },
  ): Promise<Record<string, unknown>> {
    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const cols = [opts.keyColumn, ...(opts.valueColumns ?? [])];
    if (!ident.test(name) || !cols.every((c) => ident.test(c))) {
      throw new TypeError("registerLookup: name and column names must be identifiers ([A-Za-z_][A-Za-z0-9_]*)");
    }
    if (serverPath === "" || /['\r\n]/.test(serverPath)) {
      throw new TypeError("registerLookup: serverPath must be a non-empty path without quotes or newlines");
    }
    const fields = opts.valueColumns !== undefined && opts.valueColumns.length > 0
      ? ` FIELDS (${opts.valueColumns.join(", ")})`
      : "";
    const statement = `REGISTER LOOKUP ${name} FROM '${serverPath}' KEY (${opts.keyColumn})${fields}`;
    return this._sendRaw("POST", "/v1/lookup/register", statement, "text/plain");
  }

  /**
   * List registered lookup tables. Wraps `GET /v1/lookup`, whose body is
   * `{"lookup_tables": ["name", ...]}`; each name is returned as `{ name }`.
   */
  async listLookups(): Promise<Record<string, unknown>[]> {
    const data = await this._get<Record<string, unknown>>("/v1/lookup");
    const names = typeof data === "object" && data !== null && Array.isArray(data["lookup_tables"])
      ? (data["lookup_tables"] as unknown[])
      : [];
    return names.map((n) => ({ name: n }));
  }

  /**
   * Wraps `GET /v1/lookup?name=...&key=...`. NOTE: the server has no key-lookup
   * route (lookup tables are consumed by ingest-time enrichment only), so the
   * response is the registered-table listing `{lookup_tables: [...]}` and
   * `name`/`key` are ignored.
   */
  async invokeLookup(
    name: string,
    key: string,
  ): Promise<Record<string, unknown>> {
    const path = `/v1/lookup${qs({ name, key })}`;
    return this._get(path);
  }

  // -------------------------------------------------------------------------
  // ERASE SUBJECT (#79, #61) — SQL path
  // -------------------------------------------------------------------------

  /**
   * Issue `ERASE SUBJECT '<id>' REASON '<r>' [CERTIFY]` via the query path.
   * Returns the server's Art. 17 receipt.
   *
   * `certify` is destructive **opt-in**: omitted or `false` omits the CERTIFY
   * keyword, and the server refuses the erasure with
   * "CERTIFY keyword required to confirm irreversible erasure" — matching the
   * engine's own safety rail. Only an explicit `certify: true` confirms the
   * erasure request with explicit incomplete local receipts. (Historically the omitted default was `true`,
   * which silently confirmed destruction for callers that never considered
   * the flag.)
   *
   * Pairs with #61 — today the server does governed-tombstone only (the DEK
   * survives). Once #61 ships the per-subject DEK destroy, this same call
   * must be inspected for actual local acknowledgments; provider/all-copy completion remains unverified.
   */
  async eraseSubject(
    subjectIdentity: string,
    reason: string,
    opts: {
      certify?: boolean;
      purpose: string;
    },
  ): Promise<Record<string, unknown>> {
    const certifyKw = opts.certify === true ? " CERTIFY" : "";
    const sql =
      `ERASE SUBJECT '${escapeSqlString(subjectIdentity)}' ` +
      `REASON '${escapeSqlString(reason)}'${certifyKw}`;
    return this._post("/v1/query", { purpose: opts.purpose, sql });
  }
}
