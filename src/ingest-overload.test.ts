/**
 * Document and CDR SDK batches under server overload (#5688).
 *
 * Same contract as `sdks/python/tests/test_ingest_overload_5688.py` and
 * `sdks/go/relata/ingest_overload_test.go`: a 429/503 shed surfaces as the
 * typed error carrying the server delay, the batch POST is sent exactly once,
 * the caller's retry of the same stable-key batch is byte-identical, an
 * accepted-then-uncertain 503 hands back the task id, and the SDK-side
 * invalid-row report survives the retry.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { RateLimitedError, RelataClient, ServerError } from "./index.ts";
import { IngestClient } from "./ingest.ts";

interface Scripted {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

function problem(status: number, retryAfter: string, extra: Record<string, unknown> = {}): Scripted {
  return {
    status,
    headers: { "content-type": "application/problem+json", "retry-after": retryAfter },
    body: { detail: "overloaded", code: "ingest-overloaded", retryable: true, ...extra },
  };
}

/** A fetch mock that answers from a script, then from `fallback`. */
function scripted(script: Scripted[], fallback: (url: string) => Scripted): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; method: string; body: string | undefined }>;
} {
  const queue = [...script];
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({ url: u, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    const next = u.endsWith("/v1/ingest/bulk") || u.includes("/v1/ingest?") ? (queue.shift() ?? fallback(u)) : fallback(u);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers ?? { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const docRows = [
  { _type: "DocumentSource", _pk: "doc-1", uri: "file://report.pdf" },
  { _type: "DocumentChunk", _pk: "chunk-1", source_id: "doc-1", text: "hello" },
];

// Explicit call_start: a row without one is stamped with the SDK wall clock at
// normalization time, so a retry would not be byte-identical.
const cdrRows = [
  { caller: "911234567890", callee: "919876543210", duration: 120, tower: "CELL-042", type: "voice", _pk: "cdr-1", source_file_id: 42, call_start: 1_700_000_000 },
  { caller: "not a number", callee: "922222222222" },
  { caller: "911111111111", callee: "922222222222", duration: 5, tower: "CELL-001", type: "sms", _pk: "cdr-2", source_file_id: 43, call_start: 1_700_000_001 },
];

test("document batch overload: surfaced once, retried by the caller, partial graph reported by status", async () => {
  const { fetch, calls } = scripted([problem(429, "3"), problem(503, "5")], (url) =>
    url.endsWith("/v1/ingest/tasks/task-9")
      ? {
          status: 200,
          body: {
            task_id: "task-9", status: "partial", rows_total: 2, rows_written: 1,
            rows_dropped: 1, drop_reasons: ["graph edge target missing"],
          },
        }
      : { status: 200, body: { task_id: "task-9", rows_queued: 2, rows_rejected: 0, errors: [], queue_depth: 2 } },
  );
  const client = new RelataClient({ baseUrl: "http://x", defaultPurpose: "analytics", fetch });

  await assert.rejects(client.ingestDocument(docRows), (error: unknown) => {
    assert.ok(error instanceof RateLimitedError);
    assert.equal(error.statusCode, 429);
    assert.equal(error.retryAfterSeconds, 3);
    return true;
  });
  assert.equal(calls.length, 1, "a 429 must not be replayed by the transport");

  await assert.rejects(client.ingestDocument(docRows), (error: unknown) => {
    assert.ok(error instanceof ServerError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.retryAfterSeconds, 5);
    return true;
  });
  assert.equal(calls.length, 2, "a 503 must not be replayed by the transport");

  const receipt = await client.ingestDocument(docRows);
  assert.equal(receipt.taskId, "task-9");
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.body, calls[1]?.body);
  assert.equal(calls[1]?.body, calls[2]?.body, "caller retries resend the identical stable-key batch");

  const status = await client.ingestDocumentStatus(receipt.taskId);
  assert.equal(status.status, "partial");
  assert.equal(status.rowsWritten, 1);
  assert.equal(status.rowsDropped, 1);
});

test("accepted-then-uncertain 503 hands back the task instead of a reason to resend", async () => {
  const { fetch, calls } = scripted([], () =>
    problem(503, "2", { task_id: "task-uncertain", accepted: true, receipt_status: "uncertain" }),
  );
  const client = new RelataClient({ baseUrl: "http://x", defaultPurpose: "analytics", fetch });
  await assert.rejects(client.ingestDocument(docRows), (error: unknown) => {
    assert.ok(error instanceof ServerError);
    assert.equal(error.taskId, "task-uncertain");
    assert.equal(error.accepted, true);
    assert.equal(error.receiptStatus, "uncertain");
    assert.equal(error.retryAfterSeconds, 2);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("CDR batch overload keeps the row report and replays nothing", async () => {
  const { fetch, calls } = scripted([problem(429, "1"), problem(503, "4")], () => ({
    status: 200,
    body: { rows_queued: 2, rows_rejected: 0, errors: [], task_id: "itsk_cdr" },
  }));
  const client = new IngestClient({ baseUrl: "http://x", purpose: "finint", fetch });

  await assert.rejects(client.ingestCdr(cdrRows), (error: unknown) => {
    assert.ok(error instanceof RateLimitedError);
    assert.equal(error.retryAfterSeconds, 1);
    return true;
  });
  assert.equal(calls.length, 1);
  await assert.rejects(client.ingestCdr(cdrRows), (error: unknown) => {
    assert.ok(error instanceof ServerError);
    assert.equal(error.retryAfterSeconds, 4);
    return true;
  });
  assert.equal(calls.length, 2);

  const out = await client.ingestCdr(cdrRows);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.body, calls[1]?.body);
  assert.equal(calls[1]?.body, calls[2]?.body);
  const sent = JSON.parse(calls[2]?.body ?? "[]") as Array<Record<string, unknown>>;
  assert.deepEqual(sent.map((row) => row["_pk"]), ["cdr-1", "cdr-2"], "invalid row never sent");
  assert.equal(out["task_id"], "itsk_cdr");
  assert.equal(out["rows_rejected"], 1);
  assert.equal((out["errors"] as unknown[]).length, 1);
});
