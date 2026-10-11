/**
 * #3214 — bearer zeroization + response-body cap regression tests
 * (TypeScript mirror).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RelataClient } from "./client.ts";
import { ObjectClient } from "./objects.ts";
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



test("typed client (ObjectClient): response cap rejects oversized body via #parse", async () => {
  // #3214 parity: the typed clients read through _typed-http's #parse, which
  // used to call response.json()/text() unbounded — a malicious/buggy server
  // could OOM the SDK on a typed-client response. It now routes through
  // #readCappedBody like the main RelataClient path.
  const big = "x".repeat(1 << 20); // 1 MiB
  const fetch = (async () =>
    new Response(big, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
  const objects = new ObjectClient({
    baseUrl: "http://x",
    bearerToken: "tok",
    fetch,
    maxResponseBytes: 1024,
  });
  await assert.rejects(() => objects.get("Person", "p1"), ResponseTooLargeError);
});
