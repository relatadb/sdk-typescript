import assert from "node:assert/strict";
import { test } from "node:test";
import { RelataClient } from "./client.ts";

test("QueryBuilder emits WITH PROVENANCE as the trailing clause", () => {
  const c = new RelataClient({ baseUrl: "http://x.invalid", bearerToken: "t" });
  const sql = c
    .select("Person")
    .columns("id")
    .asOf("2026-01-01T00:00:00Z")
    .withProvenance()
    .where("v > 1")
    .orderBy("v", "DESC")
    .limit(2)
    .offset(1)
    .toSQL();
  assert.equal(
    sql,
    "SELECT id FROM Person AS OF '2026-01-01T00:00:00Z' WHERE v > 1 ORDER BY v DESC LIMIT 2 OFFSET 1 WITH PROVENANCE",
  );
});
