/**
 * #3212 — URL path/query-injection regression tests (TypeScript mirror).
 *
 * Each payload feeds the characters `../`, `?`, `#`, `&` into a path-segment or
 * query-param helper and asserts the outgoing URL is percent-encoded, so the
 * payload can neither traverse the path nor smuggle an extra query parameter.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RelataClient, pathSegment } from "./client.ts";
import { TenantAdminClient } from "./tenants.ts";
import { GovernanceClient } from "./governance.ts";
import { A2AClient } from "./a2a.ts";

function mockFetch() {
  const calls: Array<{ url: string }> = [];
  const fetch = (async (url: string | URL | Request) => {
    calls.push({ url: typeof url === "string" ? url : url.toString() });
    const headerMap = new Headers();
    headerMap.set("content-type", "application/json");
    return new Response(JSON.stringify({}), { status: 200, headers: headerMap });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const BASE = "http://x";

test("pathSegment encodes reserved characters", () => {
  assert.equal(pathSegment("../x"), "..%2Fx");
  assert.equal(pathSegment("a?b"), "a%3Fb");
  assert.equal(pathSegment("a#b"), "a%23b");
  assert.equal(pathSegment("a&b"), "a%26b");
  assert.equal(pathSegment("plain"), "plain");
});

test("url injection: tenant delete path is percent-encoded", async () => {
  const { fetch, calls } = mockFetch();
  const relata = new RelataClient({ baseUrl: BASE, bearerToken: "t", fetch });
  await TenantAdminClient.fromClient(relata).delete("../x");
  assert.equal(calls[0]?.url, `${BASE}/platform/tenants/..%2Fx`);
});

test("url injection: governance disable path is percent-encoded", async () => {
  const { fetch, calls } = mockFetch();
  const relata = new RelataClient({ baseUrl: BASE, bearerToken: "t", defaultPurpose: "p", fetch });
  await GovernanceClient.fromClient(relata).disableRule("a?b#c&d");
  assert.equal(calls[0]?.url, `${BASE}/rules/a%3Fb%23c%26d`);
});

test("url injection: a2a getTask path is percent-encoded", async () => {
  const { fetch, calls } = mockFetch();
  const relata = new RelataClient({ baseUrl: BASE, bearerToken: "t", fetch });
  await A2AClient.fromClient(relata).getTask("a#b?c&d/../e");
  assert.equal(calls[0]?.url, `${BASE}/a2a/tasks/a%23b%3Fc%26d%2F..%2Fe`);
});

test("url injection: exportData query params are percent-encoded", async () => {
  const { fetch, calls } = mockFetch();
  const relata = new RelataClient({ baseUrl: BASE, bearerToken: "t", fetch });
  await relata.exportData("Person&purpose=admin");
  const url = new URL(calls[0]?.url ?? "");
  assert.equal(url.pathname, "/export");
  // The '&' in the type must be percent-encoded so it cannot smuggle a second
  // 'purpose' query parameter.
  assert.equal(url.searchParams.get("type"), "Person&purpose=admin");
  assert.equal(url.searchParams.get("purpose"), "export");
  assert.ok(!calls[0]?.url.includes("Person&purpose=admin&"));
});

test("url injection: flat-client rule/session/webhook paths are percent-encoded", async () => {
  const { fetch, calls } = mockFetch();
  const relata = new RelataClient({ baseUrl: BASE, bearerToken: "t", fetch });
  await relata.disableRule("../r");
  await relata.deleteWebhook("w?1");
  await relata.sessionDiff("s#1");
  await relata.clusterDrain("n&1");
  assert.equal(calls[0]?.url, `${BASE}/rules/..%2Fr`);
  assert.equal(calls[1]?.url, `${BASE}/webhooks/w%3F1`);
  assert.equal(calls[2]?.url, `${BASE}/session/s%231/diff`);
  assert.equal(calls[3]?.url, `${BASE}/cluster/drain/n%261`);
});
