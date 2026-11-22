/**
 * Versioned ontology definitions, publication and migration (#5711).
 *
 * Create a definition set, edit its draft, `compare` it with the published
 * version (changes classified compatible/migration/breaking/refused, with row
 * impact), `publish` under an `expectedVersion` precondition and, when rows
 * must be rewritten, `runMigration` until it completes. A publish that races
 * another gets 412 `ontology-version-conflict`; one needing consent gets 409
 * until `acceptMigration`/`acceptBreaking` is set.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

type Doc = Record<string, unknown>;

const BASE = "/v1/ontology/definitions";
const seg = (s: string | number): string => encodeURIComponent(String(s));

/** Options for {@link OntologyDefinitionsClient.publish}. */
export interface PublishOptions {
  expectedVersion: number;
  acceptMigration?: boolean;
  acceptBreaking?: boolean;
  /** Republish an earlier version's content as the next version. */
  fromVersion?: number;
  /** Publish a change that drops or retypes data; needs a schema-admin or platform-admin token. */
  overrideUnsafe?: boolean;
}

/** Ontology definitions client. */
export class OntologyDefinitionsClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): OntologyDefinitionsClient {
    return new OntologyDefinitionsClient(TypedClientBase.clientToCtor(client));
  }

  /** `GET /v1/ontology/definitions`. */
  async list(): Promise<Doc> {
    return this._get<Doc>(BASE);
  }

  /** `POST /v1/ontology/definitions`: a new set with an initial draft. */
  async create(name: string, definition: Doc): Promise<Doc> {
    return this._post<Doc>(BASE, { name, definition });
  }

  /** `GET /v1/ontology/definitions/{name}`: head and current draft. */
  async get(name: string): Promise<Doc> {
    return this._get<Doc>(`${BASE}/${seg(name)}`);
  }

  /** `PUT .../draft`. */
  async saveDraft(name: string, definition: Doc): Promise<Doc> {
    return this._put<Doc>(`${BASE}/${seg(name)}/draft`, { definition });
  }

  /** `POST .../validate`: the draft, or `definition` when given. */
  async validate(name: string, definition?: Doc): Promise<Doc> {
    return this._post<Doc>(`${BASE}/${seg(name)}/validate`, definition === undefined ? {} : { definition });
  }

  /** `GET .../compare`: classified changes plus row impact. */
  async compare(name: string, opts: { from?: number | "draft"; to?: number | "draft" } = {}): Promise<Doc> {
    const q = new URLSearchParams();
    if (opts.from !== undefined) q.set("from", String(opts.from));
    if (opts.to !== undefined) q.set("to", String(opts.to));
    const qs = q.toString();
    return this._get<Doc>(`${BASE}/${seg(name)}/compare${qs ? `?${qs}` : ""}`);
  }

  /** `POST .../publish` under the `expectedVersion` precondition. */
  async publish(name: string, opts: PublishOptions): Promise<Doc> {
    const body: Doc = { expected_version: Math.trunc(opts.expectedVersion) };
    if (opts.acceptMigration) body["accept_migration"] = true;
    if (opts.acceptBreaking) body["accept_breaking"] = true;
    if (opts.overrideUnsafe) body["override_unsafe"] = true;
    if (opts.fromVersion !== undefined) body["from_version"] = Math.trunc(opts.fromVersion);
    return this._post<Doc>(`${BASE}/${seg(name)}/publish`, body);
  }

  /** `GET .../versions/{version}`: an immutable published version. */
  async version(name: string, version: number): Promise<Doc> {
    return this._get<Doc>(`${BASE}/${seg(name)}/versions/${seg(version)}`);
  }

  /** `GET .../status`: row counts by definition version, stale rows. */
  async status(name: string): Promise<Doc> {
    return this._get<Doc>(`${BASE}/${seg(name)}/status`);
  }

  /** `GET .../migrations/{version}`: progress, failures, cursor. */
  async migration(name: string, version: number): Promise<Doc> {
    return this._get<Doc>(`${BASE}/${seg(name)}/migrations/${seg(version)}`);
  }

  /** `POST .../migrations/{version}/run`: rewrite up to `maxRows`; call again to resume. */
  async runMigration(
    name: string,
    version: number,
    opts: { maxRows?: number; retryFailed?: boolean } = {},
  ): Promise<Doc> {
    const body: Doc = {};
    if (opts.maxRows !== undefined) body["max_rows"] = Math.trunc(opts.maxRows);
    if (opts.retryFailed) body["retry_failed"] = true;
    return this._post<Doc>(`${BASE}/${seg(name)}/migrations/${seg(version)}/run`, body);
  }

  /**
   * `GET .../export?format=ossie` (experimental, #6400): a published version as an
   * Apache Ossie 0.3.0.dev0 semantic model (JSON).
   */
  async exportOssie(name: string, opts: { version?: number; baseIri?: string } = {}): Promise<Doc> {
    const q = new URLSearchParams({ format: "ossie" });
    if (opts.version !== undefined) q.set("version", String(Math.trunc(opts.version)));
    if (opts.baseIri !== undefined) q.set("base_iri", opts.baseIri);
    return this._get<Doc>(`${BASE}/${seg(name)}/export?${q.toString()}`);
  }

  /**
   * `POST .../import?format=ossie` (experimental, #6401): submit an Ossie model's
   * datasets, fields and links as review-queue suggestions; returns the import report.
   */
  async importOssie(name: string, document: Doc): Promise<Doc> {
    return this._post<Doc>(`${BASE}/${seg(name)}/import?format=ossie`, document);
  }
}
