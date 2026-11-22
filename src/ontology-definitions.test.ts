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
  await c.publish("crm", { expectedVersion: 1, acceptMigration: true, fromVersion: 1, overrideUnsafe: true });
  await c.publish("crm", { expectedVersion: 0 });
  await c.version("crm", 2);
  await c.status("crm");
  await c.migration("crm", 2);
  await c.runMigration("crm", 2, { maxRows: 10, retryFailed: true });
  await c.runMigration("crm", 2);
  assert.deepEqual(seen, [
    ["GET", "/v1/ontology/definitions", "", null],
    ["POST", "/v1/ontology/definitions", "", { name: "crm", definition: d }],
    ["GET", "/v1/ontology/definitions/crm", "", null],
    ["PUT", "/v1/ontology/definitions/crm/draft", "", { definition: d }],
    ["POST", "/v1/ontology/definitions/crm/validate", "", {}],
    ["POST", "/v1/ontology/definitions/crm/validate", "", { definition: d }],
    ["GET", "/v1/ontology/definitions/crm/compare", "?from=1&to=draft", null],
    ["GET", "/v1/ontology/definitions/crm/compare", "", null],
    ["POST", "/v1/ontology/definitions/crm/publish", "", { expected_version: 1, accept_migration: true, from_version: 1, override_unsafe: true }],
    ["POST", "/v1/ontology/definitions/crm/publish", "", { expected_version: 0 }],
    ["GET", "/v1/ontology/definitions/crm/versions/2", "", null],
    ["GET", "/v1/ontology/definitions/crm/status", "", null],
    ["GET", "/v1/ontology/definitions/crm/migrations/2", "", null],
    ["POST", "/v1/ontology/definitions/crm/migrations/2/run", "", { max_rows: 10, retry_failed: true }],
    ["POST", "/v1/ontology/definitions/crm/migrations/2/run", "", {}],
  ]);
});

test("names are path-quoted and a 412 is thrown, never returned", async () => {
  const q = setup();
  await q.c.get("a/b c");
  assert.equal((q.seen[0] as string[])[1], "/v1/ontology/definitions/a%2Fb%20c");
  const { c } = setup(412, { code: "ontology-version-conflict", status: 412, title: "x", detail: "d" });
  await assert.rejects(() => c.publish("crm", { expectedVersion: 1 }));
});

test("Ossie export and import hit their routes (#6400, #6401)", async () => {
  const { c, seen } = setup();
  const doc = { version: "0.3.0.dev0", name: "crm", datasets: [{ name: "P", source: "P" }] };
  await c.exportOssie("crm");
  await c.exportOssie("crm", { version: 2, baseIri: "https://example.org/o" });
  await c.importOssie("crm", doc);
  assert.deepEqual(seen, [
    ["GET", "/v1/ontology/definitions/crm/export", "?format=ossie", null],
    ["GET", "/v1/ontology/definitions/crm/export", "?format=ossie&version=2&base_iri=https%3A%2F%2Fexample.org%2Fo", null],
    ["POST", "/v1/ontology/definitions/crm/import", "?format=ossie", doc],
  ]);
});
