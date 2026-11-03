/**
 * Object store SDK (#82) — general state-object upsert + load surface.
 *
 * The server's universal upsert path is `POST /v1/ingest?object_type=<Type>`;
 * this module wraps it as a typed `ObjectClient` so TypeScript callers don't
 * have to know the ingest envelope shape.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase, qs } from "./_typed-http.ts";
import { RelataError, type PreconditionFailedError } from "./errors.ts";

/** Row shape accepted by `upsert` / `batchUpsert`. */
export type RelataRow = Record<string, unknown>;

/** Options for `list()`. */
export interface ListObjectsOptions {
  limit?: number;
  cursor?: string;
}

/** Paginated response from `list()`. */
export interface ListObjectsResponse<T = RelataRow> {
  items: T[];
  cursor?: string;
  total?: number;
}

/** One operation of an atomic `commit` bundle (#5767). */
export interface ChangesOptions {
  /** `nextCursor` of the previous page (an event id). */
  cursor?: string;
  /** Events per page, 1 to 1000 (server default 100). */
  limit?: number;
  /** Only events of this object type. */
  type?: string;
  /** `latest`: with no cursor, skip history and return the current position. */
  start?: "latest";
}

/** Options for {@link ObjectClient.followChanges}. */
export interface FollowChangesOptions extends ChangesOptions {
  /** Seconds to wait before polling again once caught up (default 1). */
  pollIntervalSeconds?: number;
  /** Consecutive transient failures tolerated before the error is thrown (default 8). */
  maxReconnects?: number;
  /** First reconnect delay in seconds, doubling per failure (default 0.5). */
  reconnectBackoffSeconds?: number;
  /** Upper bound for one reconnect delay in seconds (default 30). */
  maxBackoffSeconds?: number;
  /** Stop following when aborted. */
  signal?: AbortSignal;
}

const TRANSIENT_STATUS = new Set([0, 429, 500, 502, 503, 504]);

function sleepSeconds(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (seconds <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(done, seconds * 1000);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface ChangeEvent {
  eventId: string;
  seq: number;
  kind: "create" | "update" | "delete";
  /** `object` for object changes, `link` for graph edges (then `type` is the link name). */
  entity: "object" | "link";
  type: string;
  id: string;
  /** Link events only. */
  sourceId?: string;
  /** Link events only. */
  targetId?: string;
  version: number;
  commitId: string;
  opIndex: number;
  committedAtNs: number;
}

export interface ChangesPage {
  feedId: string;
  events: ChangeEvent[];
  nextCursor: string;
  hasMore: boolean;
  head: number;
  oldest?: number;
  withheld: number;
  /** Events whose durable journal row failed (served from memory only). */
  journalFailures?: number;
}

export interface CommitOperation {
  op: "create" | "update" | "delete";
  type: string;
  id: string;
  /** update/delete: the `_version` the caller read; any other live version is a 412. */
  expectedVersion?: number;
  /** create/update: the full object. */
  data?: RelataRow;
}

/** Result of a conditional single-object write (#5766). */
export interface ObjectWriteResult {
  type: string;
  id: string;
  /** Monotonic object version after the write; also the response `ETag`. */
  version: number;
  commitId: string;
  replayed: boolean;
}

/** Result of `commit` (#5767), or of its idempotent replay. */
export interface CommitResult {
  commitId: string;
  operations: Array<{ op: "create" | "update" | "delete"; type: string; id: string; version: number }>;
  replayed: boolean;
}

/** The `If-Match` / `If-None-Match` header set for a conditional write. */
function preconditionHeaders(expectedVersion?: number, ifAbsent?: boolean): Record<string, string> {
  if (expectedVersion !== undefined && ifAbsent === true) {
    throw new TypeError("expectedVersion and ifAbsent are mutually exclusive");
  }
  if (ifAbsent === true) return { "If-None-Match": "*" };
  if (expectedVersion !== undefined) return { "If-Match": `"${expectedVersion}"` };
  return {};
}

function objectPath(objectType: string, objectId: string): string {
  return `/v1/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`;
}

/** Serialise `rows` as newline-delimited JSON — one row per line. */
function rowsToNdjson(rows: RelataRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

/** Options inherited from the parent client. */
export interface ObjectClientCtor extends TypedClientCtor {
  /** Default purpose attached to ingest calls when not overridden per-call. */
  purpose?: string;
  /** Tenant / `X-Relata-Tenant-Id`. */
  tenant?: string;
}

/** Typed upsert/load client for state objects. */
export class ObjectClient extends TypedClientBase {
  readonly #purpose: string | undefined;
  readonly #tenant: string | undefined;

  constructor(opts: ObjectClientCtor) {
    super(opts);
    this.#purpose = opts.purpose;
    this.#tenant = opts.tenant;
  }

  /** Inherit the parent client's auth, purpose, tenant, and headers. */
  static fromClient(client: RelataClient): ObjectClient {
    const ctor = TypedClientBase.clientToCtor(client);
    const objectCtor: ObjectClientCtor = { ...ctor };
    if (client.defaultPurpose !== undefined) {
      objectCtor.purpose = client.defaultPurpose;
    }
    if (client.tenant !== undefined) objectCtor.tenant = client.tenant;
    return new ObjectClient(objectCtor);
  }

  /**
   * Upsert a single state object. The `objectId` becomes the row's primary
   * key; re-upserting with the same id supersedes bi-temporally.
   * Wraps `POST /v1/ingest?object_type=<Type>` with an NDJSON body.
   *
   * **Resolves, does not throw, on a schema rejection.** `POST /v1/ingest` is an
   * asynchronous queue-ack: a row rejected by schema validation still yields
   * a normal resolved promise, e.g.
   * `{ rows_queued: 0, rows_rejected: 1, errors: ["Type.field: minCount 1 not met"] }`.
   * "No throw" therefore does NOT mean "stored" — callers MUST check
   * `rows_rejected` / `errors` on every call. A queued row is also not yet
   * SQL-visible; see `batchUpsert` when read-your-writes matters.
   *
   * **Conditional (#5766).** With `expectedVersion` (replace only if the
   * object is at that `_version`, `If-Match`) or `ifAbsent: true` (create
   * only, `If-None-Match: *`) the call switches to the atomic
   * `PUT /v1/objects/{type}/{id}` door: durable before it resolves, resolving to
   * an {@link ObjectWriteResult} with the new `version`, and rejecting with
   * {@link PreconditionFailedError} (`currentVersion`) when the race is lost.
   *
   * @returns The ingest ack (`rows_queued`, `rows_rejected`, `errors`,
   *          `task_id`, ...), not a per-row receipt.
   */
  async upsert(
    objectType: string,
    objectId: string,
    fields: RelataRow,
    opts: { purpose?: string; source?: string; expectedVersion?: number; ifAbsent?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    if (opts.expectedVersion !== undefined || opts.ifAbsent === true) {
      const { id: _ignored, ...body } = fields;
      const purpose = opts.purpose ?? this.#purpose;
      return this._put<Record<string, unknown>>(
        `${objectPath(objectType, objectId)}${qs({ purpose })}`,
        body,
        preconditionHeaders(opts.expectedVersion, opts.ifAbsent),
      );
    }
    const row: RelataRow = { ...fields, id: objectId };
    if (opts.source !== undefined) row["_source"] = opts.source;
    return this.sendNdjson(objectType, [row], opts.purpose);
  }

  /**
   * Typed upsert — accepts any typed object with a `_pk` field. The type
   * system catches malformed fields at compile time (#967 Tier 2a).
   *
   * ```ts
   * interface Person { _pk: string; name: string; email: string }
   * await objects.typedUpsert("Person", { _pk: "p1", name: "Alice", email: "a@b.com" });
   * ```
   *
   * Same contract as `upsert`: a schema rejection resolves with
   * `rows_rejected > 0` and does not throw — check the returned ack.
   */
  async typedUpsert<T extends { _pk: string }>(
    objectType: string,
    obj: T,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const { _pk, ...fields } = obj;
    return this.upsert(objectType, _pk, fields as RelataRow, opts);
  }

  /**
   * Bulk upsert. Each row must carry its own `id` key.
   * Wraps `POST /v1/ingest?object_type=<Type>` with an NDJSON body.
   *
   * Like `upsert`, per-row rejections are reported in the returned receipt
   * rather than thrown — inspect its rejected count and `errors`.
   *
   * @returns The bulk receipt
   *          (`accepted`, `rejected`, `write_seq`, `queue_depth`).
   */
  async batchUpsert(
    objectType: string,
    rows: RelataRow[],
    opts: { purpose?: string; source?: string } = {},
  ): Promise<Record<string, unknown>> {
    const prepared = opts.source !== undefined
      ? rows.map((r) => ({ ...r, _source: opts.source }))
      : rows;
    return this.sendNdjson(objectType, prepared, opts.purpose);
  }

  /**
   * Fetch a single state object by type and id.
   * Wraps `GET /v1/objects/{type}/{id}`.
   *
   * @returns The object fields, or `null` if not found (404).
   */
  async get(
    objectType: string,
    objectId: string,
  ): Promise<Record<string, unknown> | null> {
    const path = objectPath(objectType, objectId);
    try {
      return await this._get<Record<string, unknown>>(path);
    } catch (err) {
      // Duck-typed rather than `instanceof NotFoundError` so this keeps
      // working regardless of which `RelataError` subclass a 404 maps to
      // (`_typed-http.ts`'s `#classify`, #2731) — every subclass carries
      // `statusCode`.
      if (
        err !== null &&
        typeof err === "object" &&
        "statusCode" in err &&
        (err as { statusCode: number }).statusCode === 404
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Delete a state object by type and id.
   * Wraps `DELETE /v1/objects/{type}/{id}`.
   *
   * With `opts.expectedVersion` the delete is conditional (`If-Match`, #5766):
   * a different live version rejects with {@link PreconditionFailedError} and
   * nothing is deleted.
   *
   * @returns The server's delete receipt (e.g. `{ deleted: true }`).
   */
  async delete(
    objectType: string,
    objectId: string,
    opts: { expectedVersion?: number } = {},
  ): Promise<Record<string, unknown>> {
    // Python and Go send the client's purpose on the conditional-delete door; so does this (#5666).
    const path = `${objectPath(objectType, objectId)}${qs({ purpose: this.#purpose })}`;
    return this._delete<Record<string, unknown>>(
      path,
      opts.expectedVersion === undefined ? undefined : preconditionHeaders(opts.expectedVersion),
    );
  }

  /**
   * Tombstone every live row of `objectType` matching `where`.
   * Wraps `DELETE /v1/objects/{type}` with `{ "where": ... }`.
   *
   * `where` is a SQL WHERE expression such as `"status = 'stale'"`, not a
   * statement. A blank `where` is refused before any request is sent, so this
   * method cannot delete every row of a type by accident.
   *
   * @returns The server receipt, e.g. `{ deleted: 3, type: "Doc" }`.
   */
  async deleteWhere(objectType: string, where: string): Promise<Record<string, unknown>> {
    if (typeof where !== "string" || where.trim() === "") {
      throw new TypeError("where must be a non-empty SQL WHERE expression");
    }
    return this._delete<Record<string, unknown>>(
      `/v1/objects/${encodeURIComponent(objectType)}`,
      undefined,
      { where },
    );
  }

  /**
   * Atomically apply 1..64 create/update/delete operations
   * (`POST /v1/commit`, #5767). All of them become durable and visible, or none
   * do; every `expectedVersion` is checked before anything is written. A
   * failed precondition rejects with {@link PreconditionFailedError}
   * (`currentVersion`, `failedOperation`). A retry with the same
   * `idempotencyKey` resolves to the original result (`replayed: true`).
   */
  async commit(
    operations: CommitOperation[],
    opts: { idempotencyKey?: string; purpose?: string } = {},
  ): Promise<CommitResult> {
    const purpose = opts.purpose ?? this.#purpose;
    return this._post<CommitResult>("/v1/commit", {
      operations,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(purpose !== undefined ? { purpose } : {}),
    });
  }

  /**
   * Read one page of the object change feed (`GET /v1/changes`, #5716).
   * Persist `nextCursor` only after every event in the page is processed;
   * delivery is at-least-once, so dedupe on `eventId`. Events carry identity,
   * `version` and `kind`, never field values. A cursor the server can no
   * longer serve rejects with the API error for `410`
   * (`change-feed-resync-required`): re-read state, then call with
   * `start: "latest"`.
   */
  async changes(opts: ChangesOptions = {}): Promise<ChangesPage> {
    const params: Record<string, string | number | undefined> = {};
    if (opts.cursor !== undefined) params["cursor"] = opts.cursor;
    if (opts.limit !== undefined) params["limit"] = opts.limit;
    if (opts.type !== undefined) params["type"] = opts.type;
    if (opts.start !== undefined) params["start"] = opts.start;
    return this._get<ChangesPage>(`/v1/changes${qs(params)}`);
  }

  /**
   * Iterate successive change-feed pages until the consumer is caught up
   * (the first page with `hasMore === false`). Persist each page's
   * `nextCursor` only after its events are processed. The feed captures every
   * write path (objects, ingest, SQL, links, deletes) and is off unless the
   * server sets `RELATA_CHANGE_FEED_ENABLE`; a disabled feed rejects with the
   * API error for `404 change-feed-disabled`.
   */
  async *changePages(opts: ChangesOptions = {}): AsyncGenerator<ChangesPage, void, undefined> {
    let next: ChangesOptions = { ...opts };
    for (;;) {
      const page = await this.changes(next);
      yield page;
      if (!page.hasMore) return;
      const { start: _start, ...rest } = next;
      next = { ...rest, cursor: page.nextCursor };
    }
  }

  /**
   * Follow the change feed indefinitely, reconnecting and resuming by cursor.
   *
   * Yields each non-empty page. The cursor advances only after the consumer
   * asks for the next page, so persist `page.nextCursor` once its events are
   * processed and pass it back as `cursor` after a crash (at-least-once, no
   * gap). When caught up it waits `pollIntervalSeconds`. A transient failure
   * (network loss, 429, 5xx) is retried from the last delivered cursor with
   * exponential backoff (honouring a server `retryAfterSeconds`); after
   * `maxReconnects` consecutive failures the last error is thrown. Any other
   * API error, including `410 change-feed-resync-required` and
   * `404 change-feed-disabled`, is thrown at once. Stop with `signal` or by
   * breaking out of the loop.
   */
  async *followChanges(
    opts: FollowChangesOptions = {},
  ): AsyncGenerator<ChangesPage, void, undefined> {
    const {
      pollIntervalSeconds = 1,
      maxReconnects = 8,
      reconnectBackoffSeconds = 0.5,
      maxBackoffSeconds = 30,
      signal,
      ...feed
    } = opts;
    let next: ChangesOptions = { ...feed };
    let failures = 0;
    while (!signal?.aborted) {
      let page: ChangesPage;
      try {
        page = await this.changes(next);
      } catch (err) {
        const transient = err instanceof RelataError && TRANSIENT_STATUS.has(err.statusCode);
        if (!transient || failures >= maxReconnects) throw err;
        const base = Math.min(maxBackoffSeconds, reconnectBackoffSeconds * 2 ** failures);
        const hinted = Math.min(maxBackoffSeconds, err.retryAfterSeconds ?? 0);
        await sleepSeconds(Math.max(base, hinted), signal);
        failures += 1;
        continue;
      }
      failures = 0;
      const { start: _start, ...rest } = next;
      next = { ...rest, cursor: page.nextCursor };
      if (page.events.length > 0) yield page;
      if (!page.hasMore) await sleepSeconds(pollIntervalSeconds, signal);
    }
  }

  /**
   * List state objects of a given type with optional pagination.
   * Wraps `GET /v1/objects/{type}?limit=N&cursor=C`.
   *
   * @returns Paginated result with `items`, optional `cursor`, optional `total`.
   */
  async list<T = RelataRow>(
    objectType: string,
    opts: ListObjectsOptions = {},
  ): Promise<ListObjectsResponse<T>> {
    const params: Record<string, string | number | undefined> = {};
    if (opts.limit !== undefined) params["limit"] = opts.limit;
    if (opts.cursor !== undefined) params["cursor"] = opts.cursor;
    const path = `/v1/objects/${encodeURIComponent(objectType)}${qs(params)}`;
    return this._get<ListObjectsResponse<T>>(path);
  }

  /** @internal Build the query string and POST the NDJSON body. */
  private async sendNdjson(
    objectType: string,
    rows: RelataRow[],
    purposeOverride: string | undefined,
  ): Promise<Record<string, unknown>> {
    const effPurpose = purposeOverride ?? this.#purpose;
    const path = `/v1/ingest${qs({
      object_type: objectType,
      purpose: effPurpose,
    })}`;
    return this._sendRaw("POST", path, rowsToNdjson(rows), "application/x-ndjson");
  }
}
