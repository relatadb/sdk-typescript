import test from "node:test";
import assert from "node:assert/strict";
import { ExtractionClient, RelataClient } from "./index.ts";

function setup(status = 200, body: unknown = { ok: true }) {
  const seen: unknown[] = [];
  const f: typeof globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret");
    seen.push([init?.method, u.pathname, u.search, init?.body ? JSON.parse(String(init.body)) : null]);
    return Response.json(body, { status });
  };
  const c = ExtractionClient.fromClient(
    new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "secret", fetch: f }),
  );
  return { c, seen };
}

test("every call hits its documented route with exact bodies", async () => {
  const { c, seen } = setup();
  const s = { kind: "entity", confidence: 0.9 };
  const fix = { type: "Person", properties: { name: "Ada" } };
  await c.submit([s]);
  await c.list();
  await c.list({
    state: "pending",
    kind: "entity",
    definition: "kb",
    lowConfidence: true,
    stale: false,
    minConfidence: 0.25,
    limit: 5,
  });
  await c.get("sug/1");
  await c.accept("sug_1", "ok");
  await c.accept("sug_1", "", { acceptLowConfidence: true });
  await c.reject("sug_1", "wrong");
  await c.correct("sug_1", fix, "typo");
  await c.reopen("sug_1");
  await c.apply("kb");
  await c.apply("kb", { suggestionIds: ["sug_1"] });
  await c.entitiesExist([{ type: "Person", match: { email: "a@b.c" } }]);
  await c.entitiesExist([], { definition: "kb" });
  assert.deepEqual(seen, [
    ["POST", "/ontology/suggestions", "", { suggestions: [s] }],
    ["GET", "/ontology/suggestions", "", null],
    [
      "GET",
      "/ontology/suggestions",
      "?state=pending&kind=entity&definition=kb&low_confidence=true&stale=false&min_confidence=0.25&limit=5",
      null,
    ],
    ["GET", "/ontology/suggestions/sug%2F1", "", null],
    ["POST", "/ontology/suggestions/sug_1/decision", "", { decision: "accept", reason: "ok" }],
    ["POST", "/ontology/suggestions/sug_1/decision", "", { decision: "accept", reason: "", accept_low_confidence: true }],
    ["POST", "/ontology/suggestions/sug_1/decision", "", { decision: "reject", reason: "wrong" }],
    ["POST", "/ontology/suggestions/sug_1/decision", "", { decision: "correct", reason: "typo", correction: fix }],
    ["POST", "/ontology/suggestions/sug_1/decision", "", { decision: "reopen", reason: "" }],
    ["POST", "/ontology/suggestions/apply", "", { definition: "kb" }],
    ["POST", "/ontology/suggestions/apply", "", { definition: "kb", suggestion_ids: ["sug_1"] }],
    ["POST", "/entities/exists", "", { candidates: [{ type: "Person", match: { email: "a@b.c" } }] }],
    ["POST", "/entities/exists", "", { candidates: [], definition: "kb" }],
  ]);
});

test("a low-confidence refusal surfaces as an error carrying the problem code", async () => {
  const { c } = setup(409, { code: "suggestion-low-confidence", status: 409, title: "Suggestion Low Confidence" });
  await assert.rejects(c.accept("sug_1"), (e: unknown) => String(e).includes("409") || String(e).includes("suggestion-low-confidence"));
});
