// Tests for the jobs/workflows SDK surface (#723) — SystemClient methods.
//
// Mirrors the client.test.ts mockFetch pattern: stub the wire, assert the
// route + method, and verify the typed response.

import { deepEqual } from "node:assert";
import { test } from "node:test";
import { SystemClient } from "./system.ts";

type MockResponse = { status?: number; body?: unknown };
type Call = { url: string; method: string; body: string | undefined };

function mockFetch(responses: MockResponse[] | MockResponse) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = typeof url === "string" ? url : url.toString();
    const body = typeof init?.body === "string" ? (init.body as string) : undefined;
    const entry: Call = {
      url: urlString,
      method: init?.method ?? "GET",
      body,
    };
    calls.push(entry);
    const next = queue.shift() ?? { body: {} };
    const status = next.status ?? 200;
    const bodyText =
      typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {});
    const headers = new Headers({ "content-type": "application/json" });
    return new Response(bodyText, { status, headers });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const BASE = "http://localhost:9090";

test("jobStatus: GET /jobs/:name", async () => {
  const { fetch, calls } = mockFetch({ body: { name: "c2_beacon", status: "Running" } });
  const s = new SystemClient({ baseUrl: BASE, fetch });
  const got = (await s.jobStatus("c2_beacon")) as { status: string };
  const c = calls[0]!;
  deepEqual(got.status, "Running");
  deepEqual(c.method, "GET");
  if (!c.url.includes("/jobs/c2_beacon")) throw new Error(`url=${c.url}`);
});

test("runWorkflow: POST /workflows/:name/run returns run_id", async () => {
  const { fetch, calls } = mockFetch({
    body: { run_id: "enrich/abc-123", status: "Running" },
  });
  const s = new SystemClient({ baseUrl: BASE, fetch });
  const got = (await s.runWorkflow("enrich")) as { run_id: string };
  const c = calls[0]!;
  deepEqual(got.run_id, "enrich/abc-123");
  deepEqual(c.method, "POST");
  if (!c.url.includes("/workflows/enrich/run")) throw new Error(`url=${c.url}`);
});

test("workflowRun: surfaces attempt_count + last_error (#711/#713)", async () => {
  const { fetch } = mockFetch({
    body: {
      run_id: "enrich/abc-123",
      workflow_name: "enrich",
      status: "Failed",
      attempt_count: 3,
      last_error: "embed timeout",
      steps: [],
    },
  });
  const s = new SystemClient({ baseUrl: BASE, fetch });
  const got = await s.workflowRun("enrich/abc-123");
  deepEqual(got.attempt_count, 3);
  deepEqual(got.last_error, "embed timeout");
});

test("registerWorkflow: POST /workflows with steps", async () => {
  const { fetch, calls } = mockFetch({ body: { name: "wf" } });
  const s = new SystemClient({ baseUrl: BASE, fetch });
  await s.registerWorkflow("wf", [{ name: "q1", kind: "query", sql: "SELECT 1" }]);
  const c = calls[0]!;
  deepEqual(c.method, "POST");
  if (!c.url.endsWith("/workflows")) throw new Error(`url=${c.url}`);
  if (c.body === undefined || !c.body.includes('"name":"wf"')) throw new Error(`body=${c.body}`);
});

test("feedChannels: GET /feed/channels (#2254)", async () => {
  const { fetch, calls } = mockFetch({ body: { channels: ["threat-intel", "ioc-feed"] } });
  const s = new SystemClient({ baseUrl: BASE, fetch });
  const got = (await s.feedChannels()) as { channels: string[] };
  const c = calls[0]!;
  deepEqual(c.method, "GET");
  deepEqual(got.channels, ["threat-intel", "ioc-feed"]);
  if (!c.url.endsWith("/feed/channels")) throw new Error(`url=${c.url}`);
});
