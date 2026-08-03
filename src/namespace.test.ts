/**
 * Tests for the `Namespace` handle (#2491) and the schema-BRANCH CRUD +
 * edge-type registry (#2497). Uses Node's built-in `node:test` runner with
 * an injected `fetch` mock (no real HTTP).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { RelataClient } from "./client.ts";
import { Namespace, validateNamespaceName } from "./namespace.ts";

// ---------------------------------------------------------------------------
// Mock fetch — returns the supplied responses in order.
// ---------------------------------------------------------------------------

interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

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
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: urlString,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? (init.body as string) : undefined,
    });
    const next = queue.shift() ?? { status: 200, body: {} };
    const status = next.status ?? 200;
    const headerMap = new Headers();
    for (const [k, v] of Object.entries(next.headers ?? {})) headerMap.set(k, v);
    headerMap.set(
      "content-type",
      headerMap.get("content-type") ??
        (status >= 400 ? "application/problem+json" : "application/json"),
    );
    const bodyText = JSON.stringify(next.body ?? {});
    return new Response(bodyText, { status, headers: headerMap });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

// ---------------------------------------------------------------------------
// #2491 — Namespace
// ---------------------------------------------------------------------------

test("Namespace: rejects invalid names before hitting the wire", () => {
  for (const bad of ["", "1bad", "has-dash", "has space", "has.dot", "has/slash"]) {
    assert.throws(() => validateNamespaceName(bad), /invalid namespace/);
  }
  for (const ok of ["Document", "_doc", "A1", "Person_2"]) {
    validateNamespaceName(ok);
  }
});

test("Namespace: factory relata.namespace(name) binds the name + shares transport", () => {
  const relata = new RelataClient({ baseUrl: "http://x", defaultPurpose: "rag" });
  const docs = relata.namespace("Document");
  assert.equal(docs.name, "Document");
  // Same parent client → shared transport / auth / tenant context.
});

test("Namespace.query: forwards to POST /search with the bound name", async () => {
  const { fetch, calls } = mockFetch({
    body: {
      rows: [{ id: "d1", title: "graph retrieval" }],
      queryId: "q1",
      elapsedMs: 3,
      rowCount: 1,
    },
  });
  const relata = new RelataClient({ baseUrl: "http://x", defaultPurpose: "rag", fetch });
  const docs = relata.namespace("Document");
  const result = await docs.query<{ id: string }>({ text: "graph retrieval", limit: 5 });
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0]?.id, "d1");
  const sent = JSON.parse(calls[0]?.body ?? "{}");
  assert.equal(sent.from, "Document");
  assert.equal(sent.limit, 5);
  assert.deepEqual(sent.rank_by, ["bm25", "*", "graph retrieval"]);
  assert.equal(calls[0]?.url, "http://x/search");
});

test("Namespace.write: schemaless upsert POSTs to /ingest/auto with object_type", async () => {
  const { fetch, calls } = mockFetch({
    body: { type_created: true, inferred_schema: { title: "text" } },
  });
  const relata = new RelataClient({ baseUrl: "http://x", defaultPurpose: "rag", fetch });
  const docs = relata.namespace("Document");
  const out = await docs.write(
    [{ id: "d1", title: "Knowledge graphs 101" }],
    { schema: { title: "text" } },
  );
  assert.equal(out["type_created"], true);
  const sent = JSON.parse(calls[0]?.body ?? "{}");
  assert.equal(sent.object_type, "Document");
  assert.deepEqual(sent.rows, [{ id: "d1", title: "Knowledge graphs 101" }]);
  assert.deepEqual(sent.schema, { title: "text" });
  assert.equal(sent.purpose, "rag", "inherits parent default purpose");
  assert.equal(calls[0]?.url, "http://x/ingest/auto");
});

test("Namespace.get: issues SELECT * FROM <Name> WHERE id = $1 LIMIT 1 with bound param", async () => {
  const { fetch, calls } = mockFetch({
    body: { data: [{ id: "d1", title: "Knowledge graphs 101" }], query_id: "q", elapsed_ms: 1 },
  });
  const relata = new RelataClient({ baseUrl: "http://x", defaultPurpose: "rag", fetch });
  const docs = relata.namespace("Document");
  const row = await docs.get<{ id: string }>("d1");
  assert.equal(row?.id, "d1");
  const sent = JSON.parse(calls[0]?.body ?? "{}");
  // #3211: the id is bound as a server-side $1 parameter, never interpolated.
  assert.equal(
    sent.sql,
    "SELECT * FROM Document WHERE id = $1 LIMIT 1",
  );
  assert.deepEqual(sent.params, ["d1"]);
  // A quote-laden id is passed as a bound parameter, not escaped into the SQL.
  const { fetch: f2, calls: calls2 } = mockFetch({ body: { data: [] } });
  const r2 = new RelataClient({ baseUrl: "http://x", defaultPurpose: "rag", fetch: f2 });
  const miss = await r2.namespace("Document").get("o'malley");
  assert.equal(miss, null);
  const sent2 = JSON.parse(calls2[0]?.body ?? "{}");
  assert.equal(sent2.sql, "SELECT * FROM Document WHERE id = $1 LIMIT 1");
  assert.deepEqual(sent2.params, ["o'malley"]);
});

test("Namespace.get: returns null when no rows", async () => {
  const { fetch } = mockFetch({ body: { data: [] } });
  const relata = new RelataClient({ baseUrl: "http://x", defaultPurpose: "rag", fetch });
  const docs = relata.namespace("Document");
  const row = await docs.get("missing");
  assert.equal(row, null);
});

test("Namespace.deleteAll: selects ids then writes _deleted tombstones via /ingest/auto", async () => {
  const { fetch, calls } = mockFetch([
    { body: { data: [{ id: "d1" }, { id: "d2" }], query_id: "q", elapsed_ms: 1 } },
    { body: { type_created: false } },
  ]);
  const relata = new RelataClient({ baseUrl: "http://x", defaultPurpose: "rag", fetch });
  const docs = relata.namespace("Document");
  const out = await docs.deleteAll();
  assert.deepEqual(out, { deleted: 2 });
  // First call: SELECT id FROM Document
  assert.equal(JSON.parse(calls[0]?.body ?? "{}").sql, "SELECT id FROM Document");
  // Second call: tombstones through /ingest/auto
  assert.equal(calls[1]?.url, "http://x/ingest/auto");
  const sent = JSON.parse(calls[1]?.body ?? "{}");
  assert.equal(sent.object_type, "Document");
  assert.deepEqual(sent.rows, [
    { id: "d1", _deleted: true },
    { id: "d2", _deleted: true },
  ]);
});

test("Namespace.deleteAll: short-circuits with {deleted: 0} when empty", async () => {
  const { fetch, calls } = mockFetch({
    body: { data: [], query_id: "q", elapsed_ms: 1 },
  });
  const relata = new RelataClient({ baseUrl: "http://x", defaultPurpose: "rag", fetch });
  const docs = relata.namespace("Document");
  const out = await docs.deleteAll();
  assert.deepEqual(out, { deleted: 0 });
  assert.equal(calls.length, 1, "only the SELECT — no tombstone POST");
});

test("Namespace.branchFrom: POSTs {from} to /v1/namespaces/:name/branch", async () => {
  const { fetch, calls } = mockFetch({ body: { branched: true } });
  const relata = new RelataClient({ baseUrl: "http://x", defaultPurpose: "rag", fetch });
  const docs = relata.namespace("Document_v2");
  const out = await docs.branchFrom("Document", { purpose: "rag" });
  assert.equal(out["branched"], true);
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url, "http://x/v1/namespaces/Document_v2/branch");
  const sent = JSON.parse(calls[0]?.body ?? "{}");
  assert.equal(sent.from, "Document");
  assert.equal(sent.purpose, "rag");
});

test("Namespace.branchFrom: rejects an invalid source name", async () => {
  const { fetch } = mockFetch({ body: {} });
  const relata = new RelataClient({ baseUrl: "http://x", defaultPurpose: "rag", fetch });
  const docs = relata.namespace("Document");
  await assert.rejects(() => docs.branchFrom("bad-name"), /invalid namespace/);
});

// ---------------------------------------------------------------------------
// #2497 — schema-BRANCH CRUD + edge-type registry
// ---------------------------------------------------------------------------

test("createSchemaBranch: POSTs {from} to /schema/branches/:name (#2497)", async () => {
  const { fetch, calls } = mockFetch({ body: { created: true } });
  const relata = new RelataClient({ baseUrl: "http://x", fetch });
  const out = await relata.createSchemaBranch("exp-1", "main");
  assert.equal(out["created"], true);
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url, "http://x/schema/branches/exp-1");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), { from: "main" });
});

test("createSchemaBranch: url-encodes the branch name (#2497)", async () => {
  const { fetch, calls } = mockFetch({ body: {} });
  const relata = new RelataClient({ baseUrl: "http://x", fetch });
  // Valid namespace chars only — but encode the special ones defensively.
  await relata.createSchemaBranch("a b/c", "main");
  assert.equal(calls[0]?.url, "http://x/schema/branches/a%20b%2Fc");
});

test("deleteSchemaBranch: DELETE /schema/branches/:name (#2497)", async () => {
  const { fetch, calls } = mockFetch({ body: { deleted: true } });
  const relata = new RelataClient({ baseUrl: "http://x", fetch });
  const out = await relata.deleteSchemaBranch("exp-1");
  assert.equal(out["deleted"], true);
  assert.equal(calls[0]?.method, "DELETE");
  assert.equal(calls[0]?.url, "http://x/schema/branches/exp-1");
});

test("listEdgeTypes: GET /types/edges (#2497)", async () => {
  const { fetch, calls } = mockFetch({
    body: { edges: [{ from_type: "Person", to_type: "Document", label: "authored" }] },
  });
  const relata = new RelataClient({ baseUrl: "http://x", fetch });
  const out = await relata.listEdgeTypes();
  assert.deepEqual(out["edges"], [
    { from_type: "Person", to_type: "Document", label: "authored" },
  ]);
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.url, "http://x/types/edges");
});

test("registerEdgeType: POSTs {from_type, to_type, label} to /types/edges (#2497)", async () => {
  const { fetch, calls } = mockFetch({ body: { registered: true } });
  const relata = new RelataClient({ baseUrl: "http://x", fetch });
  const out = await relata.registerEdgeType("Person", "Document", "authored");
  assert.equal(out["registered"], true);
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url, "http://x/types/edges");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    from_type: "Person",
    to_type: "Document",
    label: "authored",
  });
});
