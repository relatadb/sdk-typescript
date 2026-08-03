/**
 * #3214 — bearer zeroization + response-body cap regression tests
 * (TypeScript mirror).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RelataClient } from "./client.ts";
import { S3Client } from "./s3.ts";
import { ClientClosedError, ResponseTooLargeError } from "./errors.ts";

test("bearer token is not reachable via a public getter", () => {
  const relata = new RelataClient({ baseUrl: "http://x", bearerToken: "s3cr3t" });
  // The documented public `bearerToken` getter was removed (#3214).
  assert.equal((relata as unknown as Record<string, unknown>)["bearerToken"], undefined);
  // The token must not surface through JSON serialisation either.
  assert.ok(!JSON.stringify(relata).includes("s3cr3t"));
});

test("close() zeroizes the token and fails closed", async () => {
  const fetch = (async () =>
    new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
  const relata = new RelataClient({ baseUrl: "http://x", bearerToken: "s3cr3t", fetch });
  assert.equal(relata.internalBearerToken, "s3cr3t");
  relata.close();
  assert.equal(relata.internalBearerToken, undefined);
  await assert.rejects(() => relata.health(), ClientClosedError);
});

test("response cap: oversized body rejects with ResponseTooLargeError", async () => {
  const big = "a".repeat(1 << 20); // 1 MiB
  const fetch = (async () =>
    new Response(big, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
  const relata = new RelataClient({
    baseUrl: "http://x",
    defaultPurpose: "p",
    fetch,
    maxResponseBytes: 1024,
  });
  await assert.rejects(() => relata.health(), ResponseTooLargeError);
});

test("response cap: body within the cap succeeds", async () => {
  const fetch = (async () =>
    new Response(JSON.stringify({ status: "ok", profile: "free", node_id: "n" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
  const relata = new RelataClient({
    baseUrl: "http://x",
    defaultPurpose: "p",
    fetch,
    maxResponseBytes: 1024,
  });
  const health = await relata.health();
  assert.equal(health.status, "ok");
});

test("S3Client: close() zeroizes the token (no Authorization sent after)", async () => {
  const calls: Array<{ headers: Record<string, string> }> = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({ headers });
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;
  const s3 = new S3Client("http://x", { bearerToken: "s3cr3t", fetch });
  await s3.listBuckets();
  assert.equal(calls[0]?.headers["authorization"], "Bearer s3cr3t");
  s3.close();
  await s3.listBuckets();
  assert.equal(calls[1]?.headers["authorization"], undefined);
});

test("S3Client: buffered http() body is capped", async () => {
  const big = "o".repeat(1 << 20); // 1 MiB
  const fetch = (async () => new Response(big, { status: 200 })) as typeof globalThis.fetch;
  const s3 = new S3Client("http://x", { fetch, maxResponseBytes: 1024 });
  await assert.rejects(() => s3.getObject("b", "k"), ResponseTooLargeError);
});

test("S3Client: getObjectStream streams without buffering whole body", async () => {
  const big = "o".repeat(1 << 20); // 1 MiB
  const fetch = (async () => new Response(big, { status: 200 })) as typeof globalThis.fetch;
  // Cap is tiny, but the streaming path must not be subject to it.
  const s3 = new S3Client("http://x", { fetch, maxResponseBytes: 1024 });
  const stream = await s3.getObjectStream("b", "k");
  assert.equal(stream.status, 200);
  let total = 0;
  const reader = stream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) total += value.byteLength;
  }
  assert.equal(total, big.length);
});
