import assert from "node:assert/strict";
import test from "node:test";
import { TenantAdminClient } from "./tenants.ts";

for (const options of [{}, { tier: "enterprise", fields: { name: "Acme" } }]) {
  test(`tenant create wire contract ${JSON.stringify(options)}`, async () => {
    let requests = 0;
    const client = new TenantAdminClient({
      baseUrl: "http://data",
      adminBaseUrl: "http://admin",
      fetch: async (url, init) => {
        requests++;
        assert.equal(String(url), "http://admin/platform/tenants");
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(String(init?.body)), {
          id: "acme", tier: options.tier ?? "standard", ...options.fields,
        });
        return new Response(JSON.stringify({ id: "acme" }), {
          status: 201, headers: { "content-type": "application/json" },
        });
      },
    });
    assert.deepEqual(await client.create("acme", options), { id: "acme" });
    assert.equal(requests, 1);
  });
}
