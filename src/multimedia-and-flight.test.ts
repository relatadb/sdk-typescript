/**
 * Tests for the multimedia ops (#2251) + Arrow Flight client (#2253).
 *
 * Uses Node's built-in `node:test` runner with an injected `fetch` mock for
 * the SQL-door multimedia ops (no live server), and pure unit tests for the
 * Flight ticket/endpoint/transport wiring (live `do_get` needs a running
 * Flight door + apache-arrow).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { RelataClient, RelataError } from "./index.ts";
import {
  buildFaceSearchSql,
  buildFlightTicket,
  buildMatchPdqSql,
  deriveFlightEndpoint,
} from "./client.ts";

// ---------------------------------------------------------------------------
// Mock fetch helper (mirrors client.test.ts)
// ---------------------------------------------------------------------------

interface MockResponse {
  status?: number;
  body?: unknown;
}

function mockFetch(response: MockResponse): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; body: string | undefined }>;
} {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof url === "string" ? url : url.toString(),
      body: typeof init?.body === "string" ? (init.body as string) : undefined,
    });
    const status = response.status ?? 200;
    const headers = new Headers({ "content-type": "application/json" });
    return new Response(JSON.stringify(response.body ?? {}), { status, headers });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

// ---------------------------------------------------------------------------
// #2251 — SQL builder shapes
// ---------------------------------------------------------------------------

test("buildFaceSearchSql: list embedding → csv with K + THRESHOLD", () => {
  const sql = buildFaceSearchSql("gallery-1", [0.1, 0.2, 0.3], { k: 5, threshold: 0.6 });
  assert.equal(
    sql,
    "SELECT * FROM FACE_SEARCH('0.1,0.2,0.3', 'gallery-1', K => 5, THRESHOLD => 0.6)",
  );
});

test("buildFaceSearchSql: string embedding passed through", () => {
  const sql = buildFaceSearchSql("g", "1.0,0.0");
  assert.ok(sql.includes("FACE_SEARCH('1.0,0.0', 'g', K => 10, THRESHOLD => 0.7)"));
});

test("buildMatchPdqSql: shape with default threshold", () => {
  assert.equal(
    buildMatchPdqSql("ncmec", "ffff"),
    "SELECT * FROM MATCH_PDQ('ffff', 'ncmec', THRESHOLD => 0.9)",
  );
});

test("multimedia builders escape single quotes (#76)", () => {
  assert.equal(
    buildFaceSearchSql("o'reilly", [0.1], { k: 1, threshold: 0.5 }),
    "SELECT * FROM FACE_SEARCH('0.1', 'o''reilly', K => 1, THRESHOLD => 0.5)",
  );
  assert.equal(
    buildMatchPdqSql("o'reilly", "ff", 0.5),
    "SELECT * FROM MATCH_PDQ('ff', 'o''reilly', THRESHOLD => 0.5)",
  );
});

// ---------------------------------------------------------------------------
// #2251 — HTTP dispatch through /query
// ---------------------------------------------------------------------------

test("faceSearch: posts FACE_SEARCH operator through /query", async () => {
  const { fetch, calls } = mockFetch({
    body: { data: [{ entity_id: "e-1", score: 0.98 }], query_id: "q1", elapsed_ms: 2 },
  });
  const relata = new RelataClient({
    baseUrl: "http://localhost:9090",
    defaultPurpose: "analytics",
    fetch,
  });
  const result = await relata.faceSearch("gallery-1", [0.1, 0.2], { k: 5, threshold: 0.6 });
  const body = JSON.parse(calls[0]!.body!);
  assert.ok(body.sql.includes("SELECT * FROM FACE_SEARCH("));
  assert.ok(body.sql.includes("K => 5"));
  assert.ok(body.sql.includes("THRESHOLD => 0.6"));
  assert.equal(body.purpose, "analytics");
  assert.equal(result.rows[0]!["score"], 0.98);
});

test("matchPdq: posts MATCH_PDQ operator + honours purpose override", async () => {
  const { fetch, calls } = mockFetch({
    body: { data: [{ entity_id: "e-9" }], query_id: "q2", elapsed_ms: 1 },
  });
  const relata = new RelataClient({
    baseUrl: "http://localhost:9090",
    defaultPurpose: "analytics",
    fetch,
  });
  await relata.matchPdq("ncmec", "ffff", { threshold: 0.95, purpose: "investigation" });
  const body = JSON.parse(calls[0]!.body!);
  assert.equal(body.sql, "SELECT * FROM MATCH_PDQ('ffff', 'ncmec', THRESHOLD => 0.95)");
  assert.equal(body.purpose, "investigation");
});

// ---------------------------------------------------------------------------
// #2253 — Flight ticket + endpoint + transport wiring
// ---------------------------------------------------------------------------

test("buildFlightTicket: injects PURPOSE comment only when purpose set", () => {
  assert.equal(buildFlightTicket("SELECT 1"), "SELECT 1");
  assert.equal(
    buildFlightTicket("SELECT 1", "analytics"),
    "/* PURPOSE 'analytics' */ SELECT 1",
  );
});

test("buildFlightTicket: doubles embedded quotes in purpose", () => {
  assert.equal(
    buildFlightTicket("SELECT 1", "o'reilly"),
    "/* PURPOSE 'o''reilly' */ SELECT 1",
  );
});

test("deriveFlightEndpoint: derives grpc://host:8815 from baseUrl", () => {
  assert.equal(deriveFlightEndpoint("http://localhost:9090"), "grpc://localhost:8815");
  assert.equal(
    deriveFlightEndpoint("https://relata.example.com"),
    "grpc://relata.example.com:8815",
  );
});

test("deriveFlightEndpoint: explicit override wins", () => {
  assert.equal(
    deriveFlightEndpoint("http://localhost:9090", "grpc://host:9999"),
    "grpc://host:9999",
  );
});

test("queryFlight: throws RelataError when no transport supplied", async () => {
  const relata = new RelataClient({ baseUrl: "http://localhost:9090" });
  await assert.rejects(
    () => relata.queryFlight("SELECT 1"),
    (err: unknown) => err instanceof RelataError,
  );
});

test("queryFlight: invokes transport with resolved endpoint, ticket, bearer", async () => {
  const relata = new RelataClient({
    baseUrl: "http://localhost:9090",
    bearerToken: "tok",
  });
  let captured: { endpoint: string; ticket: string; bearer: string | undefined } | null = null;
  const result = await relata.queryFlight<{ rows: number[] }>("SELECT 1", {
    purpose: "analytics",
    transport: async (endpoint, ticketSql, bearer) => {
      captured = { endpoint, ticket: ticketSql, bearer };
      return { rows: [1, 2, 3] };
    },
  });
  assert.deepEqual(result, { rows: [1, 2, 3] });
  assert.equal(captured!.endpoint, "grpc://localhost:8815");
  assert.equal(captured!.ticket, "/* PURPOSE 'analytics' */ SELECT 1");
  assert.equal(captured!.bearer, "tok");
});

test("queryFlight: honours explicit flightEndpoint + bearerToken override", async () => {
  const relata = new RelataClient({ baseUrl: "http://localhost:9090", bearerToken: "default" });
  let captured: { endpoint: string; bearer: string | undefined } | null = null;
  await relata.queryFlight("SELECT 1", {
    flightEndpoint: "grpc://h:9999",
    bearerToken: "override",
    transport: async (endpoint, _ticket, bearer) => {
      captured = { endpoint, bearer };
      return null;
    },
  });
  assert.equal(captured!.endpoint, "grpc://h:9999");
  assert.equal(captured!.bearer, "override");
});
