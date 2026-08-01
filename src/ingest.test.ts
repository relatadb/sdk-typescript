/**
 * Tests for `IngestClient` CDR + OTLP helpers (#2252).
 *
 * Uses Node's built-in `node:test` runner with an injected `fetch` mock
 * (no real HTTP).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { IngestClient } from "./ingest.ts";
import { RelataClient } from "./client.ts";

/** Build a fetch mock that records the last call and returns the given body. */
function mockFetch(body: unknown): {
  fetch: typeof globalThis.fetch;
  lastCall: () => { url: string; method: string; body: string | undefined };
} {
  let last: { url: string; method: string; body: string | undefined } = {
    url: "",
    method: "",
    body: undefined,
  };
  const fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlString = typeof url === "string" ? url : url.toString();
    last = {
      url: urlString,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? (init.body as string) : undefined,
    };
    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, lastCall: () => last };
}

test("ingestCdr: serialises rows to CSV with aliases and threads purpose", async () => {
  const { fetch, lastCall } = mockFetch({ rows_queued: 2, errors: [], queue_depth: 0 });
  const client = new IngestClient({ baseUrl: "http://x", purpose: "finint", fetch });
  const out = await client.ingestCdr(
    [
      { caller: "911234567890", callee: "919876543210", duration: 120, tower: "CELL-042", type: "voice" },
      { a_number: "911111111111", b_number: "922222222222", tower_id: "CELL-001", call_type: "sms" },
    ],
    { purpose: "finint" },
  );
  assert.equal((out as Record<string, unknown>)["rows_queued"], 2);
  const call = lastCall();
  assert.equal(call.url, "http://x/ingest/cdr?purpose=finint");
  const lines = (call.body ?? "").split("\n");
  assert.equal(lines[0], "caller,callee,start,duration,tower,type");
  // Aliases resolve to canonical columns.
  assert.ok(lines[1]?.includes("911234567890"));
  assert.ok(lines[2]?.includes("911111111111"));
  assert.ok((call.body ?? "").includes("CELL-042"));
});

test("otlpTraces/Logs/Metrics: POST JSON to the right /v1 door", async () => {
  const { fetch, lastCall } = mockFetch({ ok: true });
  const relata = new RelataClient({ baseUrl: "http://x", fetch });
  const client = IngestClient.fromClient(relata);
  const payload = { resourceSpans: [] };

  await client.otlpTraces(payload, { purpose: "otel" });
  assert.equal(lastCall().url, "http://x/v1/traces?purpose=otel");
  assert.equal(lastCall().body, JSON.stringify(payload));

  await client.otlpLogs({ resourceLogs: [] }, { purpose: "otel" });
  assert.equal(lastCall().url, "http://x/v1/logs?purpose=otel");

  await client.otlpMetrics({ resourceMetrics: [] }, { purpose: "otel" });
  assert.equal(lastCall().url, "http://x/v1/metrics?purpose=otel");
});
