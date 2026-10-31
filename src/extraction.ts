/**
 * Ontology extraction suggestions and the ETL existence lookup (#5678).
 *
 * OpenETL extracts entities, relationships and schema proposals; Relata stores
 * them. `submit` a bounded batch (every suggestion starts `pending`; a
 * submission cannot carry a review state), work the review queue with `list` /
 * `get`, and `accept` / `reject` / `correct` / `reopen` each one. The original
 * payload is always kept beside the correction and every decision. Accepted
 * schema suggestions (`object`, `property`, `link`) fold into a definition
 * draft with `apply`, to be published as the next ontology version.
 * `entitiesExist` answers, for up to 500 candidates, which already exist and
 * with which ids. Every ontology read returns an `ontology_version` token; pass
 * it back on a suggestion and the queue marks it `stale` once the ontology has
 * moved on.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

type Doc = Record<string, unknown>;

const seg = (s: string | number): string => encodeURIComponent(String(s));

/** Extraction suggestions client. */
export class ExtractionClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): ExtractionClient {
    return new ExtractionClient(TypedClientBase.clientToCtor(client));
  }

  /** `POST /v1/ontology/suggestions`: store 1 to 200 suggestions; each result is created, existing or invalid. */
  async submit(suggestions: Doc[]): Promise<Doc> {
    return this._post<Doc>("/v1/ontology/suggestions", { suggestions });
  }

  /** `GET /v1/ontology/suggestions`: the review queue, oldest first. */
  async list(
    opts: {
      state?: "pending" | "accepted" | "rejected" | "corrected";
      kind?: string;
      definition?: string;
      lowConfidence?: boolean;
      stale?: boolean;
      minConfidence?: number;
      limit?: number;
    } = {},
  ): Promise<Doc> {
    const q = new URLSearchParams();
    if (opts.state !== undefined) q.set("state", opts.state);
    if (opts.kind !== undefined) q.set("kind", opts.kind);
    if (opts.definition !== undefined) q.set("definition", opts.definition);
    if (opts.lowConfidence !== undefined) q.set("low_confidence", String(opts.lowConfidence));
    if (opts.stale !== undefined) q.set("stale", String(opts.stale));
    if (opts.minConfidence !== undefined) q.set("min_confidence", String(opts.minConfidence));
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this._get<Doc>(`/v1/ontology/suggestions${qs ? `?${qs}` : ""}`);
  }

  /** `GET /v1/ontology/suggestions/{id}`: with its correction and decision history. */
  async get(suggestionId: string): Promise<Doc> {
    return this._get<Doc>(`/v1/ontology/suggestions/${seg(suggestionId)}`);
  }

  /** `POST .../decision` with `accept`, `reject`, `correct` or `reopen`; idempotent. */
  async decide(
    suggestionId: string,
    decision: "accept" | "reject" | "correct" | "reopen",
    reason = "",
    opts: { correction?: Doc; acceptLowConfidence?: boolean } = {},
  ): Promise<Doc> {
    const body: Doc = { decision, reason };
    if (opts.correction !== undefined) body.correction = opts.correction;
    if (opts.acceptLowConfidence) body.accept_low_confidence = true;
    return this._post<Doc>(`/v1/ontology/suggestions/${seg(suggestionId)}/decision`, body);
  }

  /** Accept a suggestion as extracted. */
  async accept(suggestionId: string, reason = "", opts: { acceptLowConfidence?: boolean } = {}): Promise<Doc> {
    return this.decide(suggestionId, "accept", reason, opts);
  }

  /** Reject a suggestion; a reprocessed run of the same claim inherits this. */
  async reject(suggestionId: string, reason: string): Promise<Doc> {
    return this.decide(suggestionId, "reject", reason);
  }

  /** Amend a suggestion's payload; the original is kept. */
  async correct(suggestionId: string, correction: Doc, reason: string): Promise<Doc> {
    return this.decide(suggestionId, "correct", reason, { correction });
  }

  /** Return a decided suggestion to `pending`. */
  async reopen(suggestionId: string, reason = ""): Promise<Doc> {
    return this.decide(suggestionId, "reopen", reason);
  }

  /** `POST /v1/ontology/suggestions/apply`: fold accepted schema suggestions into the definition's draft. */
  async apply(definition: string, opts: { suggestionIds?: string[] } = {}): Promise<Doc> {
    const body: Doc = { definition };
    if (opts.suggestionIds !== undefined) body.suggestion_ids = opts.suggestionIds;
    return this._post<Doc>("/v1/ontology/suggestions/apply", body);
  }

  /**
   * `POST /v1/entities/exists`: for up to 500 `{type, match: {field: value}}` candidates,
   * whether a live record matches exactly and with which ids.
   */
  async entitiesExist(candidates: Doc[], opts: { definition?: string } = {}): Promise<Doc> {
    const body: Doc = { candidates };
    if (opts.definition !== undefined) body.definition = opts.definition;
    return this._post<Doc>("/v1/entities/exists", body);
  }
}
