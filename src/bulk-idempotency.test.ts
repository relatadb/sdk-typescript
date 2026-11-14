/**
 * Automatic `Idempotency-Key` on bulk ingest (#5689, owner decision D06).
 *
 * Every `POST /v1/ingest/bulk` gets a generated key when the caller sent none,
 * the same key is reused by the client's retries (network errors, 502, 504;
 * never a 503 from Relata), and an explicit key is never replaced. The queued
 * `/v1/ingest` door takes no key and is never retried.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { IngestClient } from "./ingest.ts";
import { RelataClient } from "./client.ts";

type Seen = { url: string; headers: Headers; body: string | undefined };

/** Fetch mock: each entry is a status to answer, or "network" to throw. */
function scripted(replies: Array<number | "network">): {
  fetch: typeof globalThis.fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({
      url: typeof url === "string" ? url : url.toString(),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const reply = replies.shift() ?? 200;
    if (reply === "network") throw new TypeError("fetch failed: socket hang up");
    return new Response(JSON.stringify({ inserted: 1, errors: [], task_id: "itsk_1" }), {
      status: reply,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROWS = [{ note: "keyless" }];

function ingest(fetch: typeof globalThis.fetch, maxRetries = 0): IngestClient {
  return new IngestClient({ baseUrl: "http://x", fetch, maxRetries, retryBackoffMs: 0 });
}

test("each bulk call gets its own automatic UUID key", async () => {
  const { fetch, seen } = scripted([]);
  const client = ingest(fetch);
  await client.bulk("Note", ROWS, { onConflict: "upsert" });
  await client.bulk("Note", ROWS, { onConflict: "upsert" });
  const keys = seen.map((s) => s.headers.get("Idempotency-Key") ?? "");
  assert.ok(seen.every((s) => s.url === "http://x/v1/ingest/bulk"));
  assert.ok(keys.every((k) => UUID.test(k)), keys.join(","));
  assert.notEqual(keys[0], keys[1]);
});

test("an explicit key is never replaced", async () => {
  const { fetch, seen } = scripted([]);
  await ingest(fetch).bulk("Note", ROWS, { idempotencyKey: "batch-7" });
  assert.equal(seen[0]?.headers.get("Idempotency-Key"), "batch-7");
});

test("retries on 502/504 and network errors reuse the same key", async () => {
  const { fetch, seen } = scripted([502, "network", 504]);
  await ingest(fetch, 3).bulk("Note", ROWS, { onConflict: "upsert" });
  assert.equal(seen.length, 4);
  const keys = new Set(seen.map((s) => s.headers.get("Idempotency-Key")));
  assert.equal(keys.size, 1);
  assert.equal(seen[0]?.body, seen[3]?.body);
});

test("a 503 from Relata is not retried even with a key", async () => {
  const { fetch, seen } = scripted([503, 200]);
  await assert.rejects(ingest(fetch, 2).bulk("Note", ROWS, { onConflict: "upsert" }));
  assert.equal(seen.length, 1);
});

test("the queued /v1/ingest door gets no key and is not retried", async () => {
  const { fetch, seen } = scripted([502, 200]);
  await assert.rejects(ingest(fetch, 2).bulk("Note", ROWS));
  assert.equal(seen.length, 1);
  assert.ok(seen[0]?.url.startsWith("http://x/v1/ingest?"));
  assert.equal(seen[0]?.headers.get("Idempotency-Key"), null);
});

test("RelataClient.ingestDocument is keyed and retried with the same key", async () => {
  const { fetch, seen } = scripted([504, 200]);
  const relata = new RelataClient({ baseUrl: "http://x", fetch, maxRetries: 1, retryBackoffMs: 0 });
  await relata.ingestDocument([{ _type: "DocumentSource", _pk: "d1" }]);
  assert.equal(seen.length, 2);
  const key = seen[0]?.headers.get("Idempotency-Key") ?? "";
  assert.ok(UUID.test(key), key);
  assert.equal(seen[1]?.headers.get("Idempotency-Key"), key);
});
