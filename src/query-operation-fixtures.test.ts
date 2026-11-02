// #5666: cross-SDK shared query-operation fixtures (TypeScript leg). See
// sdks/shared/query-operation-fixtures.json and the Rust live replay test
// (http_e2e::contract_matrix::query_operation_fixtures_match_live_server) that keeps it faithful.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RelataClient } from "./index.ts";

interface Case {
  name: string;
  call: { sql: string; purpose?: string; query_vector?: number[]; query_vector_model?: string };
  request: { method: string; path: string; body: unknown };
  wire: { status: number; body: unknown };
  expect: {
    rows: unknown[];
    columns: string[];
    row_count: number;
    query_id: string;
    next_cursor_present: boolean;
    next_cursor: string | null;
    truncated: boolean;
  };
}

const fixtures = JSON.parse(
  readFileSync(new URL("../../shared/query-operation-fixtures.json", import.meta.url), "utf8"),
) as { contract: string; cases: Case[] };

test("fixture file is the documented contract", () => {
  assert.equal(fixtures.contract, "relata.query-operation-fixtures/v1");
  assert.ok(fixtures.cases.length >= 4);
  assert.equal(new Set(fixtures.cases.map((c) => c.name)).size, fixtures.cases.length);
});

for (const c of fixtures.cases) {
  test(`query request and result match the shared expectation: ${c.name}`, async () => {
    const seen: { url: string; method: string; body: unknown }[] = [];
    const f: typeof globalThis.fetch = async (input, init) => {
      seen.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return new Response(JSON.stringify(c.wire.body), {
        status: c.wire.status,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new RelataClient({
      baseUrl: "http://relata.invalid",
      bearerToken: "t",
      defaultPurpose: "analytics",
      fetch: f,
      maxRetries: 0,
    });
    const got = await client.query(c.call.sql, {
      ...(c.call.purpose !== undefined ? { purpose: c.call.purpose } : {}),
      ...(c.call.query_vector !== undefined ? { queryVector: c.call.query_vector } : {}),
      ...(c.call.query_vector_model !== undefined
        ? { queryVectorModel: c.call.query_vector_model }
        : {}),
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.method, c.request.method);
    assert.equal(new URL(seen[0]!.url).pathname, c.request.path);
    assert.deepEqual(seen[0]!.body, c.request.body);

    const e = c.expect;
    assert.deepEqual(got.rows, e.rows);
    assert.deepEqual(got.columns, e.columns);
    assert.equal(got.rowCount, e.row_count);
    assert.equal(got.queryId, e.query_id);
    assert.equal(Object.hasOwn(got, "nextCursor"), e.next_cursor_present);
    assert.equal(got.nextCursor ?? null, e.next_cursor);
    assert.equal(got.truncated ?? false, e.truncated);
  });
}
