/**
 * The server requires a positive `duration_secs` on `POST /v1/rules/:id/suppress`
 * (suppressions expire, #3197). Both suppressRule methods must be able to send it
 * (found by the live sweep: the old signature could never succeed).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { GovernanceClient, RelataClient } from "./index.ts";

function rec() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, bodies };
}

test("RelataClient.suppressRule sends duration_secs and reason", async () => {
  const r = rec();
  const c = new RelataClient({ baseUrl: "http://x", fetch: r.fetch });
  await c.suppressRule("r1", "e1", { durationSecs: 3600, reason: "known FP" });
  assert.deepEqual(r.bodies[0], { entity_id: "e1", duration_secs: 3600, reason: "known FP" });
});

test("GovernanceClient.suppressRule sends duration_secs and reason", async () => {
  const r = rec();
  const g = GovernanceClient.fromClient(new RelataClient({ baseUrl: "http://x", fetch: r.fetch }));
  await g.suppressRule("r1", "e1", { durationSecs: 60 });
  assert.deepEqual(r.bodies[0], { entity_id: "e1", duration_secs: 60 });
});
