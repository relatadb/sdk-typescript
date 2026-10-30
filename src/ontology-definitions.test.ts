import test from "node:test";
import assert from "node:assert/strict";
import { OntologyDefinitionsClient, RelataClient } from "./index.ts";

function setup(status = 200, body: unknown = { ok: true }) {
  const seen: unknown[] = [];
  const f: typeof globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret");
    seen.push([init?.method, u.pathname, u.search, init?.body ? JSON.parse(String(init.body)) : null]);
    return Response.json(body, { status });
  };
  const c = OntologyDefinitionsClient.fromClient(
    new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "secret", fetch: f }),
  );
  return { c, seen };
}

test("every call hits its documented route with exact bodies", async () => {
  const { c, seen } = setup();
  const d = { objects: [{ name: "Person" }] };
  await c.list();
  await c.create("crm", d);
  await c.get("crm");
  await c.saveDraft("crm", d);
  await c.validate("crm");
  await c.validate("crm", d);
  await c.compare("crm", { from: 1, to: "draft" });
  await c.compare("crm");
  await c.publish("crm", { expectedVersion: 1, acceptMigration: true, fromVersion: 1 });
  await c.publish("crm", { expectedVersion: 0 });
  await c.version("crm", 2);
  await c.status("crm");
  await c.migration("crm", 2);
  await c.runMigration("crm", 2, { maxRows: 10, retryFailed: true });
  await c.runMigration("crm", 2);
  assert.deepEqual(seen, [
    ["GET", "/ontology/definitions", "", null],
    ["POST", "/ontology/definitions", "", { name: "crm", definition: d }],
    ["GET", "/ontology/definitions/crm", "", null],
    ["PUT", "/ontology/definitions/crm/draft", "", { definition: d }],
    ["POST", "/ontology/definitions/crm/validate", "", {}],
    ["POST", "/ontology/definitions/crm/validate", "", { definition: d }],
    ["GET", "/ontology/definitions/crm/compare", "?from=1&to=draft", null],
    ["GET", "/ontology/definitions/crm/compare", "", null],
    ["POST", "/ontology/definitions/crm/publish", "", { expected_version: 1, accept_migration: true, from_version: 1 }],
    ["POST", "/ontology/definitions/crm/publish", "", { expected_version: 0 }],
    ["GET", "/ontology/definitions/crm/versions/2", "", null],
    ["GET", "/ontology/definitions/crm/status", "", null],
    ["GET", "/ontology/definitions/crm/migrations/2", "", null],
    ["POST", "/ontology/definitions/crm/migrations/2/run", "", { max_rows: 10, retry_failed: true }],
    ["POST", "/ontology/definitions/crm/migrations/2/run", "", {}],
  ]);
});

test("names are path-quoted and a 412 is thrown, never returned", async () => {
  const q = setup();
  await q.c.get("a/b c");
  assert.equal((q.seen[0] as string[])[1], "/ontology/definitions/a%2Fb%20c");
  const { c } = setup(412, { code: "ontology-version-conflict", status: 412, title: "x", detail: "d" });
  await assert.rejects(() => c.publish("crm", { expectedVersion: 1 }));
});
