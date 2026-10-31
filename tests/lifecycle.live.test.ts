/**
 * Dataset-lifecycle run through the TypeScript SDK against a live server
 * (#5724). Mirrors scripts/sdk_lifecycle_e2e.py: create -> inspect ->
 * compare-and-set alter -> stale-version refusal -> lifecycle progress ->
 * data-token refusal -> drop.
 *
 * Skips unless RELATA_TOKEN (a registry data token) and RELATA_ADMIN_TOKEN are
 * both set. Run: scripts/sdk_lifecycle_live.sh (needs a running server), or
 * `node --experimental-strip-types --test tests/lifecycle.live.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RelataClient } from "../src/index.ts";

const BASE = process.env.RELATA_HOST || "http://localhost:9090";
const DATA = process.env.RELATA_TOKEN;
const ADMIN = process.env.RELATA_ADMIN_TOKEN;

function statusOf(err: unknown): number {
  return (err as { statusCode?: number })?.statusCode ?? 0;
}

test("lifecycle live run", { skip: !DATA || !ADMIN }, async () => {
  const data = new RelataClient(BASE, { bearerToken: DATA });
  const admin = new RelataClient(BASE, { bearerToken: ADMIN });
  const name = `TsLife${Date.now()}`;

  await admin.registerType(name, { description: "ts lifecycle run" });
  const v0 = String((await data.typeDetail(name))["schema_version"]);
  assert.equal(v0.length, 16);

  await assert.rejects(data.registerType(`${name}Denied`), (e) => [401, 403].includes(statusOf(e)));
  await assert.rejects(data.typeDetail(`${name}Denied`), (e) => statusOf(e) === 404);

  const altered = await admin.schemaAlter(name, "add_column", "bin", {
    colType: "string",
    optional: true,
    expectedSchemaVersion: v0,
  });
  const v1 = String(altered["schema_version"]);
  assert.notEqual(v1, v0);
  assert.equal(altered["schema_version_before"], v0);
  await assert.rejects(
    admin.schemaAlter(name, "add_column", "other", {
      colType: "string",
      optional: true,
      expectedSchemaVersion: v0,
    }),
    (e) => statusOf(e) === 412,
  );
  assert.equal((await data.typeDetail(name))["schema_version"], v1);

  const life = await data.typeLifecycle(name);
  const ops = (life["operations"] as Array<{ operation: string; outcome: string }>).map(
    (o) => [o.operation, o.outcome],
  );
  assert.deepEqual(ops, [
    ["alter", "refused"],
    ["alter", "applied"],
    ["register", "applied"],
  ]);
  assert.equal(life["schema_version"], v1);

  await admin.deregisterType(name);
  await assert.rejects(data.typeLifecycle(name), (e) => statusOf(e) === 404);
});
