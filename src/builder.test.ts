/**
 * Tests for the typed query IR builder (`./builder.ts`).
 *
 * Uses Node's built-in `node:test` runner. Run with:
 *   node --experimental-strip-types --test src/builder.test.ts
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  IR_VERSION,
  QueryBuilder,
  hybridSearch,
  lookupIdentity,
  pathsBetween,
  query,
} from "./builder.ts";

test("select: minimal builder emits versioned envelope", () => {
  const ir = query().purpose("analytics").from("Person").build();

  assert.equal(ir.relata_query_ir, IR_VERSION);
  assert.equal(ir.kind, "select");
  assert.equal(ir.purpose, "analytics");
  assert.equal(ir.from, "Person");
  assert.equal(ir.select, undefined);
  assert.equal(ir.where, undefined);
  assert.equal(ir.limit, undefined);
});

test("select: columns + chained where + limit", () => {
  const ir = new QueryBuilder()
    .purpose("analytics")
    .from("Person")
    .select("id", "name")
    .where("age", ">", 30)
    .where("city", "=", "Dubai")
    .limit(10)
    .build();

  assert.deepEqual(ir.select, ["id", "name"]);
  assert.equal(ir.limit, 10);
  assert.deepEqual(ir.where, [
    { col: "age", op: "gt", val: 30 },
    { col: "city", op: "eq", val: "Dubai" },
  ]);
});

test("select: limit() rejects negative or non-integer values", () => {
  assert.throws(() => query().purpose("p").from("X").limit(-1), /non-negative/);
  assert.throws(() => query().purpose("p").from("X").limit(1.5), /non-negative/);
});

test("paths_between: includes max_hops when set", () => {
  const ir = pathsBetween({
    purpose: "investigation",
    fromId: "alice",
    toId: "bob",
    maxHops: 5,
  });

  assert.equal(ir.relata_query_ir, IR_VERSION);
  assert.equal(ir.kind, "paths_between");
  assert.equal(ir.purpose, "investigation");
  assert.equal(ir.from_id, "alice");
  assert.equal(ir.to_id, "bob");
  assert.equal(ir.max_hops, 5);

  const noHops = pathsBetween({
    purpose: "investigation",
    fromId: "alice",
    toId: "bob",
  });
  assert.equal(noHops.max_hops, undefined);
});

test("lookup_identity and hybrid_search emit correct shapes", () => {
  const idIr = lookupIdentity({
    purpose: "investigation",
    value: "+971-50-1234567",
    kindHint: "phone",
  });
  assert.equal(idIr.kind, "lookup_identity");
  assert.equal(idIr.value, "+971-50-1234567");
  assert.equal(idIr.kind_hint, "phone");

  const idNoHint = lookupIdentity({
    purpose: "investigation",
    value: "ahmed@example.com",
  });
  assert.equal(idNoHint.kind_hint, undefined);

  const hs = hybridSearch({
    purpose: "analytics",
    from: "Document",
    query: "money laundering",
    topK: 20,
    alpha: 0.7,
  });
  assert.equal(hs.kind, "hybrid_search");
  assert.equal(hs.from, "Document");
  assert.equal(hs.query, "money laundering");
  assert.equal(hs.top_k, 20);
  assert.equal(hs.alpha, 0.7);

  const hsMin = hybridSearch({
    purpose: "analytics",
    from: "Document",
    query: "fraud",
  });
  assert.equal(hsMin.top_k, undefined);
  assert.equal(hsMin.alpha, undefined);
});

test("package.json exports the ./builder subpath (#2756 regression guard)", async () => {
  // This module's JSDoc (and the README) advertise
  // `import ... from "@zysec-ai/relata-sdk/builder"`. Guard against that
  // subpath silently dropping out of `package.json` `exports` again — a
  // published install would otherwise make this module unreachable even
  // though the source ships it.
  const { readFile } = await import("node:fs/promises");
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(pkgUrl, "utf8"));

  assert.ok(pkg.exports["./builder"], "package.json exports must declare './builder'");
  assert.equal(pkg.exports["./builder"].types, "./dist/builder.d.ts");
  assert.equal(pkg.exports["./builder"].import, "./dist/builder.js");
});
