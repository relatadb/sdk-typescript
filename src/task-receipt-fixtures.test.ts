// #5666: cross-SDK shared queue-acknowledgement and task-status fixtures (TypeScript leg). See
// sdks/shared/task-receipt-fixtures.json and the Rust live replay test
// (http_e2e::contract_matrix::task_receipt_fixtures_match_live_server) that keeps it faithful.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RelataClient } from "./index.ts";

interface Case {
  name: string;
  kind: "queue_ack" | "task_status";
  wire: { status: number; body: unknown };
  // Free-form per-case expectation object; fields vary by `kind`.
  expect: any;
}

const fixtures = JSON.parse(
  readFileSync(new URL("../tests/fixtures/task-receipt-fixtures.json", import.meta.url), "utf8"),
) as { contract: string; cases: Case[] };

test("fixture file is the documented contract", () => {
  assert.equal(fixtures.contract, "relata.task-receipt-fixtures/v1");
  assert.ok(fixtures.cases.length >= 8);
  assert.equal(new Set(fixtures.cases.map((c) => c.name)).size, fixtures.cases.length);
});

for (const c of fixtures.cases) {
  test(`wire body decodes to the shared expectation: ${c.name}`, async () => {
    const f: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify(c.wire.body), {
        status: c.wire.status,
        headers: { "content-type": "application/json" },
      });
    const client = new RelataClient({
      baseUrl: "http://relata.invalid",
      bearerToken: "t",
      defaultPurpose: "analytics",
      fetch: f,
      maxRetries: 0,
    });
    const e = c.expect;
    let extensions: Record<string, unknown> | undefined;
    if (c.kind === "queue_ack") {
      const got = await client.ingestDocument([{ _type: "T", _pk: "1" }]);
      assert.equal(got.taskId, e.task_id);
      assert.equal(got.rowsQueued, e.rows_queued);
      assert.equal(got.rowsRejected, e.rows_rejected);
      assert.deepEqual(got.errors, e.errors);
      assert.equal(got.queueDepth, e.queue_depth);
      extensions = got.extensions;
    } else {
      const got = await client.ingestDocumentStatus(e.task_id);
      assert.equal(got.taskId, e.task_id);
      // The status string is surfaced verbatim: an unknown value is never coerced.
      assert.equal(got.status, e.status);
      assert.equal(got.rowsTotal, e.rows_total);
      assert.equal(got.rowsWritten, e.rows_written);
      assert.equal(got.rowsDropped, e.rows_dropped);
      assert.deepEqual(got.dropReasons, e.drop_reasons);
      assert.equal(got.outcomeUncertain ?? null, e.outcome_uncertain);
      assert.equal(got.code ?? null, e.code);
      assert.equal(got.derivedError ?? null, e.derived_error);
      assert.equal(got.retryable ?? null, e.retryable);
      const token = e.write_token as { wall_ns: number; counter: number } | null;
      assert.deepEqual(
        got.writeToken ?? null,
        token === null ? null : { wallNs: token.wall_ns, counter: token.counter },
      );
      extensions = got.extensions;
    }
    assert.deepEqual(Object.keys(extensions ?? {}).sort(), e.extension_keys);
  });
}
