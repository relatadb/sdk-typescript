import test from "node:test";
import assert from "node:assert/strict";
import { AssertionsClient, RelataClient } from "./index.ts";

test("evidence relation calls hit their documented routes with exact bodies", async () => {
  const seen: unknown[] = [];
  const f: typeof globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    seen.push([init?.method, u.pathname, u.search, init?.body ? JSON.parse(String(init.body)) : null]);
    return Response.json({ ok: true });
  };
  const c = AssertionsClient.fromClient(
    new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "secret", fetch: f }),
  );
  await c.relate("asr_a", "supports", "asr_b", "same passage", { locator: { pointer: "page=3" } });
  await c.relate("asr_a", "contradicts", "asr_b", "dates differ");
  await c.unrelate("rel/1", "misread");
  await c.assess("asr_a", "disputed", "two witnesses disagree");
  await c.evidenceGraph("asr_a");
  await c.evidenceGraph("asr/a", { depth: 3, limit: 10, policy: "trust", policyVersion: 2 });
  assert.deepEqual(seen, [
    [
      "POST",
      "/v1/assertions/relations",
      "",
      { from: "asr_a", to: "asr_b", kind: "supports", rationale: "same passage", locator: { pointer: "page=3" } },
    ],
    ["POST", "/v1/assertions/relations", "", { from: "asr_a", to: "asr_b", kind: "contradicts", rationale: "dates differ" }],
    ["POST", "/v1/assertions/relations/rel%2F1/revoke", "", { reason: "misread" }],
    ["POST", "/v1/assertions/asr_a/assessment", "", { judgment: "disputed", reason: "two witnesses disagree" }],
    ["GET", "/v1/assertions/asr_a/evidence-graph", "", null],
    ["GET", "/v1/assertions/asr%2Fa/evidence-graph", "?depth=3&limit=10&policy=trust&policy_version=2", null],
  ]);
});

test("similarity relations and the group threshold reach the wire", async () => {
  const seen: unknown[] = [];
  const f: typeof globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    seen.push([u.search, init?.body ? JSON.parse(String(init.body)) : null]);
    return Response.json({ ok: true });
  };
  const c = AssertionsClient.fromClient(
    new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "secret", fetch: f }),
  );
  await c.relate("a", "similar_to", "b", "same photo", { similarity: { score: 0.93, method: "phash-v1" } });
  await c.evidenceGraph("a", { minSimilarity: 0.5 });
  assert.deepEqual(seen, [
    ["", { from: "a", to: "b", kind: "similar_to", rationale: "same photo", similarity: { score: 0.93, method: "phash-v1" } }],
    ["?min_similarity=0.5", null],
  ]);
});
