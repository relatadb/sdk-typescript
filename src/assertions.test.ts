import test from "node:test";
import assert from "node:assert/strict";
import { AssertionsClient, RelataClient } from "./index.ts";

function setup(status = 200, body: unknown = { ok: true }) {
  const seen: unknown[] = [];
  const f: typeof globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret");
    seen.push([init?.method, u.pathname, u.search, init?.body ? JSON.parse(String(init.body)) : null]);
    return Response.json(body, { status });
  };
  const c = AssertionsClient.fromClient(
    new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "secret", fetch: f }),
  );
  return { c, seen };
}

test("every call hits its documented route with exact bodies", async () => {
  const { c, seen } = setup();
  const claim = { predicate: "city", value: "Rome" };
  await c.record(claim);
  await c.list();
  await c.list({ subjectType: "Person", subjectId: "p 1", predicate: "city", state: "confirmed", limit: 5 });
  await c.get("asr_1");
  await c.confirm("asr_1", "verified");
  await c.reject("asr/2", "stale");
  await c.revoke("asr_1", "error");
  await c.publishPolicy("trust", { precedence: ["state"] }, { expectedVersion: 2 });
  await c.getPolicy("trust");
  await c.getPolicy("trust", { version: 3 });
  await c.resolve("Person", "p1", "city", 5);
  await c.resolve("Person", "p1", "city", 5, { recordedAsOf: 9, policy: "trust", policyVersion: 2 });
  assert.deepEqual(seen, [
    ["POST", "/assertions", "", claim],
    ["GET", "/assertions", "", null],
    ["GET", "/assertions", "?subject_type=Person&subject_id=p+1&predicate=city&state=confirmed&limit=5", null],
    ["GET", "/assertions/asr_1", "", null],
    ["POST", "/assertions/asr_1/decision", "", { decision: "confirm", reason: "verified" }],
    ["POST", "/assertions/asr%2F2/decision", "", { decision: "reject", reason: "stale" }],
    ["POST", "/assertions/asr_1/revoke", "", { reason: "error" }],
    ["PUT", "/assertion-policies/trust", "", { expected_version: 2, definition: { precedence: ["state"] } }],
    ["GET", "/assertion-policies/trust", "", null],
    ["GET", "/assertion-policies/trust", "?version=3", null],
    ["GET", "/assertion-resolve", "?subject_type=Person&subject_id=p1&predicate=city&valid_at=5", null],
    [
      "GET",
      "/assertion-resolve",
      "?subject_type=Person&subject_id=p1&predicate=city&valid_at=5&recorded_as_of=9&policy=trust&policy_version=2",
      null,
    ],
  ]);
});

test("a retention refusal surfaces as an error carrying the problem code", async () => {
  const { c } = setup(409, { code: "assertion-retention-blocked", status: 409, title: "Assertion Retention Blocked" });
  await assert.rejects(c.revoke("asr_1", "x"), (e: unknown) => String(e).includes("409") || String(e).includes("assertion-retention-blocked"));
});
