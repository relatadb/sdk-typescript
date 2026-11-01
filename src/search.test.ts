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

test("buildSearchPayload carries queryVector as top-level query_vector", () => {
  const body = buildSearchPayload({
    from: "Document",
    rankBy: ["vector", "ann", "fraud"],
    queryVector: [0.5, 0.25],
    queryVectorModel: "m1",
  });
  assert.deepEqual(body["query_vector"], [0.5, 0.25]);
  assert.equal(body["query_vector_model"], "m1");
});

test("buildSearchPayload rejects an empty/model-only query vector", () => {
  assert.throws(() => buildSearchPayload({ from: "D", queryVector: [] }));
  assert.throws(() => buildSearchPayload({ from: "D", queryVectorModel: "m1" }));
});
