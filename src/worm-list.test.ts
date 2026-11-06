import assert from "node:assert/strict";
import { test } from "node:test";
import { ConflictError, GovernanceClient, RelataClient } from "./index.ts";

type Seen = { method: string; path: string; body: unknown };

function gov(reply: () => Response, seen: Seen[] = []): GovernanceClient {
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      method: String(init?.method),
      path: new URL(String(input)).pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return reply();
  }) as typeof fetch;
  return GovernanceClient.fromClient(
    new RelataClient({ baseUrl: "http://x.invalid", bearerToken: "t", fetch: f }),
  );
}

const LIVE = {
  policies: [
    { object_type: "A", worm: true, retention: "indefinite", retention_secs: null },
    { object_type: "B", worm: true, retention: "indefinite", retention_secs: null },
  ],
  worm_types: ["A", "B"],
  total: 2,
};

test("listWormPolicies returns each type with its retention (#6045)", async () => {
  assert.deepEqual(await gov(() => Response.json(LIVE)).listWormPolicies(), LIVE.policies);
});

test("listWormPolicies still reads a worm_types-only server", async () => {
  const g = gov(() => Response.json({ worm_types: ["A"], total: 1 }));
  assert.deepEqual(await g.listWormPolicies(), [{ object_type: "A", worm: true }]);
});

test("setWormPolicy without retention requests the indefinite lock", async () => {
  const seen: Seen[] = [];
  await gov(() => Response.json({ object_type: "A", worm: true }, { status: 201 }), seen)
    .setWormPolicy("A");
  assert.deepEqual(seen, [{ method: "POST", path: "/v1/retention/worm/A", body: {} }]);
});

test("a finite retention on an existing WORM type surfaces the 409", async () => {
  const problem = {
    type: "https://relatadb.dev/errors/worm-retention-cannot-shorten",
    title: "WORM retention cannot be shortened",
    status: 409,
  };
  const g = gov(() =>
    new Response(JSON.stringify(problem), {
      status: 409,
      headers: { "content-type": "application/problem+json" },
    }));
  await assert.rejects(g.setWormPolicy("A", 60), ConflictError);
});
