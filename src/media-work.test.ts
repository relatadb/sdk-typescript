import test from "node:test";
import assert from "node:assert/strict";
import { IngestClient, MediaWorkClient, RelataClient, mediaWorkClaimHeaders } from "./index.ts";

test("media work routes and bodies", async () => {
  const seen: unknown[] = [];
  const f: typeof globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    seen.push([init?.method, u.pathname, u.search, init?.body ? JSON.parse(String(init.body)) : null]);
    return Response.json({ items: [{ work_id: "w/1", claim_id: 7 }] });
  };
  const c = MediaWorkClient.fromClient(
    new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "s", fetch: f }),
  );
  const out = await c.claim("etl-1", { maxItems: 2, leaseMs: 5000 });
  assert.equal((out["items"] as { claim_id: number }[])[0]?.claim_id, 7);
  await c.list({ state: "queued", limit: 3 });
  await c.list();
  await c.get("w/1");
  await c.heartbeat("w/1", 7, { leaseMs: 9000 });
  await c.complete("w/1", 7, { producerVersion: "v1", batches: 2, children: 5 });
  await c.fail("w/1", 7, { failureClass: "permanent", code: "bad", detail: "corrupt" });
  await c.requeue("w/1");
  assert.deepEqual(seen, [
    ["POST", "/v1/media/work/claim", "", { claimant: "etl-1", max_items: 2, lease_ms: 5000 }],
    ["GET", "/v1/media/work", "?state=queued&limit=3", null],
    ["GET", "/v1/media/work", "", null],
    ["GET", "/v1/media/work/w%2F1", "", null],
    ["POST", "/v1/media/work/w%2F1/heartbeat", "", { claim_id: 7, lease_ms: 9000 }],
    ["POST", "/v1/media/work/w%2F1/complete", "", { claim_id: 7, producer_version: "v1", batches: 2, children: 5 }],
    ["POST", "/v1/media/work/w%2F1/fail", "", { claim_id: 7, class: "permanent", code: "bad", detail: "corrupt" }],
    ["POST", "/v1/media/work/w%2F1/requeue", "", {}],
  ]);
  await assert.rejects(() => c.list({ state: "bogus" as never }));
  await assert.rejects(() => c.fail("w", 1, { failureClass: "sometimes" as never }));
});

test("bulk write-back carries X-Relata-Claim on /v1/ingest/bulk", async () => {
  let path = "";
  let claim: string | null = null;
  const f: typeof globalThis.fetch = async (input, init) => {
    path = new URL(String(input)).pathname;
    claim = new Headers(init?.headers).get("X-Relata-Claim");
    return Response.json({ inserted: 1 });
  };
  const ing = IngestClient.fromClient(
    new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "s", fetch: f }),
  );
  await ing.bulk("MediaSegment", [{ _pk: "a" }], {
    durability: "sync",
    idempotencyKey: "media/w/v1/1",
    sourceCheckpoint: { source: "openetl/media/w", position: "1" },
    mediaWorkClaim: 7,
  });
  assert.equal(path, "/v1/ingest/bulk");
  assert.equal(claim, "7");
  assert.deepEqual(mediaWorkClaimHeaders(7), { "X-Relata-Claim": "7" });
});
