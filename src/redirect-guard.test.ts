/**
 * Tests for the redirect-hardening fix (#2364): every `fetch()` call site in
 * the TS SDK must pass an explicit `redirect: "manual"` policy, and the SDK
 * must refuse to follow a redirect response rather than silently resending
 * the `Authorization` header to whatever origin a 3xx `Location` points at.
 *
 * This is the TS-SDK analogue of the Rust SDK's
 * `redirect::Policy::none()` (#1416).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  GovernanceClient,
  Memory,
  NetworkError,
  RelataClient,
  S3Client,
} from "./index.ts";
import { assertNotRedirected, isRedirectResponse } from "./errors.ts";

// ---------------------------------------------------------------------------
// Unit tests — the shared guard itself
// ---------------------------------------------------------------------------

test("isRedirectResponse: true for a raw 3xx status", () => {
  const response = new Response("", {
    status: 302,
    headers: { location: "https://attacker.example/steal" },
  });
  assert.equal(isRedirectResponse(response), true);
});

test("isRedirectResponse: false for a normal 200/4xx/5xx response", () => {
  assert.equal(isRedirectResponse(new Response("", { status: 200 })), false);
  assert.equal(isRedirectResponse(new Response("", { status: 404 })), false);
  assert.equal(isRedirectResponse(new Response("", { status: 500 })), false);
});

test("assertNotRedirected: throws NetworkError on a 3xx response", () => {
  const response = new Response("", {
    status: 307,
    headers: { location: "https://attacker.example/steal" },
  });
  assert.throws(
    () => assertNotRedirected(response, "http://relata.local/query"),
    (err: unknown) => {
      assert.ok(err instanceof NetworkError, "should be NetworkError");
      return true;
    },
  );
});

test("assertNotRedirected: does not throw on a normal response", () => {
  assert.doesNotThrow(() =>
    assertNotRedirected(new Response("", { status: 200 }), "http://relata.local"),
  );
});

// ---------------------------------------------------------------------------
// Mock fetch — records every call it receives so tests can assert a redirect
// target was never contacted (i.e. the Authorization header was never
// resent to it).
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  redirect: RequestInit["redirect"];
  authorization: string | undefined;
}

function mockRedirectingFetch(redirectTo: string): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlString = typeof url === "string" ? url : url.toString();
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({
      url: urlString,
      redirect: init?.redirect,
      authorization: headers["authorization"],
    });
    // Simulate a 3xx redirect to a different origin. A spec-compliant
    // runtime honouring `redirect: "manual"` would hand back an opaque
    // response instead, but a raw 3xx (as some `opts.fetch` injections or
    // older polyfills would produce) must be caught defensively too.
    return new Response("", {
      status: 302,
      headers: { location: redirectTo },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const ATTACKER_ORIGIN = "https://attacker.example/steal-token";

// ---------------------------------------------------------------------------
// RelataClient.query (client.ts)
// ---------------------------------------------------------------------------

test("RelataClient.query: blocks a cross-origin redirect and never contacts it", async () => {
  const { fetch, calls } = mockRedirectingFetch(ATTACKER_ORIGIN);
  const relata = new RelataClient({
    baseUrl: "http://relata.local",
    bearerToken: "s3cr3t",
    defaultPurpose: "analytics",
    fetch,
  });

  await assert.rejects(() => relata.query("SELECT * FROM Person"));

  assert.equal(calls.length, 1, "must not have followed the redirect");
  assert.equal(calls[0]?.redirect, "manual");
  assert.equal(calls[0]?.authorization, "Bearer s3cr3t");
  assert.ok(
    !calls.some((c) => c.url.startsWith(ATTACKER_ORIGIN)),
    "the attacker origin must never be contacted",
  );
});

// ---------------------------------------------------------------------------
// Typed clients (_typed-http.ts) via GovernanceClient
// ---------------------------------------------------------------------------

test("GovernanceClient: blocks a cross-origin redirect and never contacts it", async () => {
  const { fetch, calls } = mockRedirectingFetch(ATTACKER_ORIGIN);
  const relata = new RelataClient({
    baseUrl: "http://relata.local",
    bearerToken: "s3cr3t",
    fetch,
  });
  const governance = GovernanceClient.fromClient(relata);

  await assert.rejects(() => governance.listRetentionPolicies());

  assert.equal(calls.length, 1, "must not have followed the redirect");
  assert.equal(calls[0]?.redirect, "manual");
  assert.equal(calls[0]?.authorization, "Bearer s3cr3t");
});

// ---------------------------------------------------------------------------
// Memory (memory.ts)
// ---------------------------------------------------------------------------

test("Memory.add: blocks a cross-origin redirect and never contacts it", async () => {
  const { fetch, calls } = mockRedirectingFetch(ATTACKER_ORIGIN);
  const memory = new Memory("http://relata.local", {
    purpose: "agent-notes",
    bearerToken: "s3cr3t",
    fetch,
  });

  await assert.rejects(() => memory.add("Alice prefers dark mode"));

  assert.equal(calls.length, 1, "must not have followed the redirect");
  assert.equal(calls[0]?.redirect, "manual");
  assert.equal(calls[0]?.authorization, "Bearer s3cr3t");
});

// ---------------------------------------------------------------------------
// S3Client (s3.ts)
// ---------------------------------------------------------------------------

test("S3Client.http: blocks a cross-origin redirect and never contacts it", async () => {
  const { fetch, calls } = mockRedirectingFetch(ATTACKER_ORIGIN);
  const s3 = new S3Client("http://relata.local", {
    bearerToken: "s3cr3t",
    fetch,
  });

  await assert.rejects(() => s3.listBuckets());

  assert.equal(calls.length, 1, "must not have followed the redirect");
  assert.equal(calls[0]?.redirect, "manual");
  assert.equal(calls[0]?.authorization, "Bearer s3cr3t");
});
