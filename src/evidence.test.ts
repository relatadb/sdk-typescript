import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceClient, RelataClient, evidenceHeaders } from "./index.ts";

test("headers record and bound retention", () => {
  assert.deepEqual(evidenceHeaders(), { "X-Relata-Record-Evidence": "true" });
  assert.deepEqual(evidenceHeaders({ retentionDays: 7 }), {
    "X-Relata-Record-Evidence": "true",
    "X-Relata-Evidence-Retention-Days": "7",
  });
});

test("list, get and replay hit the documented routes with inherited auth", async () => {
  const seen: unknown[] = [];
  const f: typeof globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret");
    seen.push([init?.method, u.pathname, u.search, init?.body ? JSON.parse(String(init.body)) : null]);
    return Response.json({ items: [], citations: [{ outcome: "verified" }] });
  };
  const c = EvidenceClient.fromClient(
    new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "secret", fetch: f }),
  );
  await c.list({ limit: 5 });
  await c.get("evd_a/b");
  const out = await c.replay("evd_1", { includeContent: true });
  await c.replay("evd_1");
  assert.equal((out["citations"] as { outcome: string }[])[0]?.outcome, "verified");
  assert.deepEqual(seen, [
    ["GET", "/evidence", "?limit=5", null],
    ["GET", "/evidence/evd_a%2Fb", "", null],
    ["POST", "/evidence/evd_1/replay", "", { include_content: true }],
    ["POST", "/evidence/evd_1/replay", "", {}],
  ]);
});
