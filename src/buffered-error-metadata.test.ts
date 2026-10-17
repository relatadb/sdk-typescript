/** Buffered main/typed transports must retain HTTP metadata without replay. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AuthError, BadRequestError, PurposeError, RelataClient, RelataError,
  ServerError, SystemClient } from "./index.ts";

for (const [status, detail, expected] of [
  [400, "purpose format is invalid", PurposeError],
  [400, "invalid SQL expression", BadRequestError],
  [401, "invalid bearer", AuthError],
  [503, "durability uncertain", ServerError],
] as const) {
  test(`main buffered ${status} ${expected.name} retains all problem metadata`, async () => {
    let requests = 0;
    const client = new RelataClient({ baseUrl: "http://x", defaultPurpose: "analytics", maxRetries: 3,
      fetch: (async () => {
        requests++;
        return new Response(JSON.stringify({ detail, code: "specific-code", type: "urn:relata:specific",
          query_id: "query-7", request_id: "body-request", retryable: true, retry_after: 99 }),
          { status, headers: { "content-type": "application/problem+json", "x-request-id": "header-request",
            "Retry-After": "7" } });
      }) as typeof globalThis.fetch });
    try {
      await assert.rejects(() => client.query("SELECT 1"), (error: unknown) => {
        assert.ok(error instanceof expected);
        assert.ok(error instanceof RelataError);
        assert.equal(error.statusCode, status);
        assert.equal(error.queryId, "query-7");
        assert.equal(error.requestId, "body-request");
        assert.equal(error.code, "specific-code");
        assert.equal(error.typeUrl, "urn:relata:specific");
        assert.equal(error.retryable, true);
        assert.equal(error.retryAfterSeconds, 7, "finite header takes precedence over body");
        return true;
      });
      assert.equal(requests, 1, "POST query must not replay even when marked retryable");
    } finally { await client.close(); }
  });
}

for (const typed of [false, true]) {
  for (const header of ["not-a-date", "NaN", "Infinity", "-1", "12junk"]) {
    test(`${typed ? "typed" : "main"} buffered error ignores invalid retry header ${header}`, async () => {
      const client = new RelataClient({ baseUrl: "http://x", defaultPurpose: "p", maxRetries: 0,
        fetch: (async () => new Response(JSON.stringify({ detail: "unavailable", retry_after: 13 }),
          { status: 503, headers: { "content-type": "application/problem+json", "Retry-After": header } })) as typeof globalThis.fetch });
      try {
        await assert.rejects(() => typed ? SystemClient.fromClient(client).jobsStatus() : client.query("SELECT 1"),
          (error: unknown) => {
            assert.ok(error instanceof ServerError);
            assert.equal(error.statusCode, 503);
            assert.equal(error.retryAfterSeconds, 13);
            return true;
          });
      } finally { await client.close(); }
    });
  }
  test(`${typed ? "typed" : "main"} buffered HTTP date retains finite delay`, async () => {
    const date = "Tue, 01 Jan 2030 00:00:30 GMT";
    const before = Date.now();
    const client = new RelataClient({ baseUrl: "http://x", defaultPurpose: "p", maxRetries: 0,
      fetch: (async () => new Response('{"detail":"unavailable","retry_after":999}',
        { status: 503, headers: { "content-type": "application/problem+json", "Retry-After": date } })) as typeof globalThis.fetch });
    try {
      await assert.rejects(() => typed ? SystemClient.fromClient(client).jobsStatus() : client.query("SELECT 1"),
        (error: unknown) => {
          assert.ok(error instanceof ServerError);
          const after = Date.now();
          const delay = error.retryAfterSeconds;
          assert.equal(typeof delay, "number");
          assert.ok(delay! >= Math.max(0, Math.ceil((Date.parse(date) - after) / 1000)));
          assert.ok(delay! <= Math.max(0, Math.ceil((Date.parse(date) - before) / 1000)));
          return true;
        });
    } finally { await client.close(); }
  });
  for (const text of ["null", "[]", '"failure"', "42", '{"detail":[],"code":3}', "{invalid-json"]) {
    test(`${typed ? "typed" : "main"} malformed/nonobject error ${text} retains HTTP status`, async () => {
      const client = new RelataClient({ baseUrl: "http://x", defaultPurpose: "p", maxRetries: 0,
        fetch: (async () => new Response(text, { status: 503, headers: {
          "content-type": "application/problem+json", "x-request-id": "proxy-request" } })) as typeof globalThis.fetch });
      try {
        await assert.rejects(() => typed ? SystemClient.fromClient(client).jobsStatus() : client.query("SELECT 1"),
          (error: unknown) => {
            assert.ok(error instanceof ServerError);
            assert.equal(error.statusCode, 503);
            assert.equal(error.requestId, "proxy-request");
            assert.equal(error.code, undefined);
            return true;
          });
      } finally { await client.close(); }
    });
  }
}

for (const delay of [-1, 1e300, "7", null]) {
  test(`buffered error refuses invalid body retry delay ${String(delay)}`, async () => {
    const client = new RelataClient({ baseUrl: "http://x", defaultPurpose: "p", maxRetries: 0,
      fetch: (async () => new Response(JSON.stringify({ detail: "unavailable", retry_after: delay,
        retryable: "true", query_id: 42, request_id: [] }), { status: 503,
        headers: { "content-type": "application/problem+json", "x-request-id": "valid-header" } })) as typeof globalThis.fetch });
    try {
      await assert.rejects(() => client.query("SELECT 1"), (error: unknown) => {
        assert.ok(error instanceof ServerError);
        assert.equal(error.retryAfterSeconds, undefined);
        assert.equal(error.retryable, false);
        assert.equal(error.queryId, undefined);
        assert.equal(error.requestId, "valid-header");
        return true;
      });
    } finally { await client.close(); }
  });
}

test("explicit zero Retry-After takes precedence over a positive body delay", async () => {
  const client = new RelataClient({ baseUrl: "http://x", defaultPurpose: "p", maxRetries: 0,
    fetch: (async () => new Response('{"detail":"unavailable","retry_after":13}', { status: 503,
      headers: { "content-type": "application/problem+json", "Retry-After": "0" } })) as typeof globalThis.fetch });
  try {
    await assert.rejects(() => client.query("SELECT 1"), (error: unknown) => {
      assert.ok(error instanceof ServerError);
      assert.equal(error.retryAfterSeconds, 0);
      return true;
    });
  } finally { await client.close(); }
});
