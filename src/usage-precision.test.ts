import assert from "node:assert/strict";
import test from "node:test";
import { createExactUsageFetch } from "./usage-precision.ts";

test("usage fetch preserves observed_at source digits before SDK decoding", async () => {
  const exact = "1791710000000000001";
  const fetcher = createExactUsageFetch(async () =>
    new Response(`{"data":[{"observed_at":${exact},"row_count":1791710000000000001}]}`, {
      headers: { "content-type": "application/json" },
    }),
  );
  const response = await fetcher("http://localhost:9090/query", { method: "POST" });
  const decoded = JSON.parse(await response.text()) as {
    data: Array<{ observed_at: string; row_count: number }>;
  };
  assert.equal(decoded.data[0]?.observed_at, exact);
  // This adapter only preserves the timestamp field; other response numbers
  // retain the fetch/runtime's normal JSON behavior.
  assert.equal(decoded.data[0]?.row_count, 1791710000000000000);
});

test("usage fetch leaves other endpoints on the regular response path", async () => {
  const original = new Response("{\"observed_at\":1791710000000000001}", {
    headers: { "content-type": "application/json" },
  });
  const fetcher = createExactUsageFetch(async () => original);
  const response = await fetcher("http://localhost:9090/status");
  assert.equal(response, original);
});
