/**
 * Retrieval evidence (`relata.evidence/v1`, #5707).
 *
 * Send {@link evidenceHeaders} with a `/query`, `/search`, `/graphql` or MCP
 * read to record version-pinned citations for its result, then fetch the
 * record with {@link EvidenceClient.get} and re-read every citation under the
 * caller's current authorization with {@link EvidenceClient.replay}. Replay
 * verifies recorded citations; it does not recompute ranking.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

/** Headers that record evidence for a read (retention 1 to 365 days, default 30). */
export function evidenceHeaders(opts: { retentionDays?: number } = {}): Record<string, string> {
  const headers: Record<string, string> = { "X-Relata-Record-Evidence": "true" };
  if (opts.retentionDays !== undefined) {
    headers["X-Relata-Evidence-Retention-Days"] = String(Math.trunc(opts.retentionDays));
  }
  return headers;
}

/** Evidence client. */
export class EvidenceClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): EvidenceClient {
    return new EvidenceClient(TypedClientBase.clientToCtor(client));
  }

  /** `GET /evidence`: the caller's unexpired records, newest first. */
  async list(opts: { limit?: number } = {}): Promise<Record<string, unknown>> {
    const q = opts.limit === undefined ? "" : `?limit=${Math.trunc(opts.limit)}`;
    return this._get<Record<string, unknown>>(`/evidence${q}`);
  }

  /** `GET /evidence/{id}`: 404 when unknown, 410 once expired. */
  async get(id: string): Promise<Record<string, unknown>> {
    return this._get<Record<string, unknown>>(`/evidence/${encodeURIComponent(id)}`);
  }

  /** `POST /evidence/{id}/replay`: per-citation verified/hash_mismatch/missing/denied/deleted. */
  async replay(id: string, opts: { includeContent?: boolean } = {}): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = opts.includeContent ? { include_content: true } : {};
    return this._post<Record<string, unknown>>(`/evidence/${encodeURIComponent(id)}/replay`, body);
  }
}
