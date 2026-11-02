import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchClient } from "./search.ts";
import { RelataClient } from "./client.ts";

test("SearchClient.query maps wire data[] onto rows[] (rows on the wire is a count)", async () => {
  const wire = {
    rows: 2,
    columns: ["id"],
    data: [{ id: "a" }, { id: "b" }],
    next_cursor: null,
    query_id: "q1",
    processing_time_ms: 3,
  };
  const f = (async () =>
    new Response(JSON.stringify(wire), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const c = new RelataClient({ baseUrl: "http://x.test", bearerToken: "t", fetch: f } as never);
  const r = await SearchClient.fromClient(c).query({ from: "T", text: "a" });
  assert.deepEqual(r.rows, [{ id: "a" }, { id: "b" }]);
  assert.equal(r.rowCount, 2);
  assert.equal(r.queryId, "q1");
  assert.equal(r.processingTimeMs, 3);
});
