/** Tests for multimedia operators over native HTTP. */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { RelataClient, RelataError } from "./index.ts";
import {
  buildSimilarImageSql,
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

// #5492: the engine's OPERATOR(…) keyword dispatch only recognizes these as
// bare top-level statements — a `SELECT * FROM` wrapper parses `FACE_SEARCH`/
// `MATCH_PDQ`/`SIMILAR_IMAGE` as a table name and chokes on the trailing `(`.
test("multimedia builders never wrap the operator in SELECT * FROM (#5492)", () => {
  assert.ok(!buildSimilarImageSql("m").includes("SELECT"));
});

test("buildSimilarImageSql: default threshold, no INDEX clause when omitted", () => {
  assert.equal(buildSimilarImageSql("media-42"), "SIMILAR_IMAGE('media-42', THRESHOLD => 0.9)");
});

test("buildSimilarImageSql: explicit threshold + INDEX scope", () => {
  assert.equal(
    buildSimilarImageSql("media-42", { threshold: 0.6, index: "ncmec" }),
    "SIMILAR_IMAGE('media-42', THRESHOLD => 0.6, INDEX => 'ncmec')",
  );
});

test("buildSimilarImageSql: escapes single quotes in mediaRef and index", () => {
  assert.equal(
    buildSimilarImageSql("o'reilly", { threshold: 0.5, index: "o'index" }),
    String.raw`SIMILAR_IMAGE('o\'reilly', THRESHOLD => 0.5, INDEX => 'o\'index')`,
  );
});

// ---------------------------------------------------------------------------
// #2251 — HTTP dispatch through /query
// ---------------------------------------------------------------------------

test("similarImage: posts SIMILAR_IMAGE operator + honours threshold/index/purpose", async () => {
  const { fetch, calls } = mockFetch({
    body: { data: [{ entity_id: "e-7", score: 0.99 }], query_id: "q3", elapsed_ms: 1 },
  });
  const relata = new RelataClient({
    baseUrl: "http://localhost:9090",
    defaultPurpose: "analytics",
    fetch,
  });
  const result = await relata.similarImage("media-42", {
    threshold: 0.6,
    index: "ncmec",
    purpose: "investigation",
  });
  const body = JSON.parse(calls[0]!.body!);
  assert.equal(body.sql, "SIMILAR_IMAGE('media-42', THRESHOLD => 0.6, INDEX => 'ncmec')");
  assert.equal(body.purpose, "investigation");
  assert.equal(result.rows[0]!["score"], 0.99);
});

test("similarImage: defaults THRESHOLD => 0.9, no INDEX, falls back to client default purpose", async () => {
  const { fetch, calls } = mockFetch({ body: { data: [] } });
  const relata = new RelataClient({
    baseUrl: "http://localhost:9090",
    defaultPurpose: "analytics",
    fetch,
  });
  await relata.similarImage("media-42");
  const body = JSON.parse(calls[0]!.body!);
  assert.equal(body.sql, "SIMILAR_IMAGE('media-42', THRESHOLD => 0.9)");
  assert.equal(body.purpose, "analytics");
});
