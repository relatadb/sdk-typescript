/**
 * Tests for `Memory` — add / addBatch / search / get / update / forget +
 * the five cognitive verbs, MCP-envelope unwrapping, and purpose-required
 * validation.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Memory, PurposeError } from "./index.ts";

// ---------------------------------------------------------------------------
// Mock fetch helpers (lowercase header keys to match real fetch semantics)
// ---------------------------------------------------------------------------

interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  bodyText?: string;
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
    const contentType = headerMap.get("content-type") ?? "application/json";
    headerMap.set("content-type", contentType);
    const bodyText =
      next.bodyText ??
      (typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {}));
    return new Response(bodyText, { status, headers: headerMap });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Wrap an inner JSON payload in the MCP envelope. */
function mcpEnvelope(inner: unknown): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(inner) }],
    isError: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Memory: rejects empty purpose at construction", () => {
  assert.throws(
    () => new Memory("http://x", { purpose: "" }),
    (err: unknown) => err instanceof PurposeError,
  );
});

test("Memory: add posts to /memory/remember and returns the id (MCP envelope unwrap)", async () => {
  const { fetch, calls } = mockFetch({ body: mcpEnvelope({ id: "mem-1" }) });
  const m = new Memory("http://x", {
    purpose: "agent-notes",
    bearerToken: "tok",
    fetch,
  });
  const id = await m.add("Alice prefers dark mode");
  assert.equal(id, "mem-1");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url, "http://x/memory/remember");
  assert.equal(calls[0]?.headers["authorization"], "Bearer tok");
  const body = JSON.parse(calls[0]?.body ?? "{}");
  assert.equal(body["content"], "Alice prefers dark mode");
  assert.equal(body["purpose"], "agent-notes");
  assert.equal(body["memory_class"], "semantic");
  assert.equal(body["confidence"], 1.0);
});

test("Memory: addBatch posts items and returns index-aligned ids", async () => {
  const { fetch, calls } = mockFetch({
    body: mcpEnvelope({
      results: [{ id: "a" }, {}, { id: "c" }],
    }),
  });
  const m = new Memory("http://x", { purpose: "p", fetch });
  const ids = await m.addBatch(["first", "second", "third"]);
  assert.deepEqual(ids, ["a", "", "c"]);
  assert.equal(calls[0]?.url, "http://x/memory/remember/batch");
  const body = JSON.parse(calls[0]?.body ?? "{}");
  assert.equal(body["items"].length, 3);
  assert.equal(body["items"][0]["content"], "first");
});

test("Memory: search builds query string + unwraps rows", async () => {
  const { fetch, calls } = mockFetch({
    body: mcpEnvelope({ rows: [{ id: "m1", content: "x", score: 0.9 }] }),
  });
  const m = new Memory("http://x", {
    purpose: "p",
    sessionId: "sess-1",
    fetch,
  });
  const rows = await m.search("hello", { topK: 3 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.["id"], "m1");
  const url = calls[0]?.url ?? "";
  assert.ok(url.startsWith("http://x/memory/recall?"));
  assert.ok(url.includes("q=hello"));
  assert.ok(url.includes("purpose=p"));
  assert.ok(url.includes("top_k=3"));
  assert.ok(url.includes("session_id=sess-1"));
});

test("Memory: search sends ADR-145 retrieval-quality params", async () => {
  // #2674: CONFIDENCE/RECENCY/BUDGET/FORGETTING_CURVE/CANCEL_WHEN must be
  // reachable as query params on GET /memory/recall.
  const { fetch, calls } = mockFetch({
    body: mcpEnvelope({ rows: [] }),
  });
  const m = new Memory("http://x", { purpose: "p", fetch });
  await m.search("hello", {
    minConfidence: 0.6,
    recencyHalfLifeSecs: 3600,
    budgetTokens: 500,
    stabilityDays: 7,
    cancelThreshold: 0.95,
  });
  const url = calls[0]?.url ?? "";
  assert.ok(url.includes("min_confidence=0.6"));
  assert.ok(url.includes("recency_half_life_secs=3600"));
  assert.ok(url.includes("budget_tokens=500"));
  assert.ok(url.includes("stability_days=7"));
  assert.ok(url.includes("cancel_threshold=0.95"));
});

test("Memory: search omits ADR-145 params when unset", async () => {
  const { fetch, calls } = mockFetch({ body: mcpEnvelope({ rows: [] }) });
  const m = new Memory("http://x", { purpose: "p", fetch });
  await m.search("hello");
  const url = calls[0]?.url ?? "";
  for (const key of [
    "min_confidence",
    "recency_half_life_secs",
    "budget_tokens",
    "stability_days",
    "cancel_threshold",
  ]) {
    assert.ok(!url.includes(key), `unexpected ${key} in ${url}`);
  }
});

test("Memory: searchDetailed surfaces recall_cost_tokens and cancelled", async () => {
  // #2674: the read-only BUDGET/CANCEL_WHEN response fields must be
  // observable, not just settable.
  const { fetch } = mockFetch({
    body: mcpEnvelope({
      rows: [{ id: "a" }],
      recall_cost_tokens: 42,
      cancelled: true,
    }),
  });
  const m = new Memory("http://x", { purpose: "p", fetch });
  const result = await m.searchDetailed("hello", { budgetTokens: 50, cancelThreshold: 0.9 });
  assert.equal(result["recall_cost_tokens"], 42);
  assert.equal(result["cancelled"], true);
});

test("Memory: get returns null when memory field is absent", async () => {
  const { fetch } = mockFetch({ body: mcpEnvelope({ other: "x" }) });
  const m = new Memory("http://x", { purpose: "p", fetch });
  const result = await m.get("mem-404");
  assert.equal(result, null);
});

test("Memory: get returns the memory dict when present", async () => {
  const { fetch } = mockFetch({
    body: mcpEnvelope({ memory: { id: "m1", content: "hi" } }),
  });
  const m = new Memory("http://x", { purpose: "p", fetch });
  const result = await m.get("m1");
  assert.deepEqual(result, { id: "m1", content: "hi" });
});

test("Memory: update posts to /memory/consolidate and returns new_id", async () => {
  const { fetch, calls } = mockFetch({
    body: mcpEnvelope({ new_id: "m2" }),
  });
  const m = new Memory("http://x", { purpose: "p", fetch });
  const newId = await m.update("m1", "revised content");
  assert.equal(newId, "m2");
  assert.equal(calls[0]?.url, "http://x/memory/consolidate");
  const body = JSON.parse(calls[0]?.body ?? "{}");
  assert.equal(body["id"], "m1");
  assert.equal(body["content"], "revised content");
});

test("Memory: forget DELETEs /memory/forget/:id?purpose=...", async () => {
  const { fetch, calls } = mockFetch({
    body: mcpEnvelope({ memory_item_id: "m1", policy: "retention", forget_at_ns: 99 }),
  });
  const m = new Memory("http://x", { purpose: "p", fetch });
  const decision = await m.forget("m1");
  assert.equal(calls[0]?.method, "DELETE");
  assert.ok(calls[0]?.url.startsWith("http://x/memory/forget/m1?"));
  assert.ok(calls[0]?.url.includes("purpose=p"));
  assert.equal(decision["policy"], "retention");
});

test("Memory: review POSTs the decision to /memory/review/:id", async () => {
  const { fetch, calls } = mockFetch({
    body: { id: "m1", review_status: "rejected", changed: true },
  });
  const m = new Memory("http://x", { purpose: "p", fetch });
  const out = await m.review("m1", "reject", { reason: "poisoned" });
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url, "http://x/memory/review/m1");
  const body = JSON.parse(calls[0]?.body ?? "{}");
  assert.equal(body["decision"], "reject");
  assert.equal(body["reason"], "poisoned");
  assert.equal(out["review_status"], "rejected");
});

test("Memory: associate posts the server's from_id/to_id fields", async () => {
  const { fetch, calls } = mockFetch({
    body: mcpEnvelope({ source_id: "s", target_id: "t", relation: "causes" }),
  });
  const m = new Memory("http://x", { purpose: "p", fetch });
  await m.associate("s", "t", "causes", { confidence: 0.7 });
  assert.equal(calls[0]?.url, "http://x/memory/associate");
  const body = JSON.parse(calls[0]?.body ?? "{}");
  assert.equal(body["from_id"], "s");
  assert.equal(body["to_id"], "t");
  assert.equal(body["source_id"], undefined);
  assert.equal(body["relation"], "causes");
  assert.equal(body["purpose"], "p");
});

test("Memory: episodes builds query string and returns rows", async () => {
  const { fetch, calls } = mockFetch({
    body: mcpEnvelope({ rows: [{ id: "e1" }, { id: "e2" }] }),
  });
  const m = new Memory("http://x", { purpose: "p", fetch });
  const rows = await m.episodes({ sessionId: "sess-7", asOf: "2025-01-01" });
  assert.equal(rows.length, 2);
  assert.ok(calls[0]?.url.includes("/memory/episodes?"));
  assert.ok(calls[0]?.url.includes("session_id=sess-7"));
  assert.ok(calls[0]?.url.includes("as_of=2025-01-01"));
});

test("Memory: justify, resolve, summarise hit the right paths", async () => {
  const queue = [
    { body: mcpEnvelope({ chain: [] }) }, // justify
    { body: mcpEnvelope({ resolved_id: "m1-head" }) }, // resolve
    { body: mcpEnvelope({ id: "sum-1" }) }, // summarise
  ];
  const { fetch, calls } = mockFetch(queue);
  const m = new Memory("http://x", { purpose: "p", fetch });

  const j = await m.justify("m1");
  assert.deepEqual(j["chain"], []);

  const r = await m.resolve("m1");
  assert.equal(r["resolved_id"], "m1-head");

  const s = await m.summarise(["a", "b"], { summaryContent: "the summary" });
  assert.equal(s["id"], "sum-1");

  assert.ok(calls[0]?.url.startsWith("http://x/memory/justify/m1?"));
  // resolve() must be a GET with the purpose in the query string, not a POST
  // with a JSON body — the server route is GET-only (#2675).
  assert.equal(calls[1]?.method, "GET");
  assert.ok(calls[1]?.url.startsWith("http://x/memory/resolve/m1?"));
  assert.ok(calls[1]?.url.includes("purpose=p"));
  assert.equal(calls[1]?.body, undefined);
  assert.equal(calls[2]?.url, "http://x/memory/summarise");

  const summariseBody = JSON.parse(calls[2]?.body ?? "{}");
  assert.deepEqual(summariseBody["ids"], ["a", "b"]);
  assert.deepEqual(summariseBody["contents"], ["the summary"]);
});

test("Memory: close is a no-op that resolves", async () => {
  const m = new Memory("http://x", { purpose: "p", fetch: globalThis.fetch });
  await m.close(); // should not throw
});

test("Memory: each request carries a fresh X-Request-ID", async () => {
  const { fetch, calls } = mockFetch([
    { body: mcpEnvelope({ id: "m1" }) },
    { body: mcpEnvelope({ id: "m2" }) },
  ]);
  const m = new Memory("http://x", { purpose: "p", fetch });
  await m.add("one");
  await m.add("two");
  assert.notEqual(
    calls[0]?.headers["x-request-id"],
    calls[1]?.headers["x-request-id"],
  );
});

test("Memory: percent-encodes memoryId in path segments", async () => {
  const { fetch, calls } = mockFetch({
    body: mcpEnvelope({ memory_item_id: "m/with space" }),
  });
  const m = new Memory("http://x", { purpose: "p", fetch });
  await m.forget("m/with space");
  // The encoded path should contain %2F and %20
  assert.ok(calls[0]?.url.includes("/memory/forget/m%2Fwith%20space?"));
});


test("memory errors retain required problem and Retry-After metadata", async () => {
  const { MemoryHttpError } = await import("./memory.ts");
  const problem = { detail: "quota exceeded", code: "quota", type: "urn:relata:quota",
    retryable: true, query_id: "memory-query" };
  const memory = new Memory("http://x", { purpose: "p",
    fetch: (async () => new Response(JSON.stringify(problem), { status: 429,
      headers: { "content-type": "application/problem+json", "Retry-After": "11",
        "x-request-id": "memory-request" } })) as typeof globalThis.fetch });
  await assert.rejects(() => memory.add("payload"), (error: unknown) => {
    assert.ok(error instanceof MemoryHttpError);
    assert.equal(error.statusCode, 429);
    assert.equal(error.retryAfterSeconds, 11);
    assert.equal(error.retryable, true);
    assert.equal(error.code, "quota");
    assert.equal(error.typeUrl, "urn:relata:quota");
    assert.equal(error.queryId, "memory-query");
    assert.equal(error.requestId, "memory-request");
    assert.deepEqual(error.body, problem);
    return true;
  });
  await memory.close();
});

test("memory non-object and malformed HTTP errors preserve status and header metadata", async () => {
  const { MemoryHttpError } = await import("./memory.ts");
  for (const body of ["null", "[]", "42", '"proxy error"', "{broken"]) {
    let calls = 0;
    const response = new Response(body, { status: 503, headers: {
      "content-type": "application/problem+json", "Retry-After": "7", "x-request-id": "proxy-request",
    } });
    const memory = new Memory("http://x", { purpose: "p", fetch: (async () => {
      calls++;
      return response;
    }) as typeof globalThis.fetch });
    await assert.rejects(() => memory.add("private source"), (error: unknown) => {
      assert.ok(error instanceof MemoryHttpError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.retryAfterSeconds, 7);
      assert.equal(error.requestId, "proxy-request");
      assert.deepEqual(error.body, {});
      return true;
    });
    assert.equal(calls, 1, "uncertain memory writes must not retry");
    assert.equal(response.bodyUsed, true);
    await memory.close();
  }
});

test("memory HTTP error reads once and enforces configured body cap with cancellation", async () => {
  const { ResponseTooLargeError } = await import("./errors.ts");
  let cancelled = 0;
  let sent = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode("x".repeat(65)));
      }
    },
    cancel() { cancelled++; },
  }), { status: 503, headers: { "content-type": "text/plain" } });
  // The shared reader must consume the stream directly, never call an
  // unbounded convenience method or attempt a second body read.
  response.text = async () => { throw new Error("unexpected response.text read"); };
  response.json = async () => { throw new Error("unexpected response.json read"); };
  const memory = new Memory("http://x", { purpose: "p", maxResponseBytes: 64,
    fetch: (async () => response) as typeof globalThis.fetch });
  await assert.rejects(() => memory.add("private source"), ResponseTooLargeError);
  assert.equal(cancelled, 1);
  await memory.close();
});
