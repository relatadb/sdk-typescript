/**
 * Unit tests for ObjectClient.get / .delete / .list (#1171).
 * Uses a mock fetch so no live server is required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectClient } from "./objects.ts";
import { PreconditionFailedError } from "./errors.ts";

function makeClient(
  responses: Array<{ status: number; body: unknown }>,
): ObjectClient {
  let idx = 0;
  const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
    const r = responses[idx++] ?? { status: 500, body: { error: "no more mocks" } };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  };

  return new ObjectClient({
    baseUrl: "http://localhost:9090",
    bearerToken: "test-token",
    fetch: fakeFetch as typeof globalThis.fetch,
  });
}

test("ObjectClient.get: returns the object when found", async () => {
  const obj = { id: "p1", name: "Alice" };
  const client = makeClient([{ status: 200, body: obj }]);
  const result = await client.get("Person", "p1");
  assert.deepEqual(result, obj);
});

test("ObjectClient.get: returns null for a missing object (404)", async () => {
  const client = makeClient([{ status: 404, body: { error: "not found" } }]);
  const result = await client.get("Person", "missing");
  assert.equal(result, null);
});

test("ObjectClient.delete: returns the delete receipt", async () => {
  const receipt = { deleted: true, id: "p1" };
  const client = makeClient([{ status: 200, body: receipt }]);
  const result = await client.delete("Person", "p1");
  assert.deepEqual(result, receipt);
});

test("ObjectClient.list: returns paginated results", async () => {
  const page = { items: [{ id: "p1" }, { id: "p2" }], cursor: "next", total: 10 };
  const client = makeClient([{ status: 200, body: page }]);
  const result = await client.list("Person", { limit: 2 });
  assert.equal(result.items.length, 2);
  assert.equal(result.cursor, "next");
  assert.equal(result.total, 10);
});

test("ObjectClient.list: returns empty items when none exist", async () => {
  const client = makeClient([{ status: 200, body: { items: [] } }]);
  const result = await client.list("Person");
  assert.deepEqual(result.items, []);
});

test("ObjectClient.get: rethrows non-404 errors", async () => {
  const client = makeClient([{ status: 500, body: { error: "internal error" } }]);
  await assert.rejects(() => client.get("Person", "p1"));
});

// ---- #5766 / #5767: conditional writes and atomic commit bundles ----

function capturingClient(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { client: ObjectClient; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  };
  const client = new ObjectClient({
    baseUrl: "http://localhost:9090",
    bearerToken: "t",
    purpose: "audit",
    fetch: fakeFetch as typeof globalThis.fetch,
  });
  return { client, calls };
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const h = init.headers as Record<string, string>;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : h[key];
}

test("ObjectClient.upsert: ifAbsent sends PUT with If-None-Match: *", async () => {
  const { client, calls } = capturingClient(201, { type: "Doc", id: "a", version: 7 });
  const out = await client.upsert("Doc", "a", { n: "x" }, { ifAbsent: true });
  assert.equal(out["version"], 7);
  assert.equal(calls[0]!.init.method, "PUT");
  assert.ok(calls[0]!.url.endsWith("/objects/Doc/a?purpose=audit"), calls[0]!.url);
  assert.equal(headerOf(calls[0]!.init, "if-none-match"), "*");
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { n: "x" });
});

test("ObjectClient.upsert: expectedVersion sends If-Match and a lost race throws PreconditionFailedError", async () => {
  const { client, calls } = capturingClient(
    412,
    {
      type: "https://relatadb.dev/errors/precondition-failed",
      status: 412,
      detail: "'Doc/a' is at version 42, expected 41",
      code: "precondition-failed",
      current_version: 42,
      failed_operation: 0,
    },
    { ETag: '"42"' },
  );
  await assert.rejects(
    () => client.upsert("Doc", "a", { n: "x" }, { expectedVersion: 41 }),
    (err: unknown) => {
      assert.ok(err instanceof PreconditionFailedError);
      assert.equal(err.statusCode, 412);
      assert.equal(err.currentVersion, 42);
      assert.equal(err.failedOperation, 0);
      assert.equal(err.code, "precondition-failed");
      return true;
    },
  );
  assert.equal(headerOf(calls[0]!.init, "if-match"), '"41"');
});

test("ObjectClient.upsert: the two preconditions are mutually exclusive", async () => {
  const { client } = capturingClient(200, {});
  await assert.rejects(
    () => client.upsert("Doc", "a", {}, { expectedVersion: 1, ifAbsent: true }),
    TypeError,
  );
});

test("ObjectClient.upsert: without a precondition it still uses /ingest", async () => {
  const { client, calls } = capturingClient(200, { rows_queued: 1 });
  await client.upsert("Doc", "a", { n: "x" });
  assert.equal(calls[0]!.init.method, "POST");
  assert.ok(calls[0]!.url.includes("/ingest?"), calls[0]!.url);
});

test("ObjectClient.delete: expectedVersion is a conditional DELETE", async () => {
  const { client, calls } = capturingClient(200, { deleted: true, version: 9, commitId: "c" });
  await client.delete("Doc", "a", { expectedVersion: 8 });
  assert.equal(calls[0]!.init.method, "DELETE");
  assert.equal(headerOf(calls[0]!.init, "if-match"), '"8"');
  const plain = capturingClient(200, { deleted: true });
  await plain.client.delete("Doc", "a");
  assert.equal(headerOf(plain.calls[0]!.init, "if-match"), undefined);
});

test("ObjectClient.get: exposes the monotonic _version", async () => {
  const { client } = capturingClient(200, { id: "a", _version: 5 });
  const row = await client.get("Doc", "a");
  assert.equal(row?.["_version"], 5);
});

test("ObjectClient.commit: posts the bundle with the idempotency key", async () => {
  const { client, calls } = capturingClient(200, {
    commitId: "c1",
    operations: [{ op: "update", type: "Doc", id: "a", version: 3 }],
    replayed: false,
  });
  const out = await client.commit(
    [{ op: "update", type: "Doc", id: "a", expectedVersion: 2, data: { n: "y" } }],
    { idempotencyKey: "k1" },
  );
  assert.equal(out.commitId, "c1");
  assert.equal(calls[0]!.init.method, "POST");
  assert.ok(calls[0]!.url.endsWith("/commit"));
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
    operations: [{ op: "update", type: "Doc", id: "a", expectedVersion: 2, data: { n: "y" } }],
    idempotencyKey: "k1",
    purpose: "audit",
  });
});

test("ObjectClient.commit: a failed bundle reports the failing operation", async () => {
  const { client } = capturingClient(412, {
    status: 412,
    detail: "missing",
    code: "precondition-failed",
    current_version: null,
    failed_operation: 2,
  });
  await assert.rejects(
    () => client.commit([{ op: "delete", type: "Doc", id: "z" }]),
    (err: unknown) => {
      assert.ok(err instanceof PreconditionFailedError);
      assert.equal(err.currentVersion, null);
      assert.equal(err.failedOperation, 2);
      return true;
    },
  );
});
