import test from "node:test";
import assert from "node:assert/strict";
import { AppPrimitivesClient, RelataClient } from "./index.ts";

type Call = { path: string; search: string; method: string; body: unknown };

function make(calls: Call[], reply: unknown): AppPrimitivesClient {
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      search: url.search,
      method: String(init?.method),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(reply);
  };
  return AppPrimitivesClient.fromClient(
    new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "t", fetch: fetchImpl }),
  );
}

test("sequenceNext sends camelCase body to the encoded name", async () => {
  const calls: Call[] = [];
  await make(calls, { start: 1, end: 5 }).sequenceNext("inv", { count: 5, idempotencyKey: "k" });
  assert.equal(calls[0]!.path, "/v1/sequences/inv/next");
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(calls[0]!.body, { count: 5, idempotencyKey: "k" });
});

test("claim returns jobs and complete carries the fencing token", async () => {
  const calls: Call[] = [];
  const c = make(calls, { jobs: [{ jobId: "j1", fencingToken: 7 }] });
  const jobs = await c.claim("q", "w1", { leaseMs: 1000, max: 2 });
  assert.equal(jobs[0]!["fencingToken"], 7);
  await c.complete("j1", 7, { result: { ok: true } });
  assert.deepEqual(calls[0]!.body, { workerId: "w1", leaseMs: 1000, max: 2 });
  assert.equal(calls[1]!.path, "/v1/jobs/j1/complete");
  assert.deepEqual(calls[1]!.body, { fencingToken: 7, result: { ok: true } });
});

test("listJobs builds the query string", async () => {
  const calls: Call[] = [];
  await make(calls, { jobs: [] }).listJobs("q", { state: "dead", limit: 5 });
  assert.equal(calls[0]!.path, "/v1/queues/q/jobs");
  assert.equal(calls[0]!.search, "?state=dead&limit=5");
});

test("claim defaults leaseMs because the server requires it", async () => {
  const calls: Call[] = [];
  await make(calls, { jobs: [] }).claim("q", "w1");
  assert.deepEqual(calls[0]!.body, { workerId: "w1", leaseMs: 30000 });
});

test("renew defaults leaseMs because the server requires it", async () => {
  const calls: Call[] = [];
  await make(calls, {}).renew("j1", 3);
  assert.deepEqual(calls[0]!.body, { fencingToken: 3, leaseMs: 30000 });
});
