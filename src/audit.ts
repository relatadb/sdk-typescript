/**
 * Audit + provenance SDK (#78).
 *
 * Wraps `/audit/count`, `/audit/entries`, `/report/sign`, `/report/pdf`.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase, qs } from "./_typed-http.ts";

/**
 * Audit + provenance client — entry listing, signed receipts, PDF export.
 */
export class AuditClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): AuditClient {
    return new AuditClient(TypedClientBase.clientToCtor(client));
  }

  // -------------------------------------------------------------------------
  // Audit entries (#78)
  // -------------------------------------------------------------------------

  /**
   * Total audit-entry count + chain integrity flag.
   * Wraps `GET /audit/count`.
   */
  async count(): Promise<Record<string, unknown>> {
    return this._get("/audit/count");
  }

  /**
   * Paginated audit-entry listing with filters.
   * Wraps `GET /audit/entries`. Returns
   * `{"entries": [...], "next_cursor"?: string, "chain_valid": bool}`.
   */
  async entries(
    opts: {
      principal?: string;
      purpose?: string;
      decision?: string;
      requestId?: string;
      sinceNs?: number;
      untilNs?: number;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const path = `/audit/entries${qs({
      principal: opts.principal,
      purpose: opts.purpose,
      decision: opts.decision,
      request_id: opts.requestId,
      since_ns: opts.sinceNs,
      until_ns: opts.untilNs,
      limit: opts.limit ?? 100,
      cursor: opts.cursor,
    })}`;
    return this._get(path);
  }

  /**
   * Look up a single audit entry by its `request_id`. Returns `null` when
   * no entry matches (the server returns an empty page).
   */
  async findByRequestId(
    requestId: string,
  ): Promise<Record<string, unknown> | null> {
    const page = await this.entries({ requestId, limit: 1 });
    const entries =
      typeof page === "object" && page !== null && Array.isArray(page["entries"])
        ? page["entries"]
        : undefined;
    if (Array.isArray(entries) && entries.length > 0) {
      const first = entries[0];
      return typeof first === "object" && first !== null
        ? (first as Record<string, unknown>)
        : null;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Reports (#78)
  // -------------------------------------------------------------------------

  /**
   * Sign an Art. 17 / evidence receipt. Wraps `POST /report/sign`. Returns
   * the signed receipt with the server's HMAC signature.
   */
  async signReceipt(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._post("/report/sign", payload);
  }

  /**
   * Export a court-grade PDF report for `caseId`.
   * Wraps `POST /report/pdf`. Returns the raw PDF bytes; write to disk with
   * `fs.writeFile("case.pdf", bytes)` or stream to the client.
   *
   * Note: the server returns styled HTML by default (printable); the PDF
   * rendering is via the host browser's print-to-pdf. The SDK surfaces
   * whatever bytes the server returns.
   *
   * @returns The response body as raw bytes (`Uint8Array`).
   */
  async exportPdf(
    caseId: string,
    opts: { template?: string } = {},
  ): Promise<Uint8Array> {
    // The base class routes this through its raw-bytes path so we still get
    // auth, X-Request-ID, and typed-error classification for free.
    const payload: Record<string, unknown> = {
      case_id: caseId,
      template: opts.template ?? "default",
    };
    return this._sendJsonExpectBytes("/report/pdf", payload);
  }
}

// Note: the audit client routes everything through the typed-client base,
// which now (#2731) inherits the parent RelataClient's timeout/retry
// behaviour and classifies non-2xx responses via mapHttpError() — so a
// failed `exportPdf` throws the same typed hierarchy (`AuthError`,
// `NotFoundError`, `ServerError`, ...) as the rest of the SDK, not a generic
// `TypedHttpError`. `NetworkError`/`TimeoutError` and the typed error
// classes are exported from the index barrel for callers who want to catch
// them around `exportPdf`.
