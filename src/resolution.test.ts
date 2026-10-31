import test from "node:test";
import assert from "node:assert/strict";
import { ResolutionClient, RelataClient } from "./index.ts";

function setup(status = 200, body: unknown = { ok: true }) {
  const seen: unknown[] = [];
  const f: typeof globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret");
    seen.push([init?.method, u.pathname, u.search, init?.body ? JSON.parse(String(init.body)) : null]);
    return Response.json(body, { status });
  };
  const c = ResolutionClient.fromClient(
    new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "secret", fetch: f }),
  );
  return { c, seen };
}

test("every call hits its documented route with exact bodies", async () => {
  const { c, seen } = setup();
  const d = { entity_type: "Person" };
  await c.listRulesets();
  await c.getRuleset("people");
  await c.getRuleset("people", { version: 2 });
  await c.publishRuleset("people", d, { expectedVersion: 1 });
  await c.run("people");
  await c.run("people", { proposals: [{ rule: "m", a: "x", b: "y", score: 0.9 }] });
  await c.evaluate("people", [{ a: "x", b: "y", same: true }]);
  await c.listCandidates();
  await c.listCandidates({ ruleset: "people", state: "pending", limit: 5 });
  await c.getCandidate("cand_1");
  await c.approve("cand_1", "same mailbox");
  await c.reject("cand_2", "different people");
  await c.unmerge("cand_1", "wrong");
  await c.getEntity("ent_1");
  await c.lookup("Person", "r 1");
  assert.deepEqual(seen, [
    ["GET", "/v1/resolution/rulesets", "", null],
    ["GET", "/v1/resolution/rulesets/people", "", null],
    ["GET", "/v1/resolution/rulesets/people", "?version=2", null],
    ["PUT", "/v1/resolution/rulesets/people", "", { expected_version: 1, definition: d }],
    ["POST", "/v1/resolution/rulesets/people/run", "", {}],
    ["POST", "/v1/resolution/rulesets/people/run", "", { proposals: [{ rule: "m", a: "x", b: "y", score: 0.9 }] }],
    ["POST", "/v1/resolution/rulesets/people/evaluate", "", { labeled: [{ a: "x", b: "y", same: true }] }],
    ["GET", "/v1/resolution/candidates", "", null],
    ["GET", "/v1/resolution/candidates", "?ruleset=people&state=pending&limit=5", null],
    ["GET", "/v1/resolution/candidates/cand_1", "", null],
    ["POST", "/v1/resolution/candidates/cand_1/decision", "", { decision: "approve", reason: "same mailbox" }],
    ["POST", "/v1/resolution/candidates/cand_2/decision", "", { decision: "reject", reason: "different people" }],
    ["POST", "/v1/resolution/candidates/cand_1/decision", "", { decision: "unmerge", reason: "wrong" }],
    ["GET", "/v1/resolution/entities/ent_1", "", null],
    ["GET", "/v1/resolution/lookup", "?type=Person&id=r+1", null],
  ]);
});

test("names are path-quoted and a 412 is thrown, never returned", async () => {
  const q = setup();
  await q.c.getRuleset("a/b c");
  assert.equal((q.seen[0] as string[])[1], "/v1/resolution/rulesets/a%2Fb%20c");
  const { c } = setup(412, { code: "resolution-version-conflict", status: 412, title: "x", detail: "d" });
  await assert.rejects(() => c.publishRuleset("people", {}, { expectedVersion: 0 }));
});
