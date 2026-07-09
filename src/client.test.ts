/**
 * Tests for `RelataClient` — transport hardening, introspection methods,
 * QueryResult wire-shape normalisation, RFC 7807 error mapping, retry
 * behaviour, and X-Request-ID propagation.
 *
 * Uses Node's built-in `node:test` runner with an injected `fetch` mock
 * (no real HTTP).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  AuthError,
  ConflictError,
  createClient,
  NotFoundError,
  PurposeError,
  RateLimitedError,
  RelataClient,
  RelataError,
  ServerError,
  ValidationError,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

/** Minimal Response-like object the mock returns. */
interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  bodyText?: string;
}

/** Build a fetch mock that returns the supplied responses in order. */
function mockFetch(
  responses: MockResponse[] | MockResponse,
): {
  fetch: typeof globalThis.fetch;
  calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
  }>;
} {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
  }> = [];
  const fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlString = typeof url === "string" ? url : url.toString();
    // Lowercase header keys to match real `fetch` / `Headers` semantics.
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: urlString,
      method: init?.method ?? "GET",
      headers,
      body:
        typeof init?.body === "string" ? (init.body as string) : undefined,
    });
    const next = queue.shift() ?? { status: 200, body: {} };
    const status = next.status ?? 200;
    const headerMap = new Headers();
    for (const [k, v] of Object.entries(next.headers ?? {})) headerMap.set(k, v);
    const contentType = headerMap.get("content-type") ??
      (status >= 400 ? "application/problem+json" : "application/json");
    headerMap.set("content-type", contentType);
    let bodyText: string;
    if (next.bodyText !== undefined) {
      bodyText = next.bodyText;
    } else if (typeof next.body === "string") {
      bodyText = next.body;
    } else {
      bodyText = JSON.stringify(next.body ?? {});
    }
    return new Response(bodyText, { status, headers: headerMap });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("query: normalises the legacy rows-as-int wire shape", async () => {
  // Legacy shape: rows is an int count, no data array
  const { fetch } = mockFetch({
    body: {
      rows: 5,
      query_id: "q-1",
      elapsed_ms: 12,
    },
  });
  const relata = new RelataClient({
    baseUrl: "http://x",
    defaultPurpose: "analytics",
    fetch,
  });
  const result = await relata.query("SELECT * FROM Person LIMIT 5");
  assert.equal(result.rowCount, 0);
  assert.equal(result.rows.length, 0);
  assert.equal(result.queryId, "q-1");
  assert.equal(result.elapsedMs, 12);
});

test("query: normalises the rich data-array wire shape", async () => {
  // Rich shape: data is the row array
  const { fetch } = mockFetch({
    body: {
      data: [{ id: "p1", name: "Alice" }, { id: "p2", name: "Bob" }],
      columns: ["id", "name"],
      query_id: "q-2",
      elapsed_ms: 7,
    },
  });
  const relata = new RelataClient({
    baseUrl: "http://x",
    defaultPurpose: "analytics",
    fetch,
  });
  const result = await relata.query<{ id: string; name: string }>(
    "SELECT id, name FROM Person",
  );
  assert.equal(result.rowCount, 2);
  assert.equal(result.rows[0]?.name, "Alice");
  assert.equal(result.rows[1]?.id, "p2");
  assert.deepEqual(result.columns, ["id", "name"]);
});

test("query: throws PurposeError before hitting the wire when no purpose is set", async () => {
  const { fetch, calls } = mockFetch({ body: {} });
  const relata = new RelataClient({ baseUrl: "http://x", fetch });
  await assert.rejects(() => relata.query("SELECT * FROM Person"), (err: unknown) => {
    assert.ok(err instanceof PurposeError, "should be PurposeError");
    return true;
  });
  assert.equal(calls.length, 0, "should not have issued a request");
});

test("stats / version / ready / ingestDocument: map wire shapes", async () => {
  const queue: MockResponse[] = [
    {
      body: {
        records: 10,
        states: 100,
        snapshot_rows: 5,
        log_leaves: 2,
        tokens: 8,
      },
    },
    {
      body: {
        version: "1.1.0",
        commit: "abc123",
        profile: "server",
        schema_version: "v3",
        features: ["memory", "mcp"],
      },
    },
    {
      body: { is_ready: true, status: "ok", reason: null },
    },
    {
      body: {
        report_id: "r-1",
        chunks_ingested: 4,
        warnings: [],
        schema_version: "v1",
        queue_depth: 2,
      },
    },
  ];
  const { fetch, calls } = mockFetch(queue);
  const relata = new RelataClient({
    baseUrl: "http://x",
    defaultPurpose: "analytics",
    fetch,
  });

  const stats = await relata.stats();
  assert.equal(stats.records, 10);
  assert.equal(stats.states, 100);
  assert.equal(stats.tokens, 8);

  const version = await relata.version();
  assert.equal(version.version, "1.1.0");
  assert.equal(version.commit, "abc123");
  assert.deepEqual(version.features, ["memory", "mcp"]);

  const ready = await relata.ready();
  assert.equal(ready.isReady, true);
  assert.equal(ready.status, "ok");

  const ingest = await relata.ingestDocument(
    `{"chunk": 1}\n{"chunk": 2}`,
    `{"schema": "v1"}`,
  );
  assert.equal(ingest.reportId, "r-1");
  assert.equal(ingest.chunksIngested, 4);
  assert.equal(ingest.queueDepth, 2);

  // Verify the paths
  assert.equal(calls[0]?.url, "http://x/debug/stats");
  assert.equal(calls[1]?.url, "http://x/version");
  assert.equal(calls[2]?.url, "http://x/health/ready");
  assert.equal(calls[3]?.url, "http://x/ingest/document");
  // Verify the ingest payload
  assert.deepEqual(JSON.parse(calls[3]?.body ?? "{}"), {
    chunks_jsonl: `{"chunk": 1}\n{"chunk": 2}`,
    manifest_json: `{"schema": "v1"}`,
  });
});

test("transport: auto-generates X-Request-ID per request", async () => {
  const { fetch, calls } = mockFetch([
    { body: { status: "ok", profile: "free", node_id: "n1" } },
    { body: { status: "ok", profile: "free", node_id: "n1" } },
  ]);
  const relata = new RelataClient({ baseUrl: "http://x", fetch });
  await relata.health();
  await relata.health();
  const r1 = calls[0]?.headers["x-request-id"];
  const r2 = calls[1]?.headers["x-request-id"];
  assert.ok(typeof r1 === "string" && r1.length > 0, "first request id present");
  assert.ok(typeof r2 === "string" && r2.length > 0, "second request id present");
  assert.notEqual(r1, r2, "request ids should differ per attempt");
});

test("transport: caller-supplied X-Request-ID is respected", async () => {
  const { fetch, calls } = mockFetch({
    body: { status: "ok", profile: "free", node_id: "n1" },
  });
  const relata = new RelataClient({
    baseUrl: "http://x",
    fetch,
    headers: { "X-Request-ID": "pinned-abc" },
  });
  await relata.health();
  assert.equal(calls[0]?.headers["x-request-id"], "pinned-abc");
});

test("transport: tenant / actingAs / delegatedBy become request headers", async () => {
  const { fetch, calls } = mockFetch({
    body: { status: "ok", profile: "free", node_id: "n1" },
  });
  const relata = new RelataClient({
    baseUrl: "http://x",
    fetch,
    tenant: "acme",
    actingAs: "user-bob",
    delegatedBy: "user-alice",
  });
  await relata.health();
  assert.equal(calls[0]?.headers["x-organization-id"], "acme");
  assert.equal(calls[0]?.headers["x-acting-as"], "user-bob");
  assert.equal(calls[0]?.headers["x-delegated-by"], "user-alice");
});

test("retry: retries on 503 then succeeds", async () => {
  const { fetch, calls } = mockFetch([
    { status: 503, body: { error: "shedding" } },
    { status: 503, body: { error: "shedding" } },
    { body: { status: "ok", profile: "free", node_id: "n1" } },
  ]);
  const relata = new RelataClient({
    baseUrl: "http://x",
    fetch,
    maxRetries: 3,
    retryBackoffMs: 1, // fast for tests
  });
  const result = await relata.health();
  assert.equal(result.status, "ok");
  assert.equal(calls.length, 3, "should have retried twice then succeeded");
});

test("retry: does NOT retry on 401 (non-retryable)", async () => {
  const { fetch, calls } = mockFetch([
    { status: 401, body: { error: "invalid token" } },
  ]);
  const relata = new RelataClient({
    baseUrl: "http://x",
    fetch,
    maxRetries: 3,
    retryBackoffMs: 1,
  });
  await assert.rejects(
    () => relata.health(),
    (err: unknown) => err instanceof AuthError,
  );
  assert.equal(calls.length, 1, "should NOT retry on 401");
});

test("retry: retries on network errors (raw throw) then succeeds", async () => {
  let attempt = 0;
  const calls: unknown[] = [];
  const fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    attempt++;
    calls.push({ url: url.toString(), attempt });
    if (attempt < 3) {
      throw new TypeError("connect ECONNREFUSED");
    }
    return new Response(
      JSON.stringify({ status: "ok", profile: "free", node_id: "n1" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  const relata = new RelataClient({
    baseUrl: "http://x",
    fetch,
    maxRetries: 3,
    retryBackoffMs: 1,
  });
  const result = await relata.health();
  assert.equal(result.status, "ok");
  assert.equal(attempt, 3, "should have retried twice then succeeded");
});

test("RFC 7807: NotFoundError (404) carries code + requestId", async () => {
  const { fetch } = mockFetch({
    status: 404,
    body: {
      type: "https://relata.dev/errors/not-found",
      title: "Not Found",
      code: "RELATA.QUERY.OBJECT_NOT_FOUND",
      detail: "Object 'person-xyz' does not exist",
      retryable: false,
      request_id: "req-9",
    },
    headers: { "x-request-id": "req-9" },
  });
  const relata = new RelataClient({
    baseUrl: "http://x",
    defaultPurpose: "analytics",
    fetch,
  });
  await assert.rejects(
    () => relata.query("SELECT * FROM Person WHERE id = 'person-xyz'"),
    (err: unknown) => {
      assert.ok(err instanceof NotFoundError);
      const e = err as NotFoundError;
      assert.equal(e.code, "RELATA.QUERY.OBJECT_NOT_FOUND");
      assert.equal(e.typeUrl, "https://relata.dev/errors/not-found");
      assert.equal(e.retryable, false);
      assert.equal(e.requestId, "req-9");
      assert.match(e.message, /person-xyz/);
      return true;
    },
  );
});

test("RFC 7807: ConflictError (409) + ValidationError (422) classification", async () => {
  // 409
  const f1 = mockFetch({
    status: 409,
    body: { detail: "version conflict", code: "RELATA.VERSION_CONFLICT" },
  });
  const r1 = new RelataClient({ baseUrl: "http://x", defaultPurpose: "p", fetch: f1.fetch });
  await assert.rejects(
    () => r1.query("SELECT * FROM Person"),
    (err: unknown) => err instanceof ConflictError,
  );
  // 422
  const f2 = mockFetch({
    status: 422,
    body: { detail: "field required", code: "RELATA.VALIDATION" },
  });
  const r2 = new RelataClient({ baseUrl: "http://x", defaultPurpose: "p", fetch: f2.fetch });
  await assert.rejects(
    () => r2.query("SELECT * FROM Person"),
    (err: unknown) => err instanceof ValidationError,
  );
});

test("RFC 7807: RateLimitedError (429) surfaces retryAfter from header", async () => {
  const { fetch } = mockFetch({
    status: 429,
    body: { detail: "quota exhausted", code: "RELATA.QUOTA" },
    headers: { "retry-after": "30" },
  });
  const relata = new RelataClient({
    baseUrl: "http://x",
    defaultPurpose: "p",
    fetch,
  });
  await assert.rejects(
    () => relata.query("SELECT * FROM Person"),
    (err: unknown) => {
      assert.ok(err instanceof RateLimitedError);
      assert.ok(err instanceof RelataError);
      // QuotaError is the parent of RateLimitedError
      const e = err as RateLimitedError;
      assert.equal(e.retryAfterSeconds, 30);
      return true;
    },
  );
});

test("RFC 7807: 400 with 'purpose' in detail surfaces PurposeError", async () => {
  const { fetch } = mockFetch({
    status: 400,
    body: {
      detail: "purpose is required",
      code: "RELATA.QUERY.PURPOSE_REQUIRED",
    },
  });
  const relata = new RelataClient({
    baseUrl: "http://x",
    defaultPurpose: "p",
    fetch,
  });
  await assert.rejects(
    () => relata.query("SELECT * FROM Person"),
    (err: unknown) => err instanceof PurposeError,
  );
});

test("RFC 7807: 5xx with retryable=true surfaces ServerError carrying retryable", async () => {
  const { fetch } = mockFetch({
    status: 502,
    body: { detail: "bad gateway", retryable: true },
  });
  const relata = new RelataClient({
    baseUrl: "http://x",
    defaultPurpose: "p",
    fetch,
    maxRetries: 0, // don't retry — just classify
  });
  await assert.rejects(
    () => relata.query("SELECT * FROM Person"),
    (err: unknown) => {
      assert.ok(err instanceof ServerError);
      assert.equal((err as ServerError).retryable, true);
      return true;
    },
  );
});

test("createClient: factory wires options through to RelataClient", async () => {
  const { fetch, calls } = mockFetch({
    body: { status: "ok", profile: "free", node_id: "n1" },
  });
  const relata = createClient("http://x/", {
    bearerToken: "tok",
    defaultPurpose: "p",
    tenant: "t",
    fetch,
  });
  await relata.health();
  assert.equal(calls[0]?.url, "http://x/health", "trailing slash stripped");
  assert.equal(calls[0]?.headers["authorization"], "Bearer tok");
  assert.equal(calls[0]?.headers["x-organization-id"], "t");
});
