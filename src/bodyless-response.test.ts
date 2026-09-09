/**
 * #5278 — body-less HTTP responses (HEAD requests, and 204/205/304 status
 * codes) must resolve immediately instead of parking the calling promise
 * forever.
 *
 * `fetch()`/undici set `response.body` to `null` for these responses (RFC
 * 9110 §6.4.1). Every body reader in this SDK used to fall back to
 * `response.body ?? new ReadableStream<Uint8Array>()` — a bare
 * `ReadableStream` with no underlying source never enqueues a chunk and
 * never closes, so `reader.read()` against it never settles. Because the
 * per-attempt timeout timer in `RelataClient`/`TypedClientBase`/`S3Client`
 * only bounds `fetch()` itself (already resolved with headers by the time
 * the body read starts), the timeout could not rescue a stalled body read
 * either — hence the bounded-timeout guard on every test below: if the fix
 * regresses, these tests fail fast instead of hanging the suite.
 *
 * Same null-body shape IntOps#4977 fixed at its S3 door; this ticket closes
 * the identical latent gap in the main `RelataClient`/typed-client/`S3Client`
 * paths (`_body.ts::bodyOrClosedStream`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RelataClient } from "./client.ts";
import { S3Client } from "./s3.ts";
import { ObjectClient } from "./objects.ts";

/** Bounded wait so a regression (a stalled body read) fails fast, not hangs. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("RelataClient: a 204 No Content response (null body) resolves promptly", async () => {
  const fetch = (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
  const relata = new RelataClient({ baseUrl: "http://x", defaultPurpose: "p", fetch });
  const result = await withTimeout(
    relata.request<Record<string, unknown>>("GET", "/health"),
    2000,
    "RelataClient 204 request",
  );
  assert.deepEqual(result, {});
});

// Note: 304 is a genuinely body-less status per RFC 9110 §6.4.1 and is
// listed in the issue alongside 204/205, but this SDK's own redirect guard
// (`assertNotRedirected` / `isRedirectResponse` in `errors.ts`, unrelated to
// this fix) already treats every 300-399 status — 304 included — as a
// blocked redirect and throws `NetworkError` *before* any body is ever read.
// So 304 never reaches the body-reading code on any of this SDK's call
// paths; 204/205/HEAD (below) are the reachable body-less cases this fix
// covers.

test("S3Client: HEAD response (null body) resolves promptly", async () => {
  const fetch = (async () => new Response(null, { status: 200 })) as typeof globalThis.fetch;
  const s3 = new S3Client("http://x", { fetch });
  const result = await withTimeout(s3.http("HEAD", "/bucket/key"), 2000, "S3Client HEAD request");
  assert.equal(result.status, 200);
  assert.equal(result.body.byteLength, 0);
});

test("S3Client: DELETE returning 204 (null body) resolves promptly", async () => {
  const fetch = (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
  const s3 = new S3Client("http://x", { fetch });
  const result = await withTimeout(
    s3.deleteObject("bucket", "key"),
    2000,
    "S3Client DELETE request",
  );
  assert.equal(result.status, 204);
  assert.equal(result.body.byteLength, 0);
});

test("S3Client: getObjectStream against a null-body response drains immediately", async () => {
  const fetch = (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
  const s3 = new S3Client("http://x", { fetch });
  const stream = await withTimeout(
    s3.getObjectStream("bucket", "key"),
    2000,
    "S3Client getObjectStream request",
  );
  assert.equal(stream.status, 204);
  const reader = stream.body.getReader();
  const { done } = await withTimeout(reader.read(), 2000, "getObjectStream body read");
  assert.equal(done, true);
});

test("typed client (ObjectClient): a 205 Reset Content response (null body) resolves promptly", async () => {
  const fetch = (async () => new Response(null, { status: 205 })) as typeof globalThis.fetch;
  const objects = new ObjectClient({ baseUrl: "http://x", bearerToken: "tok", fetch });
  await withTimeout(objects.get("Person", "p1"), 2000, "ObjectClient 205 request");
});
