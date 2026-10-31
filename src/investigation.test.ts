import test from "node:test";
import assert from "node:assert/strict";
import { InvestigationClient, RelataClient } from "./index.ts";

function setup(status = 200, body: unknown = { ok: true }) {
  const seen: unknown[] = [];
  const f: typeof globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret");
    seen.push([init?.method, u.pathname, u.search, init?.body ? JSON.parse(String(init.body)) : null]);
    return Response.json(body, { status });
  };
  const c = InvestigationClient.fromClient(
    new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "secret", fetch: f }),
  );
  return { c, seen };
}

test("every call hits its documented route with exact bodies", async () => {
  const { c, seen } = setup();
  await c.alertEvidence("a/1");
  await c.alertEvidence("a1", { maxEvents: 5, deadlineMs: 900 });
  await c.alertTimeline("a1");
  await c.alertTimeline("a1", { deadlineMs: 10 });
  await c.pivot("a1");
  await c.pivot("a1", {
    field: "user",
    value: "alice",
    targetField: "owner",
    targetTypes: ["Session"],
    limit: 3,
    deadlineMs: 50,
  });
  await c.createSavedSearch({ name: "n", sql: "SELECT 1", purpose: "audit", description: "d", params: ["x"] });
  await c.listSavedSearches();
  await c.listSavedSearches({ q: "fail", limit: 7 });
  await c.getSavedSearch("ss/1");
  await c.updateSavedSearch("ss-1", { name: "n", sql: "SELECT 2" }, { expectedVersion: 3 });
  await c.deleteSavedSearch("ss-1");
  await c.runSavedSearch("ss-1");
  await c.runSavedSearch("ss-1", { params: [1, null] });
  assert.deepEqual(seen, [
    ["GET", "/v1/alerts/a%2F1/evidence", "", null],
    ["GET", "/v1/alerts/a1/evidence", "?max_events=5&deadline_ms=900", null],
    ["GET", "/v1/alerts/a1/timeline", "", null],
    ["GET", "/v1/alerts/a1/timeline", "?deadline_ms=10", null],
    ["POST", "/v1/alerts/a1/pivot", "", {}],
    [
      "POST",
      "/v1/alerts/a1/pivot",
      "",
      { field: "user", value: "alice", target_field: "owner", target_types: ["Session"], limit: 3, deadline_ms: 50 },
    ],
    [
      "POST",
      "/v1/search/saved",
      "",
      { name: "n", sql: "SELECT 1", purpose: "audit", description: "d", params: ["x"] },
    ],
    ["GET", "/v1/search/saved", "", null],
    ["GET", "/v1/search/saved", "?q=fail&limit=7", null],
    ["GET", "/v1/search/saved/ss%2F1", "", null],
    ["PUT", "/v1/search/saved/ss-1", "", { name: "n", sql: "SELECT 2", expected_version: 3 }],
    ["DELETE", "/v1/search/saved/ss-1", "", null],
    ["POST", "/v1/search/saved/ss-1/run", "", {}],
    ["POST", "/v1/search/saved/ss-1/run", "", { params: [1, null] }],
  ]);
});

test("a refusal surfaces with its problem code", async () => {
  const { c } = setup(403, { code: "pivot-not-authorized", status: 403, title: "Pivot not authorized" });
  await assert.rejects(c.pivot("a1", { value: "bob" }), /pivot-not-authorized|403/);
});
