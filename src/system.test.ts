// Tests for the jobs SDK surface (#723) — SystemClient methods.
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

test("feedChannels: GET /feed/channels (#2254)", async () => {
  const { fetch, calls } = mockFetch({ body: { channels: ["threat-intel", "ioc-feed"] } });
  const s = new SystemClient({ baseUrl: BASE, fetch });
  const got = (await s.feedChannels()) as { channels: string[] };
  const c = calls[0]!;
  deepEqual(c.method, "GET");
  deepEqual(got.channels, ["threat-intel", "ioc-feed"]);
  if (!c.url.endsWith("/feed/channels")) throw new Error(`url=${c.url}`);
});
