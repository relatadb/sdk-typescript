/**
 * RelataDB TypeScript SDK — smoke test stub.
 *
 * Verifies the SDK package imports and the client constructs without error.
 * Full E2E parity with the Python sdk_e2e_test.py harness is tracked at
 * check_sdk_parity.py; this file ensures `npm test` has something to run.
 *
 * Run: npm test (from sdks/typescript/)
 * Needs: a live server at localhost:9090 with RELATA_BEARER_TOKEN=perftoken
 */
import { describe, it, expect } from "vitest";
import { RelataClient } from "../src/index.js";

const BASE = process.env.RELATA_HOST || "http://localhost:9090";
const TOKEN = process.env.RELATA_TOKEN || "perftoken";

describe("RelataClient smoke", () => {
  it("constructs without error", () => {
    const client = new RelataClient(BASE, { bearerToken: TOKEN });
    expect(client).toBeDefined();
  });

  it("health check returns 200", async () => {
    const client = new RelataClient(BASE, { bearerToken: TOKEN });
    const result = await client.query("SELECT 1", { purpose: "analytics" });
    expect(result).toBeDefined();
  });

  it("ingest + query round-trip", async () => {
    const client = new RelataClient(BASE, { bearerToken: TOKEN });
    await client.ingest("TSSmoke", [{ id: "ts-1", name: "from-typescript" }]);
    // Allow drain
    await new Promise((r) => setTimeout(r, 2000));
    const result = await client.query("SELECT COUNT(*) FROM TSSmoke", { purpose: "analytics" });
    expect(result.rows.length).toBeGreaterThan(0);
  });
});
