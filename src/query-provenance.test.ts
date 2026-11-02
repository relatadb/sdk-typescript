/** WITH PROVENANCE responses carry a top-level `provenance` array aligned with rows; the SDK must surface it. */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { RelataClient } from "./index.ts";

test("query: provenance array from WITH PROVENANCE is preserved", async () => {
  const body = {
    rows: 2, columns: ["a"], data: [{ a: 1 }, { a: 2 }], query_id: "q1",
    provenance: [{ source: "s1" }, null],
  };
  const fetch = (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
  const c = new RelataClient({ baseUrl: "http://x", fetch, defaultPurpose: "p" });
  const r = await c.query("SELECT a FROM T LIMIT 2 WITH PROVENANCE");
  assert.deepEqual(r.provenance, [{ source: "s1" }, null]);
  const p = await c.queryWithParams("SELECT a FROM T WHERE a = $1 WITH PROVENANCE", [1]);
  assert.equal(p.provenance?.length, 2);
  const none = await new RelataClient({ baseUrl: "http://x", defaultPurpose: "p", fetch: (async () => new Response(JSON.stringify({ rows: 0, data: [], columns: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch }).query("SELECT 1");
  assert.equal(none.provenance, undefined);
});
