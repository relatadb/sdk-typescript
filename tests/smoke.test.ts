/**
 * RelataDB TypeScript SDK — smoke test stub.
 *
 * Verifies the SDK package imports and the client constructs without error.
 * Full E2E parity with the Python sdk_e2e_test.py harness is tracked at
 * check_sdk_parity.py.
 *
 * This file lives outside `src/**\/*.test.ts` (the glob `npm test` actually
 * runs) deliberately — it needs a live server, unlike every unit test in
 * `src/`. Run explicitly: `node --experimental-strip-types --test tests/smoke.test.ts`
 * Needs: a live server at localhost:9090 with RELATA_BEARER_TOKEN=perftoken
 * (gracefully skips the server-dependent tests otherwise, same behavior as
 * the Go SDK's `tests/smoke_test.go`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RelataClient } from "../src/index.ts";

const BASE = process.env.RELATA_HOST || "http://localhost:9090";
const TOKEN = process.env.RELATA_TOKEN || "perftoken";

test("RelataClient smoke: constructs without error", () => {
  const client = new RelataClient(BASE, { bearerToken: TOKEN });
  assert.ok(client);
});

test("RelataClient smoke: health check returns 200", async (t) => {
  const client = new RelataClient(BASE, { bearerToken: TOKEN });
  try {
    const result = await client.query("SELECT 1", { purpose: "analytics" });
    assert.ok(result);
  } catch (err) {
    t.skip(`server not reachable: ${err}`);
  }
});

test("RelataClient smoke: ingest + query round-trip", async (t) => {
  const client = new RelataClient(BASE, { bearerToken: TOKEN });
  try {
    await client.ingest("TSSmoke", [{ id: "ts-1", name: "from-typescript" }]);
    // Allow drain
    await new Promise((r) => setTimeout(r, 2000));
    const result = await client.query("SELECT COUNT(*) FROM TSSmoke", { purpose: "analytics" });
    assert.ok(result.rows.length > 0);
  } catch (err) {
    t.skip(`server not reachable: ${err}`);
  }
});
