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

test("ingestCdr: normalizes aliases, reports invalid rows, and queues via generic ingest", async () => {
  const { fetch, lastCall } = mockFetch({ rows_queued: 1, rows_rejected: 0, errors: [], task_id: "itsk_test" });
  const client = new IngestClient({ baseUrl: "http://x", purpose: "finint", fetch });
  const out = await client.ingestCdr(
    [
      { caller: "911234567890", callee: "919876543210", duration: 120, tower: "CELL-042", type: "voice", _pk: "cdr-stable-1", source_file_id: 42 },
      { a_number: "+91 1111-1111", b_msisdn: "922222222222", call_start: 1_700_000_000, tower_id: "CELL-001", call_type: "sms", id: "cdr-stable-2", source_file_id: 43 },
      { caller: "not a number", callee: "922222222222" },
    ],
    { purpose: "finint" },
  );
  assert.equal(out["rows_queued"], 1);
  assert.equal(out["task_id"], "itsk_test");
  assert.equal(out["rows_rejected"], 1);
  assert.equal((out["errors"] as unknown[]).length, 1);
  const call = lastCall();
  assert.equal(call.url, "http://x/ingest?object_type=CdrRecord&purpose=finint");
  const rows = (call.body ?? "").split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.["caller_msisdn"], 911234567890);
  assert.equal(rows[0]?.["call_type"], "voice");
  assert.equal(rows[0]?.["_pk"], "cdr-stable-1");
  assert.equal(rows[0]?.["source_file_id"], 42);
  assert.equal(rows[1]?.["call_start_ns"], 1_700_000_000_000_000_000);
  assert.equal(rows[1]?.["tower_id"], "CELL-001");
  assert.equal(rows[1]?.["id"], "cdr-stable-2");
  assert.equal(rows[1]?.["source_file_id"], 43);
});

test("ingestCdr: case-insensitive view keeps last input key and alias precedence", async () => {
  const { fetch, lastCall } = mockFetch({ rows_queued: 1, rows_rejected: 0, errors: [], task_id: "itsk_case" });
  const client = new IngestClient({ baseUrl: "http://x", fetch });
  await client.ingestCdr([{
    CALLER: "14155550000",
    caller: "14155551111",
    caller_msisdn: "14155552222",
    CALLEE: "919876543210",
    DURATION: 9,
    CALL_START_NS: "1700000000000000001",
    _PK: "first",
    _pk: "last",
  }]);
  const [row] = (lastCall().body ?? "").split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(row?.["caller_msisdn"], 14155551111);
  assert.equal(row?.["_pk"], "last");
});

test("ingestCdr: preserves exact nanosecond timestamps and rejects unsafe number inputs", async () => {
  const { fetch, lastCall } = mockFetch({
    rows_queued: 2,
    rows_rejected: 0,
    errors: [],
    task_id: "itsk_precision",
  });
  const client = new IngestClient({ baseUrl: "http://x", purpose: "finint", fetch });
  const out = await client.ingestCdr([
    {
      caller_msisdn: "14155552671",
      callee_msisdn: "919876500000",
      call_start_ns: 1_700_000_000_000_000_001,
      duration_secs: 30,
    },
    {
      caller_msisdn: "14155552671",
      callee_msisdn: "919876500000",
      call_start_ns: "1700000000000000001",
      duration_secs: 30,
      _pk: "cdr-exact-ns",
    },
    {
      caller_msisdn: "14155552671",
      callee_msisdn: "919876500000",
      call_start_ns: 1_700_000_000_000_000_003n,
      duration_secs: 30,
      _pk: "cdr-bigint-ns",
    },
  ]);

  assert.equal(out["rows_queued"], 2);
  assert.equal(out["rows_rejected"], 1);
  assert.match(String((out["errors"] as Array<Record<string, unknown>>)[0]?.["error"]), /string or bigint/);
  const ndjsonRows = (lastCall().body ?? "").split("\n");
  assert.equal(ndjsonRows.length, 2);
  assert.match(ndjsonRows[0] ?? "", /"call_start_ns":1700000000000000001/);
  assert.match(ndjsonRows[1] ?? "", /"call_start_ns":1700000000000000003/);
});

test("ingestCdr: matches legacy i64 validation and saturating seconds conversion", async () => {
  const { fetch, lastCall } = mockFetch({
    rows_queued: 3,
    rows_rejected: 0,
    errors: [],
    task_id: "itsk_saturated_seconds",
  });
  const client = new IngestClient({ baseUrl: "http://x", purpose: "finint", fetch });
  const out = await client.ingestCdr([
    {
      caller_msisdn: "14155552671",
      callee_msisdn: "919876500000",
      call_start_ns: "9223372036854775807",
      duration_secs: 1,
    },
    {
      caller_msisdn: "14155552671",
      callee_msisdn: "919876500000",
      call_start_ns: "-9223372036854775808",
      duration_secs: 1,
    },
    {
      caller_msisdn: "14155552671",
      callee_msisdn: "919876500000",
      call_start_ns: "10000000000000",
      duration_secs: 1,
    },
    {
      caller_msisdn: "14155552671",
      callee_msisdn: "919876500000",
      call_start_ns: "9223372036854775808",
      duration_secs: 1,
    },
  ]);

  assert.equal(out["rows_queued"], 3);
  assert.equal(out["rows_rejected"], 1);
  const ndjsonRows = (lastCall().body ?? "").split("\n");
  assert.equal(ndjsonRows.length, 3);
  assert.match(ndjsonRows[0] ?? "", /"call_start_ns":9223372036854775807/);
  assert.match(ndjsonRows[1] ?? "", /"call_start_ns":-9223372036854775808/);
  assert.match(ndjsonRows[2] ?? "", /"call_start_ns":10000000000000/);
  assert.match(String((out["errors"] as Array<Record<string, unknown>>)[0]?.["error"]), /out of range for i64/);
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
