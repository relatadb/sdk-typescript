import test from "node:test";
import assert from "node:assert/strict";
import { FreshnessClient, RelataClient, freshnessHeaders } from "./index.ts";

function client(fetchImpl: typeof globalThis.fetch): FreshnessClient {
  return FreshnessClient.fromClient(
    new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "secret", fetch: fetchImpl }),
  );
}

test("status reads GET /v1/freshness/status with inherited auth", async () => {
  const f: typeof globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/v1/freshness/status");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret");
    return Response.json({ contract: "relata.freshness/v1", token: "fv1.x", indexes: [] });
  };
  assert.equal((await client(f).status())["token"], "fv1.x");
});

test("barrier posts the exact body and omits unset options", async () => {
  const bodies: unknown[] = [];
  const f: typeof globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/v1/freshness/barrier");
    assert.equal(init?.method, "POST");
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ freshness: { status: "complete" } });
  };
  const c = client(f);
  await c.barrier("fv1.t", { indexes: ["lexical", "vector"], waitMs: 250, requireDurable: true });
  await c.barrier("fv1.t");
  assert.deepEqual(bodies, [
    { token: "fv1.t", indexes: ["lexical", "vector"], wait_ms: 250, require_durable: true },
    { token: "fv1.t" },
  ]);
});

test("a 503 not-ready response is thrown, never returned as success", async () => {
  const f: typeof globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ code: "freshness-not-ready", status: 503, title: "x", type: "t" }),
      { status: 503, headers: { "content-type": "application/problem+json" } },
    );
  await assert.rejects(() => client(f).barrier("fv1.t", { waitMs: 1 }));
});

test("freshnessHeaders builds the gating headers", () => {
  assert.deepEqual(freshnessHeaders("tok"), { "X-Relata-Min-Version": "tok" });
  assert.deepEqual(
    freshnessHeaders("tok", { indexes: ["vector"], waitMs: 50, requireDurable: true, partial: true }),
    {
      "X-Relata-Min-Version": "tok",
      "X-Relata-Require-Index": "vector",
      "X-Relata-Wait-Ms": "50",
      "X-Relata-Require-Durable": "true",
      "X-Relata-Freshness-Mode": "partial",
    },
  );
});
