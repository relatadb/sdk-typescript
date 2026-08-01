/**
 * Tests for the maritime domain-op client methods (#2247).
 *
 * Verifies the generated SQL shape mirrors the server operator signatures in
 * `crates/relata-query/src/maritime_operators.rs`. No live server required —
 * uses an injected fetch mock.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { RelataClient } from "./client.ts";

interface MockResponse { status?: number; body?: unknown; }

function mockFetch(): { fetch: typeof globalThis.fetch; calls: { body: string }[] } {
  const calls: { body: string }[] = [];
  const fetch = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ body: typeof init?.body === "string" ? (init.body as string) : "" });
    const next: MockResponse = { status: 200, body: { rows: [] } };
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function sqlOf(calls: { body: string }[]): string {
  const body = JSON.parse(calls.at(-1)!.body) as { purpose: string; sql: string };
  return body.sql;
}

test("vesselTrack: bare mmsi", async () => {
  const { fetch, calls } = mockFetch();
  const c = new RelataClient({ baseUrl: "http://x", defaultPurpose: "analytics", fetch });
  await c.vesselTrack(123456789);
  assert.equal(sqlOf(calls), "VESSEL_TRACK(123456789)");
});

test("vesselTrack: with window converted to ns", async () => {
  const { fetch, calls } = mockFetch();
  const c = new RelataClient({ baseUrl: "http://x", defaultPurpose: "analytics", fetch });
  await c.vesselTrack(123456789, { windowSecs: 3600 });
  const sql = sqlOf(calls);
  assert.ok(sql.startsWith("VESSEL_TRACK(123456789, WINDOW => "));
  assert.ok(sql.includes(String(3600 * 1_000_000_000)));
});

test("darkFleetDetect: default", async () => {
  const { fetch, calls } = mockFetch();
  const c = new RelataClient({ baseUrl: "http://x", defaultPurpose: "analytics", fetch });
  await c.darkFleetDetect();
  assert.equal(sqlOf(calls), "DARK_FLEET_DETECT()");
});

test("darkFleetDetect: with gap", async () => {
  const { fetch, calls } = mockFetch();
  const c = new RelataClient({ baseUrl: "http://x", defaultPurpose: "analytics", fetch });
  await c.darkFleetDetect({ maxGapHours: 12 });
  assert.equal(sqlOf(calls), "DARK_FLEET_DETECT(MAX_GAP_HOURS => 12)");
});

test("vesselToVesselTransfer: default", async () => {
  const { fetch, calls } = mockFetch();
  const c = new RelataClient({ baseUrl: "http://x", defaultPurpose: "analytics", fetch });
  await c.vesselToVesselTransfer();
  assert.equal(sqlOf(calls), "VESSEL_TO_VESSEL_TRANSFER()");
});

test("vesselToVesselTransfer: with opts", async () => {
  const { fetch, calls } = mockFetch();
  const c = new RelataClient({ baseUrl: "http://x", defaultPurpose: "analytics", fetch });
  await c.vesselToVesselTransfer({ proximityNm: 0.5, timeWindowMinutes: 30 });
  const sql = sqlOf(calls);
  assert.ok(sql.includes("PROXIMITY_NM => 0.5"));
  assert.ok(sql.includes("TIME_WINDOW_MINUTES => 30"));
});
