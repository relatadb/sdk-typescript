/**
 * `RelataClient.ingest` must send the `object_type` query parameter the server
 * requires (`POST /v1/ingest` answers 400 "object_type query param required"
 * without it); found by the live real-use-case sweep (sdks/typescript/tests/real).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { RelataClient } from "./index.ts";

function recorder(): { fetch: typeof globalThis.fetch; urls: string[]; bodies: string[] } {
  const urls: string[] = [];
  const bodies: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ rows_queued: 2, rows_rejected: 0, task_id: "itsk_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, urls, bodies };
}

test("ingest: explicit objectType and purpose go on the query string", async () => {
  const r = recorder();
  const c = new RelataClient({ baseUrl: "http://x", fetch: r.fetch, defaultPurpose: "p1" });
  const out = await c.ingest([{ _pk: "a" }, { _pk: "b" }], { objectType: "Host" });
  assert.equal(out.task_id, "itsk_1");
  const u = new URL(r.urls[0]!);
  assert.equal(u.pathname, "/v1/ingest");
  assert.equal(u.searchParams.get("object_type"), "Host");
  assert.equal(u.searchParams.get("purpose"), "p1");
  assert.deepEqual(JSON.parse(r.bodies[0]!), { objects: [{ _pk: "a" }, { _pk: "b" }] });
});

test("ingest: a uniform _type is used when objectType is omitted", async () => {
  const r = recorder();
  const c = new RelataClient({ baseUrl: "http://x", fetch: r.fetch });
  await c.ingest([{ _type: "Host", _pk: "a" }, { _type: "Host", _pk: "b" }]);
  assert.equal(new URL(r.urls[0]!).searchParams.get("object_type"), "Host");
});

test("ingest: mixed or missing _type fails before any request is made", async () => {
  const r = recorder();
  const c = new RelataClient({ baseUrl: "http://x", fetch: r.fetch });
  await assert.rejects(c.ingest([{ _type: "A", _pk: "1" }, { _type: "B", _pk: "2" }]), /objectType/);
  await assert.rejects(c.ingest([{ _pk: "1" }]), /objectType/);
  assert.equal(r.urls.length, 0);
});
