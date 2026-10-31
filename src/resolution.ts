/**
 * Entity resolution: rule sets, candidate matches, reviewed merge and unmerge (#5712).
 *
 * Publish a rule set (`publishRuleset`, under an `expectedVersion`
 * precondition), `run` it to generate candidates, inspect a candidate's
 * evidence (`getCandidate`) and `approve`/`reject`/`unmerge` it. A merge never
 * rewrites the source records; `lookup` and `getEntity` answer the canonical
 * id. `evaluate` scores a rule set on labeled pairs against its approved
 * thresholds. A publish that races another gets 412
 * `resolution-version-conflict`; approving a candidate whose source changed
 * gets 409 `resolution-evidence-stale`.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

type Doc = Record<string, unknown>;

const BASE = "/v1/resolution";
const seg = (s: string | number): string => encodeURIComponent(String(s));

/** Resolution client. */
export class ResolutionClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): ResolutionClient {
    return new ResolutionClient(TypedClientBase.clientToCtor(client));
  }

  /** `GET /v1/resolution/rulesets`. */
  async listRulesets(): Promise<Doc> {
    return this._get<Doc>(`${BASE}/rulesets`);
  }

  /** `GET /v1/resolution/rulesets/{name}` (latest, or `version`). */
  async getRuleset(name: string, opts: { version?: number } = {}): Promise<Doc> {
    const qs = opts.version === undefined ? "" : `?version=${Math.trunc(opts.version)}`;
    return this._get<Doc>(`${BASE}/rulesets/${seg(name)}${qs}`);
  }

  /** `PUT /v1/resolution/rulesets/{name}` under the `expectedVersion` precondition. */
  async publishRuleset(name: string, definition: Doc, opts: { expectedVersion?: number } = {}): Promise<Doc> {
    return this._put<Doc>(`${BASE}/rulesets/${seg(name)}`, {
      expected_version: Math.trunc(opts.expectedVersion ?? 0),
      definition,
    });
  }

  /** `POST .../run`: generate or refresh candidates (repeat while `complete` is false). */
  async run(name: string, opts: { proposals?: Doc[] } = {}): Promise<Doc> {
    const body: Doc = opts.proposals === undefined ? {} : { proposals: opts.proposals };
    return this._post<Doc>(`${BASE}/rulesets/${seg(name)}/run`, body);
  }

  /** `POST .../evaluate`: precision and recall on labeled pairs, nothing persisted. */
  async evaluate(name: string, labeled: Doc[], opts: { proposals?: Doc[] } = {}): Promise<Doc> {
    const body: Doc = { labeled };
    if (opts.proposals !== undefined) body["proposals"] = opts.proposals;
    return this._post<Doc>(`${BASE}/rulesets/${seg(name)}/evaluate`, body);
  }

  /** `GET /v1/resolution/candidates`. */
  async listCandidates(opts: { ruleset?: string; state?: string; limit?: number } = {}): Promise<Doc> {
    const q = new URLSearchParams();
    if (opts.ruleset !== undefined) q.set("ruleset", opts.ruleset);
    if (opts.state !== undefined) q.set("state", opts.state);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this._get<Doc>(`${BASE}/candidates${qs ? `?${qs}` : ""}`);
  }

  /** `GET /v1/resolution/candidates/{id}`: evidence, history and live values. */
  async getCandidate(candidateId: string): Promise<Doc> {
    return this._get<Doc>(`${BASE}/candidates/${seg(candidateId)}`);
  }

  /** `POST .../decision` with `approve`, `reject` or `unmerge`; idempotent. */
  async decide(candidateId: string, decision: "approve" | "reject" | "unmerge", reason: string): Promise<Doc> {
    return this._post<Doc>(`${BASE}/candidates/${seg(candidateId)}/decision`, { decision, reason });
  }

  /** Approve (merge) a candidate. */
  async approve(candidateId: string, reason: string): Promise<Doc> {
    return this.decide(candidateId, "approve", reason);
  }

  /** Reject a candidate; the pair is not proposed again. */
  async reject(candidateId: string, reason: string): Promise<Doc> {
    return this.decide(candidateId, "reject", reason);
  }

  /** Undo an approved merge. */
  async unmerge(candidateId: string, reason: string): Promise<Doc> {
    return this.decide(candidateId, "unmerge", reason);
  }

  /** `GET /v1/resolution/entities/{canonical}`: follows merge aliases. */
  async getEntity(canonicalId: string): Promise<Doc> {
    return this._get<Doc>(`${BASE}/entities/${seg(canonicalId)}`);
  }

  /** `GET /v1/resolution/lookup`: the canonical id of a source record. */
  async lookup(type: string, id: string): Promise<Doc> {
    const q = new URLSearchParams({ type, id });
    return this._get<Doc>(`${BASE}/lookup?${q.toString()}`);
  }
}
