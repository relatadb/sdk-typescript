import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestError, RelataClient } from "./index.ts";

const sql = "SELECT id FROM Record WHERE active = $1 AND id IN ($2) AND payload = $3";
const params = [true, ["safe", "x'); DROP TABLE Record; --", "$1"], {
  enabled: false, nested: [null, { label: "'quoted'", count: 7 }],
}];

test("typed query parameters preserve JSON types and never enter SQL text", async () => {
  let requests = 0;
  const client = new RelataClient({
    baseUrl: "http://data", defaultPurpose: "analytics",
    fetch: async (url, init) => {
      requests++;
      assert.equal(String(url), "http://data/query");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { purpose: "analytics", sql, params });
      return Response.json({ rows: [], query_id: "typed", elapsed_ms: 1 });
    },
  });
  await client.queryWithParams(sql, params);
  assert.equal(requests, 1);
});

test("unsupported typed parameter keeps its indexed 400 detail without retry", async () => {
  let requests = 0;
  const client = new RelataClient({
    baseUrl: "http://data", defaultPurpose: "analytics",
    fetch: async () => {
      requests++;
      return new Response(JSON.stringify({
        type: "about:blank", title: "Invalid query parameter", status: 400,
        detail: "parameter $2 is unsupported in this context",
      }), { status: 400, headers: { "content-type": "application/problem+json" } });
    },
  });
  await assert.rejects(() => client.queryWithParams(sql, params), (error: unknown) => {
    assert.ok(error instanceof BadRequestError);
    assert.match(error.message, /\$2/);
    return true;
  });
  assert.equal(requests, 1);
});
