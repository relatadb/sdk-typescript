/** registerEdgeType must send the label as `relation`, the field the server stores (found live). */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { RelataClient } from "./index.ts";

test("registerEdgeType: label travels as relation (server field) and label (legacy)", async () => {
  let body: Record<string, unknown> = {};
  const fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return new Response('{"edge_id":"e1"}', { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  await new RelataClient({ baseUrl: "http://x", fetch }).registerEdgeType("A", "B", "knows");
  assert.deepEqual(body, { from_type: "A", to_type: "B", relation: "knows", label: "knows" });
});
