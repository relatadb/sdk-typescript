import assert from "node:assert/strict";
import { test } from "node:test";
import { GovernanceClient, RelataClient } from "./index.ts";

test("listWormPolicies reads the live worm_types shape", async () => {
  const f = (async () => Response.json({ worm_types: ["A", "B"], total: 2 })) as typeof fetch;
  const g = GovernanceClient.fromClient(
    new RelataClient({ baseUrl: "http://x.invalid", bearerToken: "t", fetch: f }),
  );
  assert.deepEqual(await g.listWormPolicies(), [{ type_name: "A" }, { type_name: "B" }]);
});
