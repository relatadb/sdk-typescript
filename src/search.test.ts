/**
 * Tests for the typed search payload builder (#1983/#2169, #2465).
 *
 * `buildSearchPayload` is a pure function — no live server required.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildSearchPayload } from "./search.ts";

test("buildSearchPayload compiles text to a bm25 rank_by", () => {
  const body = buildSearchPayload({ from: "Document", text: "fraud pattern", limit: 10 });
  assert.equal(body["from"], "Document");
  assert.deepEqual(body["rank_by"], ["bm25", "*", "fraud pattern"]);
  assert.equal(body["limit"], 10);
  assert.ok(!("query" in body));
});

test("buildSearchPayload carries computeAttributes as compute_attributes", () => {
  const body = buildSearchPayload({
    from: "Document",
    text: "fraud pattern",
    computeAttributes: { bm25_score: "BM25()", snippet: "HIGHLIGHT(bio)" },
  });
  assert.deepEqual(body["compute_attributes"], {
    bm25_score: "BM25()",
    snippet: "HIGHLIGHT(bio)",
  });
});

test("buildSearchPayload omits compute_attributes when absent", () => {
  const body = buildSearchPayload({ from: "Document", text: "x" });
  assert.ok(!("compute_attributes" in body));
});
