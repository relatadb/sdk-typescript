/**
 * Identity + lookup + GDPR SDK (#79).
 *
 * Wraps `/identity/label`, `/identity/uncertainty`, `/lookup`,
 * `/lookup/register`, plus the `ERASE SUBJECT` SQL command. The
 * `eraseSubject` path goes through `POST /query` because the server exposes
 * it as a SQL statement, not a dedicated HTTP route.
 */

import { RelataClient } from "./client.ts";
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
   * Assign a canonical label to an identity.
   * Wraps `POST /identity/label`.
   */
  async label(
    identity: string,
    label: string,
    opts: { confidence?: number; sourceId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      identity,
      label,
      confidence: opts.confidence ?? 1.0,
    };
    if (opts.sourceId !== undefined) payload["source_id"] = opts.sourceId;
    return this._post("/identity/label", payload);
  }

  /**
   * Record uncertainty about an identity match. The server surfaces these for
   * human review. Wraps `GET /identity/uncertainty`.
   */
  async recordUncertainty(
    identity: string,
    reason: string,
    opts: { suggestedAlternatives?: string[] } = {},
  ): Promise<Record<string, unknown>> {
    const path = `/identity/uncertainty${qs({
      identity,
      reason,
      // `suggested_alternatives` is an array — encode as comma-separated.
      suggested_alternatives: opts.suggestedAlternatives?.join(","),
    })}`;
    return this._get(path);
  }

  // -------------------------------------------------------------------------
  // Lookup tables (#79) — Splunk `lookup` parity
  // -------------------------------------------------------------------------

  /**
   * Register a lookup table (CSV). Matches Splunk's `lookup` semantics.
   * Wraps `POST /lookup/register`.
   */
  async registerLookup(
    name: string,
    csvData: string,
    opts: {
      keyColumn: string;
      valueColumns?: string[];
    },
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      name,
      csv_data: csvData,
      key_column: opts.keyColumn,
    };
    if (opts.valueColumns !== undefined) payload["value_columns"] = opts.valueColumns;
    return this._post("/lookup/register", payload);
  }

  /**
   * List registered lookup tables.
   * Wraps `GET /lookup`.
   */
  async listLookups(): Promise<Record<string, unknown>[]> {
    const data = await this._get<Record<string, unknown>>("/lookup");
    const lookups =
      typeof data === "object" && data !== null && Array.isArray(data["lookups"])
        ? data["lookups"]
        : Array.isArray(data)
          ? data
          : [];
    return lookups as Record<string, unknown>[];
  }

  /**
   * Invoke a registered lookup. Wraps `GET /lookup?name=...&key=...`.
   * Returns the row(s) matching `key`.
   */
  async invokeLookup(
    name: string,
    key: string,
  ): Promise<Record<string, unknown>> {
    const path = `/lookup${qs({ name, key })}`;
    return this._get(path);
  }

  // -------------------------------------------------------------------------
  // ERASE SUBJECT (#79, #61) — SQL path
  // -------------------------------------------------------------------------

  /**
   * Issue `ERASE SUBJECT '<id>' REASON '<r>' [CERTIFY]` via the query path.
   * Returns the server's Art. 17 receipt.
   *
   * Pairs with #61 — today the server does governed-tombstone only (the DEK
   * survives). Once #61 ships the per-subject DEK destroy, this same call
   * will produce crypto-shred semantics.
   */
  async eraseSubject(
    subjectIdentity: string,
    reason: string,
    opts: {
      certify?: boolean;
      purpose: string;
    },
  ): Promise<Record<string, unknown>> {
    const certifyKw = (opts.certify ?? true) ? " CERTIFY" : "";
    const sql =
      `ERASE SUBJECT '${subjectIdentity.replace(/'/g, "''")}' ` +
      `REASON '${reason.replace(/'/g, "''")}'${certifyKw}`;
    return this._post("/query", { purpose: opts.purpose, sql });
  }
}
