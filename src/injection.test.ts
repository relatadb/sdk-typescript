/**
 * #3211 — SQL-injection regression tests (TypeScript mirror).
 *
 * Every payload feeds the characters `'`, `;`, `--`, `)` into object_type /
 * embedding_slot / values and asserts a client-side rejection (identifiers,
 * metric) or a safely contained value (escaped literal / bound parameter)
 * before any HTTP call reaches the server.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RelataClient } from "./client.ts";
import { VectorClient, buildHybridSearchSql } from "./vectors.ts";
import { ValidationError } from "./errors.ts";

function mockFetch() {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof url === "string" ? url : url.toString(),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const headerMap = new Headers();
    headerMap.set("content-type", "application/json");
    return new Response(JSON.stringify({ data: [], query_id: "q", elapsed_ms: 1 }), {
      status: 200,
      headers: headerMap,
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const PAYLOADS = ["'", ";", "--", ")", "Person'; DROP TABLE Person; --", "x') OR ('1'='1"];

function makeClient(fetch: typeof globalThis.fetch): RelataClient {
  return new RelataClient({ baseUrl: "http://x", defaultPurpose: "analytics", fetch });
}

test("injection: knnSearch rejects bad object_type before any HTTP call", async () => {
  const { fetch, calls } = mockFetch();
  const v = new VectorClient(makeClient(fetch));
  for (const p of PAYLOADS) {
    await assert.rejects(() => v.knnSearch(p, "_emb", [0.1]), ValidationError);
  }
  assert.equal(calls.length, 0, "no HTTP call must be made");
});

test("injection: knnSearch rejects bad embedding_slot before any HTTP call", async () => {
  const { fetch, calls } = mockFetch();
  const v = new VectorClient(makeClient(fetch));
  for (const p of PAYLOADS) {
    await assert.rejects(() => v.knnSearch("Person", p, [0.1]), ValidationError);
  }
  assert.equal(calls.length, 0, "no HTTP call must be made");
});

test("injection: hybridSearch rejects bad object_type before any HTTP call", async () => {
  const { fetch, calls } = mockFetch();
  const v = new VectorClient(makeClient(fetch));
  for (const p of PAYLOADS) {
    await assert.rejects(() => v.hybridSearch(p, { queryText: "q" }), ValidationError);
  }
  assert.equal(calls.length, 0, "no HTTP call must be made");
});

test("injection: hybridSearch rejects bad metric before any HTTP call", async () => {
  const { fetch, calls } = mockFetch();
  const v = new VectorClient(makeClient(fetch));
  for (const m of ["cosine; DROP TABLE x", "l2--", "dotproduct)", "'"]) {
    await assert.rejects(
      () => v.hybridSearch("Person", { queryText: "q", metric: m }),
      ValidationError,
    );
  }
  assert.equal(calls.length, 0, "no HTTP call must be made");
});

test("injection: buildHybridSearchSql allowlists metric", () => {
  for (const m of ["cosine", "l2", "dotproduct"]) {
    assert.ok(buildHybridSearchSql("Person", "q", { metric: m }).includes(`METRIC ${m}`));
  }
  assert.throws(() => buildHybridSearchSql("Person", "q", { metric: "cosine--" }), ValidationError);
});

test("injection: similarTo rejects bad object_type, binds referenceId", async () => {
  const { fetch, calls } = mockFetch();
  const v = new VectorClient(makeClient(fetch));
  for (const p of PAYLOADS) {
    await assert.rejects(() => v.similarTo(p, "ref-1"), ValidationError);
  }
  assert.equal(calls.length, 0, "no HTTP call must be made");

  // A valid object_type passes and the referenceId is bound as $1.
  const payload = "x'); DROP TABLE Person; --";
  await v.similarTo("Person", payload);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]?.body ?? "{}");
  assert.ok(!body.sql.includes(payload), "payload must not appear in the SQL text");
  assert.ok(!body.sql.includes("DROP TABLE"), "payload must not appear in the SQL text");
  assert.deepEqual(body.params, [payload]);
});

test("injection: eraseSubject escapes the value into a contained literal", async () => {
  const { fetch, calls } = mockFetch();
  const relata = makeClient(fetch);
  const payload = "subj'); DROP TABLE Person; --";
  await relata.eraseSubject(payload, "reason");
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]?.body ?? "{}");
  assert.ok(!body.sql.includes(payload), "raw payload must not appear in the SQL");
  // The escaped form keeps the payload inside a single literal.
  assert.ok(body.sql.includes("subj\\'); DROP TABLE Person; --"));
});

test("injection: resolveIdentity escapes the value into a contained literal", async () => {
  const { fetch, calls } = mockFetch();
  const relata = makeClient(fetch);
  const payload = "a'); DROP TABLE Person; --";
  await relata.resolveIdentity(payload);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]?.body ?? "{}");
  assert.ok(!body.sql.includes(payload), "raw payload must not appear in the SQL");
});

test("injection: select(...).execute rejects a bad FROM identifier", async () => {
  const { fetch, calls } = mockFetch();
  const relata = makeClient(fetch);
  for (const p of PAYLOADS) {
    await assert.rejects(() => relata.select(p).execute(), ValidationError);
  }
  assert.equal(calls.length, 0, "no HTTP call must be made");
});

test("injection: pathsBetween escapes node ids into contained literals", async () => {
  const { fetch, calls } = mockFetch();
  const relata = makeClient(fetch);
  const payload = "a'); DROP TABLE Person; --";
  await relata.select("Person").pathsBetween(payload, "b", { maxHops: 3 }).purpose("analytics").execute();
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]?.body ?? "{}");
  assert.ok(!body.sql.includes(payload), "raw payload must not appear in the SQL");
});
