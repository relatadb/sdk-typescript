// #5666: cross-SDK shared RFC 9457 fixtures (TypeScript leg). See
// sdks/shared/problem-details-fixtures.json and the Rust live replay test
// (http_e2e::contract_matrix::problem_fixtures_match_live_server) that keeps it faithful.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RelataClient } from "./index.ts";
import * as errors from "./errors.ts";

interface Case {
  name: string;
  wire: { status: number; headers: Record<string, string>; body: unknown };
  expect: {
    kind: string;
    status: number;
    code: string | null;
    type: string | null;
    retryable: boolean;
    request_id: string | null;
    retry_after_seconds: number | null;
  };
}

const fixtures = JSON.parse(
  readFileSync(new URL("../../shared/problem-details-fixtures.json", import.meta.url), "utf8"),
) as { contract: string; cases: Case[] };

// Exact class per fixture kind. Unmapped statuses (405/413/415 ...) are the base class.
const KIND: Record<string, new (...a: never[]) => Error> = {
  purpose: errors.PurposeError,
  auth: errors.AuthError,
  forbidden: errors.ForbiddenError,
  not_found: errors.NotFoundError,
  conflict: errors.ConflictError,
  precondition_failed: errors.PreconditionFailedError,
  validation: errors.ValidationError,
  rate_limited: errors.RateLimitedError,
  server: errors.ServerError,
  bad_request: errors.BadRequestError,
  other: errors.RelataError,
};

test("fixture file is the documented contract", () => {
  assert.equal(fixtures.contract, "relata.problem-details-fixtures/v1");
  assert.ok(fixtures.cases.length >= 10);
  assert.equal(new Set(fixtures.cases.map((c) => c.name)).size, fixtures.cases.length);
});

for (const c of fixtures.cases) {
  test(`wire response maps to the shared expectation: ${c.name}`, async () => {
    const body = typeof c.wire.body === "string" ? c.wire.body : JSON.stringify(c.wire.body);
    const f: typeof globalThis.fetch = async () =>
      new Response(body, { status: c.wire.status, headers: c.wire.headers });
    const client = new RelataClient({
      baseUrl: "http://relata.invalid",
      bearerToken: "t",
      fetch: f,
      maxRetries: 0,
    });
    let caught: unknown;
    try {
      await client.version();
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof errors.RelataError, `${c.name}: not a RelataError: ${String(caught)}`);
    const err = caught as errors.RelataError;
    const want = KIND[c.expect.kind]!;
    assert.equal(Object.getPrototypeOf(err), want.prototype, `${c.name}: ${err.constructor.name}`);
    assert.equal(err.statusCode, c.expect.status);
    assert.equal(err.code ?? null, c.expect.code);
    assert.equal(err.typeUrl ?? null, c.expect.type);
    assert.equal(err.retryable, c.expect.retryable);
    assert.equal(err.requestId ?? null, c.expect.request_id);
    assert.equal(err.retryAfterSeconds ?? null, c.expect.retry_after_seconds);
  });
}
