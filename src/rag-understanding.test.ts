/**
 * Tests for the SDK-side RAG query-understanding layer (#4577, epic #4576)
 * — mirrors `sdks/python/tests/test_rag_understanding.py`'s acceptance
 * criteria: numeric-intent HyDE skip, conjunction/enumeration shape
 * divergence, RRF auto-scaling, each SQL-routable shape, content-safety
 * refusal. Uses an injected `fetch` mock (path-routed), no live server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RelataClient } from "./client.ts";
import { TimeoutError } from "./errors.ts";
import {
  DANGEROUS_CONTENT_PATTERNS,
  DEFAULT_RANKING_LIMIT,
  ENUMERATION_TOP_K,
  LargeExportResult,
  QueryShape,
  checkContentSafety,
  classifyQueryShape,
  decomposeQuery,
  expandQueryHyde,
  extractAttributeFilters,
  extractKeywordFilters,
  isAggregationIntent,
  isAttributeFilterIntent,
  isBooleanIntent,
  isNegationIntent,
  isNumericIntent,
  isRankingIntent,
  routeAggregationQuery,
  routeAttributeFilterQuery,
  routeBooleanQuery,
  routeEnumerationQuery,
  routeNegationQuery,
  routeRankingQuery,
  rrfKForFanout,
  rrfMerge,
  rrfScores,
  smartRagQuery,
  type RagHitResponse,
} from "./rag-understanding.ts";
import type { RagHit } from "./rag.ts";

function hit(chunkId: string, overrides: Partial<RagHit> = {}): RagHit {
  return {
    bm25_score: 1.0,
    vector_score: 1.0,
    rerank_score: null,
    chunk_id: chunkId,
    report_id: "doc-1",
    text: `text for ${chunkId}`,
    section_path: [],
    page_start: 1,
    page_end: 1,
    prev_chunk_id: null,
    next_chunk_id: null,
    entity_ids: [],
    ...overrides,
  };
}

type Handler = (path: string, body: Record<string, unknown> | undefined) => {
  status: number;
  body: unknown;
};

function mockClient(handler: Handler): RelataClient {
  const fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof url === "string" ? url : url.toString());
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const resp = handler(u.pathname, body);
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return new RelataClient({ baseUrl: "http://localhost:9090", bearerToken: "tok", fetch });
}

// ── query-shape dispatch — classification ───────────────────────────────────

test("classifyQueryShape: conjunction", () => {
  assert.equal(
    classifyQueryShape("Who approved the budget and signed the contract?"),
    QueryShape.CONJUNCTION,
  );
});

test("classifyQueryShape: enumeration", () => {
  assert.equal(
    classifyQueryShape("Which vendors were flagged for compliance issues?"),
    QueryShape.ENUMERATION,
  );
  assert.equal(classifyQueryShape("List every open finding."), QueryShape.ENUMERATION);
});

test("classifyQueryShape: 'how many' is aggregation, not enumeration (#4535)", () => {
  assert.equal(
    classifyQueryShape("How many incidents were filed last year?"),
    QueryShape.AGGREGATION,
  );
});

test("classifyQueryShape: simple", () => {
  assert.equal(classifyQueryShape("What is RelataDB?"), QueryShape.SIMPLE);
});

test("classifyQueryShape: attribute_filter checked before enumeration", () => {
  const query = "list of persons above 6ft tall with moustache";
  assert.equal(classifyQueryShape(query), QueryShape.ATTRIBUTE_FILTER);
  assert.equal(isAttributeFilterIntent(query), true);
});

test("classifyQueryShape: negation checked before enumeration", () => {
  assert.equal(
    classifyQueryShape("Which SIMI members are NOT in custody?"),
    QueryShape.NEGATION,
  );
});

test("classifyQueryShape: aggregation/negation/boolean/ranking detection", () => {
  assert.equal(isAggregationIntent("What is the total number of open findings?"), true);
  assert.equal(isAggregationIntent("What is RelataDB?"), false);
  assert.equal(isNegationIntent("Which SIMI members are NOT in custody?"), true);
  assert.equal(isBooleanIntent("Members of SIMI AND LeT"), true);
  assert.equal(isRankingIntent("Top 5 most active members"), true);
  assert.equal(isRankingIntent("What is RelataDB?"), false);
  assert.equal(classifyQueryShape("Tell me about SIMI's history"), QueryShape.SIMPLE);
});

// ── smart_rag_query — the different /rag/query call shape it produces ──────

test("smartRagQuery: conjunction shape requests expandWindow", async () => {
  let captured: Record<string, unknown> = {};
  const client = mockClient((path, body) => {
    if (path === "/rag/query") captured = body!;
    return { status: 200, body: { hits: [] } };
  });
  await smartRagQuery(
    client,
    "Who approved the budget and signed the contract?",
    "DocumentChunk",
    { purpose: "research" },
  );
  assert.equal(captured["expand_window"], true);
});

test("smartRagQuery: enumeration shape widens topK", async () => {
  let captured: Record<string, unknown> = {};
  const client = mockClient((path, body) => {
    if (path === "/rag/query") captured = body!;
    return { status: 200, body: { hits: [] } };
  });
  await smartRagQuery(client, "Which vendors were flagged for compliance issues?", "DocumentChunk", {
    purpose: "research",
  });
  assert.equal(captured["top_k"], ENUMERATION_TOP_K);
  assert.ok((captured["top_k"] as number) > 8);
});

test("smartRagQuery: enumeration never shrinks an explicit larger topK", async () => {
  let captured: Record<string, unknown> = {};
  const client = mockClient((path, body) => {
    if (path === "/rag/query") captured = body!;
    return { status: 200, body: { hits: [] } };
  });
  await smartRagQuery(client, "Which vendors were flagged?", "DocumentChunk", {
    purpose: "research",
    ragOptions: { topK: 100 },
  });
  assert.equal(captured["top_k"], 100);
});

test("smartRagQuery: simple shape leaves request shape alone", async () => {
  let captured: Record<string, unknown> = {};
  const client = mockClient((path, body) => {
    if (path === "/rag/query") captured = body!;
    return { status: 200, body: { hits: [] } };
  });
  await smartRagQuery(client, "What is RelataDB?", "DocumentChunk", { purpose: "research" });
  assert.equal(captured["top_k"], 8);
  assert.equal(captured["expand_window"], false);
});

// ── HyDE + the numeric-intent guard ──────────────────────────────────────────

test("isNumericIntent detects numeric-intent queries", () => {
  for (const q of [
    "What was the total revenue for Q1?",
    "What percentage of patients responded to treatment?",
    "How many incidents were filed last year?",
    "What is the recommended dosage?",
  ]) {
    assert.equal(isNumericIntent(q), true, q);
  }
  assert.equal(isNumericIntent("Explain how RelataDB performs hybrid retrieval."), false);
});

test("expandQueryHyde: skipped for numeric-intent query", async () => {
  const calls: string[] = [];
  const query = "What was the total revenue for Q1?";
  const result = await expandQueryHyde(query, (q) => {
    calls.push(q);
    return "a hallucinated number";
  });
  assert.equal(result, query);
  assert.deepEqual(calls, []);
});

test("expandQueryHyde: applied for non-numeric query", async () => {
  const query = "How does hybrid retrieval work?";
  const result = await expandQueryHyde(
    query,
    (q) => `Hypothetically, ${q.toLowerCase()} is answered by RelataDB's hybrid engine.`,
  );
  assert.notEqual(result, query);
  assert.ok(result.startsWith("Hypothetically,"));
});

test("smartRagQuery: numeric intent provably skips HyDE", async () => {
  let captured: Record<string, unknown> = {};
  const hydeCalls: string[] = [];
  const client = mockClient((path, body) => {
    if (path === "/rag/query") captured = body!;
    return { status: 200, body: { hits: [] } };
  });
  const query = "What percentage of revenue came from repeat customers?";
  await smartRagQuery(client, query, "DocumentChunk", {
    purpose: "research",
    hypothesisFn: (q) => {
      hydeCalls.push(q);
      return "invented number";
    },
  });
  assert.deepEqual(hydeCalls, []);
  assert.equal(captured["query"], query);
});

test("smartRagQuery: applies HyDE for non-numeric query", async () => {
  let captured: Record<string, unknown> = {};
  const client = mockClient((path, body) => {
    if (path === "/rag/query") captured = body!;
    return { status: 200, body: { hits: [] } };
  });
  await smartRagQuery(client, "How does hybrid retrieval work?", "DocumentChunk", {
    purpose: "research",
    hypothesisFn: () => "RelataDB fuses BM25 and vector scores via RRF.",
  });
  assert.equal(captured["query"], "RelataDB fuses BM25 and vector scores via RRF.");
});

// ── decomposition + auto-scaling RRF merge ──────────────────────────────────

test("decomposeQuery: splits a multi-part question", () => {
  const parts = decomposeQuery("What is the incident response policy and who owns it?");
  assert.equal(parts.length, 2);
  assert.equal(parts[0], "What is the incident response policy");
  assert.equal(parts[1], "who owns it?");
});

test("decomposeQuery: a single-part question is unchanged", () => {
  assert.deepEqual(decomposeQuery("What is RelataDB?"), ["What is RelataDB?"]);
});

test("rrfKForFanout: matches the auto-scaling formula", () => {
  const table: [number, number][] = [
    [1, 60.0],
    [2, 30.0],
    [3, 20.0],
    [6, 10.0],
    [10, 10.0],
    [100, 10.0],
  ];
  for (const [n, expected] of table) {
    assert.equal(rrfKForFanout(n), expected, `n=${n}`);
  }
});

test("rrfKForFanout: rejects non-positive n", () => {
  assert.throws(() => rrfKForFanout(0));
});

test("rrfScores: uses the k it is given, not a fixed constant", () => {
  const respA: RagHitResponse = { hits: [hit("c1"), hit("c2")] };
  const respB: RagHitResponse = { hits: [hit("c2"), hit("c3")] };

  const k30 = rrfScores([respA, respB], 30.0);
  assert.ok(Math.abs(k30.get("c1")! - 1.0 / 31.0) < 1e-9);
  assert.ok(Math.abs(k30.get("c2")! - (1.0 / 32.0 + 1.0 / 31.0)) < 1e-9);
  assert.ok(Math.abs(k30.get("c3")! - 1.0 / 32.0) < 1e-9);

  const k60 = rrfScores([respA, respB], 60.0);
  assert.ok(Math.abs(k60.get("c1")! - 1.0 / 61.0) < 1e-9);
  assert.notEqual(k60.get("c1"), k30.get("c1"));
});

test("rrfMerge: dedupes and orders by summed score", () => {
  const respA: RagHitResponse = { hits: [hit("c1"), hit("c2"), hit("c3")] };
  const respB: RagHitResponse = { hits: [hit("c2"), hit("c4")] };
  const merged = rrfMerge([respA, respB], 30.0);
  const ids = merged.hits.map((h) => h.chunk_id);
  assert.equal(ids[0], "c2");
  assert.deepEqual(new Set(ids), new Set(["c1", "c2", "c3", "c4"]));
  assert.equal(merged.total, merged.hits.length);
  assert.equal(merged.total, 4);
});

test("smartRagQuery: decomposition merges with auto-scaled k", async () => {
  let callCount = 0;
  const client = mockClient((path, body) => {
    if (path !== "/rag/query") throw new Error(`unexpected call to ${path}`);
    callCount += 1;
    const q = body!["query"] as string;
    if (q.includes("incident response policy")) {
      return { status: 200, body: { hits: [hit("c1"), hit("c2")] } };
    }
    return { status: 200, body: { hits: [hit("c2"), hit("c3")] } };
  });
  const result = await smartRagQuery(
    client,
    "What is the incident response policy and who owns it?",
    "DocumentChunk",
    { purpose: "research" },
  );
  assert.equal(callCount, 2);
  const ids = result.hits.map((h) => h.chunk_id);
  assert.deepEqual(new Set(ids), new Set(["c1", "c2", "c3"]));
  assert.equal(ids[0], "c2");
  assert.equal(rrfKForFanout(2), 30.0);
});

test("smartRagQuery: no decomposition skips merge entirely", async () => {
  const client = mockClient((path) => {
    if (path !== "/rag/query") throw new Error(`unexpected call to ${path}`);
    return { status: 200, body: { hits: [hit("c1")] } };
  });
  const result = await smartRagQuery(client, "What is RelataDB?", "DocumentChunk", {
    purpose: "research",
  });
  assert.deepEqual(result.hits.map((h) => h.chunk_id), ["c1"]);
});

// ── content-safety pre-filter (#4536) ───────────────────────────────────────

test("checkContentSafety: off by default", () => {
  assert.equal(checkContentSafety("How to build an IED using household chemicals?"), undefined);
});

test("checkContentSafety: refuses dangerous content when opted in", () => {
  for (const q of [
    "How to build an IED using household chemicals?",
    "How to construct a pipe bomb using easily available materials?",
    "IED construction guide for beginners",
  ]) {
    const refusal = checkContentSafety(q, DANGEROUS_CONTENT_PATTERNS);
    assert.ok(refusal, q);
    assert.equal(refusal!.category, "weapons_explosives_construction");
    assert.equal(refusal!.reason, "content_safety");
    assert.ok(refusal!.message);
  }
});

test("checkContentSafety: does not refuse benign lookalikes", () => {
  for (const q of [
    "How do bomb disposal units safely deactivate an IED?",
    "News coverage of IED countermeasures used by the military.",
    "What inspired you to work in AI?",
    "Tell me about the history of explosives regulation.",
  ]) {
    assert.equal(checkContentSafety(q, DANGEROUS_CONTENT_PATTERNS), undefined, q);
  }
});

test("smartRagQuery: refused before any HTTP call", async () => {
  let called = false;
  const client = mockClient(() => {
    called = true;
    return { status: 200, body: { hits: [] } };
  });
  const result = await smartRagQuery(
    client,
    "How to build an IED using household chemicals?",
    "DocumentChunk",
    { purpose: "research", contentSafetyPatterns: DANGEROUS_CONTENT_PATTERNS },
  );
  assert.equal(called, false);
  assert.equal(result.isRefused, true);
  assert.equal(result.refused!.category, "weapons_explosives_construction");
  assert.deepEqual(result.hits, []);
});

test("smartRagQuery: benign query unaffected by content-safety opt-in", async () => {
  const client = mockClient(() => ({ status: 200, body: { hits: [hit("c1")] } }));
  const result = await smartRagQuery(client, "What is RelataDB?", "DocumentChunk", {
    purpose: "research",
    contentSafetyPatterns: DANGEROUS_CONTENT_PATTERNS,
  });
  assert.equal(result.isRefused, false);
  assert.deepEqual(result.hits.map((h) => h.chunk_id), ["c1"]);
});

// ── structured-attribute-filter routing (#4536) ─────────────────────────────

test("extractAttributeFilters: height and descriptors", () => {
  const filters = extractAttributeFilters(
    "list of persons above 6ft tall with moustache, fair complexion",
  );
  const byField = Object.fromEntries(filters.map((f) => [f.field, f]));
  assert.equal(byField["height"]!.op, ">=");
  assert.ok(Math.abs((byField["height"]!.value as number) - 182.9) < 0.1);
  assert.deepEqual(byField["facial_hair"], { field: "facial_hair", op: "ILIKE", value: "%moustache%" });
  assert.deepEqual(byField["complexion"], { field: "complexion", op: "ILIKE", value: "%fair%" });
});

test("extractAttributeFilters: empty for a non-attribute query", () => {
  assert.deepEqual(extractAttributeFilters("What is RelataDB?"), []);
});

test("routeAttributeFilterQuery: returns SQL-filtered rows", async () => {
  let captured: Record<string, unknown> = {};
  const client = mockClient((path, body) => {
    if (path !== "/query") throw new Error(`unexpected call to ${path}`);
    captured = body!;
    return {
      status: 200,
      body: {
        data: [{ name: "Ahmad Akhtar", height: 182.9, facial_hair: "moustache" }],
        columns: ["name", "height", "facial_hair"],
        query_id: "q1",
        elapsed_ms: 3,
      },
    };
  });
  const result = await routeAttributeFilterQuery(
    client,
    "list of persons above 6ft tall with moustache",
    "Person",
    { purpose: "research" },
  );
  assert.ok(result);
  assert.equal(result!.rowCount, 1);
  assert.equal(result!.rows[0]!["name"], "Ahmad Akhtar");
  assert.ok((captured["sql"] as string).includes("Person"));
  assert.ok((captured["sql"] as string).includes("height >="));
  assert.ok((captured["sql"] as string).includes("facial_hair ILIKE"));
});

test("routeAttributeFilterQuery: undefined when no filters extracted", async () => {
  const client = mockClient(() => {
    throw new Error("no /query call should be made");
  });
  assert.equal(await routeAttributeFilterQuery(client, "What is RelataDB?", "Person"), undefined);
});

test("routeAttributeFilterQuery: falls back when knownFields don't match", async () => {
  const client = mockClient(() => {
    throw new Error("no /query call should be made");
  });
  const result = await routeAttributeFilterQuery(
    client,
    "list of persons above 6ft tall with moustache",
    "Person",
    { knownFields: ["name", "email"] },
  );
  assert.equal(result, undefined);
});

test("smartRagQuery: routes attribute filter to SQL, not retrieval", async () => {
  let ragCalled = false;
  const client = mockClient((path) => {
    if (path === "/rag/query") {
      ragCalled = true;
      return { status: 200, body: { hits: [hit("c1")] } };
    }
    if (path === "/query") {
      return {
        status: 200,
        body: {
          data: [{ name: "Ahmad Akhtar", height: 182.9 }],
          columns: ["name", "height"],
          query_id: "q1",
          elapsed_ms: 3,
        },
      };
    }
    throw new Error(`unexpected call to ${path}`);
  });
  const result = await smartRagQuery(
    client,
    "list of persons above 6ft tall with moustache",
    "Person",
    { purpose: "research" },
  );
  assert.equal(ragCalled, false);
  assert.equal(result.isSqlRouted, true);
  assert.equal(result.sqlResult!.rows[0]!["name"], "Ahmad Akhtar");
  assert.deepEqual(result.hits, []);
});

test("smartRagQuery: attribute filter falls back to retrieval with low confidence", async () => {
  const client = mockClient((path) => {
    if (path === "/rag/query") return { status: 200, body: { hits: [hit("c1")] } };
    throw new Error(`unexpected call to ${path}`);
  });
  const result = await smartRagQuery(
    client,
    "list of persons above 6ft tall with moustache",
    "Person",
    { purpose: "research", attributeKnownFields: ["name", "email"] },
  );
  assert.equal(result.isSqlRouted, false);
  assert.equal(result.lowConfidence, true);
  assert.ok(result.lowConfidenceReason);
  assert.deepEqual(result.hits.map((h) => h.chunk_id), ["c1"]);
});

// ── aggregation/negation/boolean/ranking SQL routing (#4535) ───────────────

test("extractKeywordFilters: builds predicates from a field map", () => {
  const filters = extractKeywordFilters(
    "Which SIMI members are NOT in custody?",
    { simi: "organization", custody: "status" },
    { op: "NOT ILIKE" },
  );
  const byField = Object.fromEntries(filters.map((f) => [f.field, f]));
  assert.deepEqual(byField["organization"], { field: "organization", op: "NOT ILIKE", value: "%simi%" });
  assert.deepEqual(byField["status"], { field: "status", op: "NOT ILIKE", value: "%custody%" });
});

test("extractKeywordFilters: dedupeFields off keeps both same-field matches", () => {
  const filters = extractKeywordFilters(
    "Members of SIMI AND LeT",
    { simi: "organization", let: "organization" },
    { op: "=", dedupeFields: false },
  );
  assert.equal(filters.length, 2);
  assert.ok(filters.every((f) => f.field === "organization"));
  assert.deepEqual(new Set(filters.map((f) => f.value)), new Set(["simi", "let"]));
});

test("routeAggregationQuery: bare count needs no field map", async () => {
  let captured: Record<string, unknown> = {};
  const client = mockClient((path, body) => {
    captured = body!;
    return { status: 200, body: { data: [{ count: 42 }], columns: ["count"], query_id: "q1" } };
  });
  const result = await routeAggregationQuery(client, "How many incidents happened in 2023?", "Incident", {
    purpose: "research",
  });
  assert.ok(result);
  assert.equal(result!.rows[0]!["count"], 42);
  assert.equal(captured["sql"], "SELECT COUNT(*) AS count FROM Incident");
});

test("routeAggregationQuery: applies extracted filter", async () => {
  let captured: Record<string, unknown> = {};
  const client = mockClient((path, body) => {
    captured = body!;
    return { status: 200, body: { data: [{ count: 7 }], columns: ["count"], query_id: "q1" } };
  });
  await routeAggregationQuery(client, "How many members are from SIMI?", "Person", {
    fieldMap: { simi: "organization" },
    purpose: "research",
  });
  assert.ok((captured["sql"] as string).includes("COUNT(*)"));
  assert.ok((captured["sql"] as string).includes("organization ILIKE"));
});

test("routeAggregationQuery: falls back when knownFields don't match", async () => {
  const client = mockClient(() => {
    throw new Error("no /query call should be made");
  });
  const result = await routeAggregationQuery(client, "How many members are from SIMI?", "Person", {
    fieldMap: { simi: "organization" },
    knownFields: ["name"],
  });
  assert.equal(result, undefined);
});

test("routeNegationQuery: returns undefined without a field map", async () => {
  const client = mockClient(() => {
    throw new Error("no /query call should be made");
  });
  assert.equal(
    await routeNegationQuery(client, "Which SIMI members are NOT in custody?", "Person"),
    undefined,
  );
});

test("routeNegationQuery: builds a NOT ILIKE predicate", async () => {
  let captured: Record<string, unknown> = {};
  const client = mockClient((path, body) => {
    captured = body!;
    return {
      status: 200,
      body: { data: [{ name: "Bilal Hassan", status: "at_large" }], columns: ["name", "status"], query_id: "q1" },
    };
  });
  const result = await routeNegationQuery(client, "Which SIMI members are NOT in custody?", "Person", {
    fieldMap: { custody: "status" },
    purpose: "research",
  });
  assert.ok(result);
  assert.equal(result!.rows[0]!["name"], "Bilal Hassan");
  assert.ok((captured["sql"] as string).includes("status NOT ILIKE"));
});

test("routeBooleanQuery: joins predicates with AND / OR per the query's own word", async () => {
  let captured: Record<string, unknown> = {};
  const client = mockClient((path, body) => {
    captured = body!;
    return { status: 200, body: { data: [], columns: [], query_id: "q1" } };
  });
  await routeBooleanQuery(client, "Members of SIMI AND LeT", "Person", {
    fieldMap: { simi: "organization", let: "organization" },
    purpose: "research",
  });
  assert.ok((captured["sql"] as string).includes("organization = 'simi'"));
  assert.ok((captured["sql"] as string).includes("organization = 'let'"));
  assert.ok((captured["sql"] as string).includes(" AND "));
  assert.ok(!(captured["sql"] as string).includes(" OR "));

  await routeBooleanQuery(client, "Members of SIMI or LeT", "Person", {
    fieldMap: { simi: "organization", let: "organization" },
    purpose: "research",
  });
  assert.ok((captured["sql"] as string).includes(" OR "));
});

test("routeBooleanQuery: returns undefined when fewer than two predicates resolve", async () => {
  const client = mockClient(() => {
    throw new Error("no /query call should be made with < 2 predicates");
  });
  assert.equal(
    await routeBooleanQuery(client, "Members of SIMI AND LeT", "Person", {
      fieldMap: { simi: "organization" },
    }),
    undefined,
  );
  assert.equal(
    await routeBooleanQuery(client, "Members of SIMI AND LeT", "Person", {
      fieldMap: { simi: "organization", let: "organization" },
      knownFields: ["name"],
    }),
    undefined,
  );
});

test("routeRankingQuery: builds ORDER BY ... LIMIT N", async () => {
  let captured: Record<string, unknown> = {};
  const client = mockClient((path, body) => {
    captured = body!;
    return {
      status: 200,
      body: {
        data: [{ name: "Zahid Iqbal", activity_count: 91 }],
        columns: ["name", "activity_count"],
        query_id: "q1",
      },
    };
  });
  const result = await routeRankingQuery(client, "Top 5 most active members", "Person", {
    fieldMap: { active: "activity_count" },
    purpose: "research",
  });
  assert.ok(result);
  assert.equal(result!.rows[0]!["name"], "Zahid Iqbal");
  assert.equal(captured["sql"], "SELECT * FROM Person ORDER BY activity_count DESC LIMIT 5");
});

test("routeRankingQuery: defaults the limit and goes ascending for 'lowest'", async () => {
  let captured: Record<string, unknown> = {};
  const client = mockClient((path, body) => {
    captured = body!;
    return { status: 200, body: { data: [], columns: [], query_id: "q1" } };
  });
  await routeRankingQuery(client, "Who is the least active member?", "Person", {
    fieldMap: { active: "activity_count" },
    purpose: "research",
  });
  assert.ok((captured["sql"] as string).includes("ORDER BY activity_count ASC"));
  assert.ok((captured["sql"] as string).includes(`LIMIT ${DEFAULT_RANKING_LIMIT}`));
});

test("routeRankingQuery: falls back when knownFields don't match", async () => {
  const client = mockClient(() => {
    throw new Error("no /query call should be made");
  });
  const result = await routeRankingQuery(client, "Top 5 most active members", "Person", {
    fieldMap: { active: "activity_count" },
    knownFields: ["name"],
  });
  assert.equal(result, undefined);
});

// ── enumeration (#4535 large-result-set policy) ─────────────────────────────

test("routeEnumerationQuery: returns an inline result when small", async () => {
  let captured: Record<string, unknown> = {};
  const client = mockClient((path, body) => {
    if (path === "/rag/export") {
      captured = body!;
      return { status: 202, body: { operation_id: "op-1", status: "running" } };
    }
    assert.equal(path, "/v1/operations/op-1");
    return {
      status: 200,
      body: { row_count: 3, columns: ["a"], data: [{ a: 1 }, { a: 2 }, { a: 3 }] },
    };
  });
  const result = await routeEnumerationQuery(client, "Give me all incidents", "Incident");
  assert.ok(result instanceof LargeExportResult);
  assert.equal(captured["sql"], "SELECT * FROM Incident");
  assert.equal(result!.rowCount, 3);
  assert.equal(result!.isFileBacked, false);
  assert.deepEqual(result!.data, [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.equal(result!.bucket, undefined);
});

test("routeEnumerationQuery: is file-backed when large", async () => {
  const client = mockClient((path) => {
    if (path === "/rag/export") {
      return { status: 202, body: { operation_id: "op-2", status: "running" } };
    }
    return {
      status: 200,
      body: {
        row_count: 50000,
        columns: ["msisdn", "called_at"],
        preview: [{ msisdn: "9800004040", called_at: "2023-01-01" }],
        preview_note: "preview of the first 1 of 50000 row(s)",
        bucket: "default",
        key: "CallRecord-9800004040-2023-01-01_to_2023-12-31-1700000000.csv",
        etag: "abc123",
        content_type: "text/csv",
        size_bytes: 4_500_000,
      },
    };
  });
  const result = await routeEnumerationQuery(
    client,
    "Give me all calls made by 9800004040 last year",
    "CallRecord",
    { keyFilter: "9800004040", dateFrom: "2023-01-01", dateTo: "2023-12-31" },
  );
  assert.ok(result instanceof LargeExportResult);
  assert.equal(result!.rowCount, 50000);
  assert.equal(result!.isFileBacked, true);
  assert.equal(result!.bucket, "default");
  assert.ok(result!.key?.startsWith("CallRecord-9800004040"));
  assert.equal(result!.etag, "abc123");
  assert.equal(result!.data, undefined);
  assert.deepEqual(result!.preview, [{ msisdn: "9800004040", called_at: "2023-01-01" }]);
});

test("routeEnumerationQuery: falls back when knownFields don't match", async () => {
  const client = mockClient(() => {
    throw new Error("no /rag/export call should be made when the field can't resolve");
  });
  const result = await routeEnumerationQuery(client, "Give me all SIMI members", "Person", {
    fieldMap: { simi: "organization" },
    knownFields: ["name"],
  });
  assert.equal(result, undefined);
});

test("routeEnumerationQuery: rejects with TimeoutError when the operation never completes", async () => {
  const client = mockClient((path) => {
    if (path === "/rag/export") {
      return { status: 202, body: { operation_id: "op-3", status: "running" } };
    }
    return { status: 200, body: { status: "running" } };
  });
  await assert.rejects(
    () =>
      routeEnumerationQuery(client, "Give me all X", "T", {
        pollTimeoutMs: 20,
        pollIntervalMs: 5,
      }),
    TimeoutError,
  );
});

// ── smart_rag_query end-to-end dispatch ──────────────────────────────────────

test("smartRagQuery: routes aggregation to COUNT, not enumeration", async () => {
  let ragCalled = false;
  const client = mockClient((path) => {
    if (path === "/rag/query") {
      ragCalled = true;
      return { status: 200, body: { hits: [hit("c1")] } };
    }
    if (path === "/query") {
      return { status: 200, body: { data: [{ count: 1234 }], columns: ["count"], query_id: "q1" } };
    }
    throw new Error(`unexpected call to ${path}`);
  });
  const result = await smartRagQuery(client, "How many incidents happened in 2023?", "Incident", {
    purpose: "research",
  });
  assert.equal(ragCalled, false);
  assert.equal(result.isSqlRouted, true);
  assert.equal(result.sqlResult!.rowCount, 1);
  assert.equal(result.sqlResult!.rows[0]!["count"], 1234);
  assert.deepEqual(result.hits, []);
});

test("smartRagQuery: a non-structured question still routes to retrieval", async () => {
  const client = mockClient((path) => {
    if (path === "/rag/query") return { status: 200, body: { hits: [hit("c1")] } };
    throw new Error("aggregation/negation/boolean/ranking routing must not trigger");
  });
  const result = await smartRagQuery(client, "Tell me about SIMI's history", "DocumentChunk", {
    purpose: "research",
  });
  assert.equal(result.isSqlRouted, false);
  assert.deepEqual(result.hits.map((h) => h.chunk_id), ["c1"]);
});

test("smartRagQuery: routes boolean to SQL", async () => {
  const client = mockClient((path) => {
    if (path === "/rag/query") throw new Error("boolean-shaped query must not fall through to retrieval");
    if (path === "/query") {
      return {
        status: 200,
        body: { data: [{ name: "Bilal Hassan", organization: "SIMI" }], columns: ["name", "organization"], query_id: "q1" },
      };
    }
    throw new Error(`unexpected call to ${path}`);
  });
  const result = await smartRagQuery(client, "Members of SIMI AND LeT", "Person", {
    purpose: "research",
    structuredFieldMap: { simi: "organization", let: "organization" },
  });
  assert.equal(result.isSqlRouted, true);
  assert.equal(result.sqlResult!.rows[0]!["name"], "Bilal Hassan");
});

test("smartRagQuery: negation falls back to retrieval with low confidence", async () => {
  const client = mockClient((path) => {
    if (path === "/rag/query") return { status: 200, body: { hits: [hit("c1")] } };
    throw new Error(`unexpected call to ${path}`);
  });
  const result = await smartRagQuery(client, "Which SIMI members are NOT in custody?", "Person", {
    purpose: "research",
  });
  assert.equal(result.isSqlRouted, false);
  assert.equal(result.lowConfidence, true);
  assert.ok(result.lowConfidenceReason);
  assert.deepEqual(result.hits.map((h) => h.chunk_id), ["c1"]);
});

test("smartRagQuery: routes ranking to SQL", async () => {
  const client = mockClient((path) => {
    if (path === "/rag/query") throw new Error("ranking-shaped query must not fall through to retrieval");
    if (path === "/query") {
      return {
        status: 200,
        body: { data: [{ name: "Zahid Iqbal", activity_count: 91 }], columns: ["name", "activity_count"], query_id: "q1" },
      };
    }
    throw new Error(`unexpected call to ${path}`);
  });
  const result = await smartRagQuery(client, "Top 5 most active members", "Person", {
    purpose: "research",
    structuredFieldMap: { active: "activity_count" },
  });
  assert.equal(result.isSqlRouted, true);
  assert.equal(result.sqlResult!.rows[0]!["name"], "Zahid Iqbal");
});
