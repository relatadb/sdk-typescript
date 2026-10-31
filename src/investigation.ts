/**
 * Investigation workflow: alert evidence, timeline, pivots and saved searches (#5702).
 *
 * `alertEvidence` returns the source events behind an alert with a reproduction
 * query, completeness report and SHA-256. `alertTimeline` orders the same facts
 * (window, events, firing, triage changes) and lists the entities to pivot on.
 * `pivot` follows one of those entities into the caller's other readable
 * records; the value must come from evidence the caller could read, and
 * unreadable types and rows are omitted without a count. The saved-search
 * methods keep a named SQL query (versioned, per tenant, durable);
 * `runSavedSearch` runs it through the governed `POST /query` path with the
 * caller's own read policy, so saving a query grants nothing.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

type Doc = Record<string, unknown>;

const seg = (s: string | number): string => encodeURIComponent(String(s));

function bounds(opts: { maxEvents?: number; deadlineMs?: number }): string {
  const q = new URLSearchParams();
  if (opts.maxEvents !== undefined) q.set("max_events", String(opts.maxEvents));
  if (opts.deadlineMs !== undefined) q.set("deadline_ms", String(opts.deadlineMs));
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

/** A saved-search definition. */
export interface SavedSearchInput {
  name: string;
  sql: string;
  purpose?: string;
  description?: string;
  params?: unknown[];
}

function searchBody(input: SavedSearchInput, expectedVersion?: number): Doc {
  const body: Doc = { name: input.name, sql: input.sql };
  if (input.purpose !== undefined) body.purpose = input.purpose;
  if (input.description !== undefined) body.description = input.description;
  if (input.params !== undefined) body.params = input.params;
  if (expectedVersion !== undefined) body.expected_version = expectedVersion;
  return body;
}

/** Investigation client. */
export class InvestigationClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): InvestigationClient {
    return new InvestigationClient(TypedClientBase.clientToCtor(client));
  }

  /** `GET /alerts/{id}/evidence`: events, reproduction query, completeness, SHA-256. */
  async alertEvidence(alertId: string, opts: { maxEvents?: number; deadlineMs?: number } = {}): Promise<Doc> {
    return this._get<Doc>(`/alerts/${seg(alertId)}/evidence${bounds(opts)}`);
  }

  /** `GET /alerts/{id}/timeline`: ordered entries, unplaced ids and pivot entities. */
  async alertTimeline(alertId: string, opts: { maxEvents?: number; deadlineMs?: number } = {}): Promise<Doc> {
    return this._get<Doc>(`/alerts/${seg(alertId)}/timeline${bounds(opts)}`);
  }

  /** `POST /alerts/{id}/pivot`: other readable records for one evidence entity. */
  async pivot(
    alertId: string,
    opts: {
      field?: string;
      value?: string | number | boolean;
      targetField?: string;
      targetTypes?: string[];
      limit?: number;
      deadlineMs?: number;
    } = {},
  ): Promise<Doc> {
    const body: Doc = {};
    if (opts.field !== undefined) body.field = opts.field;
    if (opts.value !== undefined) body.value = opts.value;
    if (opts.targetField !== undefined) body.target_field = opts.targetField;
    if (opts.targetTypes !== undefined) body.target_types = opts.targetTypes;
    if (opts.limit !== undefined) body.limit = opts.limit;
    if (opts.deadlineMs !== undefined) body.deadline_ms = opts.deadlineMs;
    return this._post<Doc>(`/alerts/${seg(alertId)}/pivot`, body);
  }

  /** `POST /searches/saved`: `409 saved-search-exists` if the name is taken. */
  async createSavedSearch(input: SavedSearchInput): Promise<Doc> {
    return this._post<Doc>("/searches/saved", searchBody(input));
  }

  /** `GET /searches/saved`: `{items, total}` ordered by name. */
  async listSavedSearches(opts: { q?: string; limit?: number } = {}): Promise<Doc> {
    const q = new URLSearchParams();
    if (opts.q !== undefined) q.set("q", opts.q);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this._get<Doc>(`/searches/saved${qs ? `?${qs}` : ""}`);
  }

  /** `GET /searches/saved/{id}`. */
  async getSavedSearch(searchId: string): Promise<Doc> {
    return this._get<Doc>(`/searches/saved/${seg(searchId)}`);
  }

  /** `PUT /searches/saved/{id}`; `expectedVersion` makes it conditional. */
  async updateSavedSearch(
    searchId: string,
    input: SavedSearchInput,
    opts: { expectedVersion?: number } = {},
  ): Promise<Doc> {
    return this._put<Doc>(`/searches/saved/${seg(searchId)}`, searchBody(input, opts.expectedVersion));
  }

  /** `DELETE /searches/saved/{id}`: leaves listings; history is kept. */
  async deleteSavedSearch(searchId: string): Promise<Doc> {
    return this._delete<Doc>(`/searches/saved/${seg(searchId)}`);
  }

  /** `POST /searches/saved/{id}/run`: the `POST /query` response for the stored SQL. */
  async runSavedSearch(searchId: string, opts: { params?: unknown[] } = {}): Promise<Doc> {
    const body: Doc = {};
    if (opts.params !== undefined) body.params = opts.params;
    return this._post<Doc>(`/searches/saved/${seg(searchId)}/run`, body);
  }
}
