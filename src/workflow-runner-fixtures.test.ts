/**
 * #5733: shared workflow-runner step fixtures (TypeScript leg).
 *
 * `sdks/shared/workflow-runner-fixtures.json` is replayed by the Python and Go SDKs and
 * checked against the Rust `relata-workflow-runner` request shape. One engine response must
 * normalize to the same error class, status, retry delay and request count in every consumer.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ForbiddenError,
  McpClient,
  NetworkError,
  NotFoundError,
  RateLimitedError,
  RelataClient,
  ServerError,
} from "./index.ts";

interface Wire {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  reset?: boolean;
}
interface Expect {
  outcome: "ok" | "error";
  error?: string;
  status?: number | null;
  retry_after_seconds?: number | null;
  requests: number;
}
interface Case {
  name: string;
  step: "job" | "query";
  wire: Wire;
  expect: Expect;
}
interface Fixtures {
  contract: string;
  requests: {
    job: { method: string; path: string; body: Record<string, unknown> };
    query: { sql: string; purpose: string };
  };
  cases: Case[];
}

const fixtures = JSON.parse(
  readFileSync(new URL("../../shared/workflow-runner-fixtures.json", import.meta.url), "utf8"),
) as Fixtures;

const KINDS: Record<string, new (...args: never[]) => Error> = {
  not_found: NotFoundError,
  rate_limited: RateLimitedError,
  server_error: ServerError,
  forbidden: ForbiddenError,
  connection: NetworkError,
};

function mock(wire: Wire): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; method: string; body: string | undefined }>;
} {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof url === "string" ? url : url.toString(),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (wire.reset) throw new TypeError("fetch failed: connection reset");
    return new Response(JSON.stringify(wire.body ?? {}), {
      status: wire.status ?? 200,
      headers: { "content-type": "application/json", ...(wire.headers ?? {}) },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test("fixture file is the documented contract", () => {
  assert.equal(fixtures.contract, "relata.workflow-runner-fixtures/v1");
  const names = fixtures.cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.length >= 8);
  assert.deepEqual(new Set(fixtures.cases.map((c) => c.step)), new Set(["job", "query"]));
});

for (const c of fixtures.cases) {
  test(`engine response normalizes to the shared outcome: ${c.name}`, async () => {
    const { fetch, calls } = mock(c.wire);
    const run = async (): Promise<unknown> => {
      if (c.step === "job") {
        const mcp = new McpClient({ baseUrl: "http://x", bearerToken: "t", fetch });
        const job = fixtures.requests.job;
        return mcp.callTool(job.body["name"] as string, job.body["arguments"] as Record<string, unknown>);
      }
      const client = new RelataClient({ baseUrl: "http://x", bearerToken: "t", fetch });
      const q = fixtures.requests.query;
      return client.query(q.sql, { purpose: q.purpose });
    };
    if (c.expect.outcome === "ok") {
      await run();
    } else {
      await assert.rejects(run(), (error: unknown) => {
        const kind = KINDS[c.expect.error ?? ""];
        assert.ok(kind !== undefined && error instanceof kind, `expected ${c.expect.error}, got ${String(error)}`);
        if (c.expect.error !== "connection") {
          const typed = error as unknown as { statusCode: number; retryAfterSeconds: number | undefined };
          assert.equal(typed.statusCode, c.expect.status);
          const want = c.expect.retry_after_seconds;
          assert.equal(typed.retryAfterSeconds, want === null ? undefined : want);
        }
        return true;
      });
    }
    assert.equal(calls.length, c.expect.requests, "a runner step is never replayed by the transport");
    if (c.step === "job") {
      const job = fixtures.requests.job;
      assert.equal(calls[0]?.method, job.method);
      assert.ok(calls[0]?.url.endsWith(job.path));
      assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), job.body);
    }
  });
}
