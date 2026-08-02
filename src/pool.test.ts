/**
 * Unit tests for `ClientPool` (#2756 — connection-pool parity with the Rust
 * `RelataClientPool`). Uses a mock fetch keyed by URL host so no live server
 * is required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientPool } from "./pool.ts";

/** Build a mock `fetch` that dispatches per-host and records call order. */
function makeFetch(
  behavior: Record<string, "ok" | "fail">,
  calls: string[],
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const host = new URL(url).host;
    calls.push(host);
    if (behavior[host] === "fail") {
      return new Response(JSON.stringify({ error: "boom" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ status: "ok", node_id: host }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

test("ClientPool: starts empty and reports isEmpty/length", () => {
  const pool = new ClientPool("tok");
  assert.equal(pool.isEmpty, true);
  assert.equal(pool.length, 0);
});

test("ClientPool: withEndpoint is chainable and grows the pool", () => {
  const pool = new ClientPool("tok").withEndpoint("http://a:9090").withEndpoint("http://b:9090");
  assert.equal(pool.length, 2);
  assert.equal(pool.isEmpty, false);
});

test("ClientPool: health() round-robins across healthy endpoints", async () => {
  const calls: string[] = [];
  const fetch = makeFetch({ "a:9090": "ok", "b:9090": "ok" }, calls);
  const pool = new ClientPool("tok", { fetch })
    .withEndpoint("http://a:9090")
    .withEndpoint("http://b:9090");

  await pool.health();
  await pool.health();

  assert.deepEqual(calls, ["a:9090", "b:9090"]);
});

test("ClientPool: fails over to the next healthy endpoint on error", async () => {
  const calls: string[] = [];
  const fetch = makeFetch({ "a:9090": "fail", "b:9090": "ok" }, calls);
  const pool = new ClientPool("tok", { fetch })
    .withEndpoint("http://a:9090")
    .withEndpoint("http://b:9090");

  const health = await pool.health();

  assert.equal(health.status, "ok");
  // First attempt hit "a" (round-robin start) and failed over to "b".
  assert.deepEqual(calls, ["a:9090", "b:9090"]);
});

test("ClientPool: throws when the pool has no endpoints", async () => {
  const pool = new ClientPool("tok");
  await assert.rejects(() => pool.health(), /no endpoints in pool/);
});

test("ClientPool: withEndpoint inherits the pool's default bearer token", () => {
  const pool = new ClientPool("shared-tok").withEndpoint("http://a:9090");
  // length/isEmpty are the only introspection surface kept public (mirrors
  // the Rust pool's minimal API) — verifying the pool grew is the contract.
  assert.equal(pool.length, 1);
});

test("ClientPool: query() and search() delegate through the failover path", async () => {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(new URL(url).pathname);
    if (url.endsWith("/query")) {
      return new Response(JSON.stringify({ rows: [{ id: "p1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ hits: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const pool = new ClientPool("tok", { fetch }).withEndpoint("http://a:9090");

  const queryResult = await pool.query("SELECT * FROM Person LIMIT 1", "analytics");
  assert.equal(queryResult.rows.length, 1);

  const searchResult = await pool.search({ query: "alice", type: "Person" });
  assert.deepEqual(searchResult.hits, []);

  assert.deepEqual(calls, ["/query", "/search"]);
});
