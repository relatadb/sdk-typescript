/**
 * Temporal assertions: claims with valid time, recorded time and reviewed
 * corrections (#5713).
 *
 * `record` a claim about a subject record (contradictory claims are all kept),
 * `confirm`/`reject` it as a reviewer, correct it by recording a new claim with
 * `supersedes`, and `revoke` it. `resolve` answers what is true for a predicate
 * at a valid time `validAt` as known at `recordedAsOf` (both integer
 * nanoseconds), with the verdict and reason for every assertion considered.
 * Policies are published under an `expectedVersion` precondition (412
 * `assertion-version-conflict`). A revoke while a legal hold or WORM retention
 * covers the subject gets 409 `assertion-retention-blocked`.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

type Doc = Record<string, unknown>;

const seg = (s: string | number): string => encodeURIComponent(String(s));

/** Assertions client. */
export class AssertionsClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): AssertionsClient {
    return new AssertionsClient(TypedClientBase.clientToCtor(client));
  }

  /** `POST /assertions`: record a claim; idempotent on claim, source version and derivation. */
  async record(assertion: Doc): Promise<Doc> {
    return this._post<Doc>("/assertions", assertion);
  }

  /** `GET /assertions`. */
  async list(
    opts: { subjectType?: string; subjectId?: string; predicate?: string; state?: string; limit?: number } = {},
  ): Promise<Doc> {
    const q = new URLSearchParams();
    if (opts.subjectType !== undefined) q.set("subject_type", opts.subjectType);
    if (opts.subjectId !== undefined) q.set("subject_id", opts.subjectId);
    if (opts.predicate !== undefined) q.set("predicate", opts.predicate);
    if (opts.state !== undefined) q.set("state", opts.state);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this._get<Doc>(`/assertions${qs ? `?${qs}` : ""}`);
  }

  /** `GET /assertions/{id}`. */
  async get(assertionId: string): Promise<Doc> {
    return this._get<Doc>(`/assertions/${seg(assertionId)}`);
  }

  /** `POST .../decision` with `confirm` or `reject`; idempotent. */
  async decide(assertionId: string, decision: "confirm" | "reject", reason: string): Promise<Doc> {
    return this._post<Doc>(`/assertions/${seg(assertionId)}/decision`, { decision, reason });
  }

  /** Confirm an assertion. */
  async confirm(assertionId: string, reason: string): Promise<Doc> {
    return this.decide(assertionId, "confirm", reason);
  }

  /** Reject an assertion; it never resolves while rejected. */
  async reject(assertionId: string, reason: string): Promise<Doc> {
    return this.decide(assertionId, "reject", reason);
  }

  /** `POST .../revoke`: replace the assertion with a content-free tombstone. */
  async revoke(assertionId: string, reason: string): Promise<Doc> {
    return this._post<Doc>(`/assertions/${seg(assertionId)}/revoke`, { reason });
  }

  /** `POST /assertion-relations` (#5721): link two assertions with a rationale and optional locator. */
  async relate(
    fromId: string,
    kind: "supports" | "contradicts" | "derived_from",
    toId: string,
    rationale: string,
    opts: { locator?: { evidence_id?: string; pointer?: string } } = {},
  ): Promise<Doc> {
    const body: Doc = { from: fromId, to: toId, kind, rationale };
    if (opts.locator !== undefined) body.locator = opts.locator;
    return this._post<Doc>("/assertion-relations", body);
  }

  /** `POST /assertion-relations/{id}/revoke`: withdraw a relation. */
  async unrelate(relationId: string, reason: string): Promise<Doc> {
    return this._post<Doc>(`/assertion-relations/${seg(relationId)}/revoke`, { reason });
  }

  /** `POST .../assessment`: an analyst judgment, kept apart from source reliability and model confidence. */
  async assess(
    assertionId: string,
    judgment: "corroborated" | "disputed" | "inconclusive",
    reason: string,
  ): Promise<Doc> {
    return this._post<Doc>(`/assertions/${seg(assertionId)}/assessment`, { judgment, reason });
  }

  /** `GET .../evidence-graph`: bounded authorized neighbourhood plus the corroboration summary. */
  async evidenceGraph(
    assertionId: string,
    opts: { depth?: number; limit?: number; policy?: string; policyVersion?: number } = {},
  ): Promise<Doc> {
    const q = new URLSearchParams();
    if (opts.depth !== undefined) q.set("depth", String(Math.trunc(opts.depth)));
    if (opts.limit !== undefined) q.set("limit", String(Math.trunc(opts.limit)));
    if (opts.policy !== undefined) {
      q.set("policy", opts.policy);
      if (opts.policyVersion !== undefined) q.set("policy_version", String(Math.trunc(opts.policyVersion)));
    }
    const qs = q.toString();
    return this._get<Doc>(`/assertions/${seg(assertionId)}/evidence-graph${qs ? `?${qs}` : ""}`);
  }

  /** `PUT /assertion-policies/{name}` under the `expectedVersion` precondition. */
  async publishPolicy(name: string, definition: Doc, opts: { expectedVersion?: number } = {}): Promise<Doc> {
    return this._put<Doc>(`/assertion-policies/${seg(name)}`, {
      expected_version: Math.trunc(opts.expectedVersion ?? 0),
      definition,
    });
  }

  /** `GET /assertion-policies/{name}` (latest, or `version`). */
  async getPolicy(name: string, opts: { version?: number } = {}): Promise<Doc> {
    const qs = opts.version === undefined ? "" : `?version=${Math.trunc(opts.version)}`;
    return this._get<Doc>(`/assertion-policies/${seg(name)}${qs}`);
  }

  /** `GET /assertion-resolve`: the value at `validAt` as known at `recordedAsOf`, with an explanation. */
  async resolve(
    subjectType: string,
    subjectId: string,
    predicate: string,
    validAt: number,
    opts: { recordedAsOf?: number; policy?: string; policyVersion?: number } = {},
  ): Promise<Doc> {
    const q = new URLSearchParams({
      subject_type: subjectType,
      subject_id: subjectId,
      predicate,
      valid_at: String(Math.trunc(validAt)),
    });
    if (opts.recordedAsOf !== undefined) q.set("recorded_as_of", String(Math.trunc(opts.recordedAsOf)));
    if (opts.policy !== undefined) {
      q.set("policy", opts.policy);
      if (opts.policyVersion !== undefined) q.set("policy_version", String(Math.trunc(opts.policyVersion)));
    }
    return this._get<Doc>(`/assertion-resolve?${q.toString()}`);
  }
}
