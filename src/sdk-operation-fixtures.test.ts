// #5666: cross-SDK shared operation fixtures for objects, search, memory and assertions
// (TypeScript leg). See sdks/shared/sdk-operation-fixtures.json and the Rust live replay test
// (http_e2e::contract_matrix::sdk_operation_fixtures_match_live_server) that keeps it faithful.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RelataClient } from "./index.ts";
import { ObjectClient } from "./objects.ts";
import { Memory } from "./memory.ts";
import { AssertionsClient } from "./assertions.ts";

type Json = Record<string, unknown>;
interface Request {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  ndjson?: unknown[];
}
interface Case {
  name: string;
  family: string;
  sdks?: string[];
  call: { op: string; args: Json };
  request: Request;
  request_override?: Record<string, Partial<Request>>;
  wire: { status: number; body: unknown };
  expect: { result?: unknown; error?: { status: number; code: string; current_version?: number } };
  expect_override?: Record<string, { result?: unknown }>;
}

const SDK = "typescript";
const fixtures = JSON.parse(
  readFileSync(new URL("../../shared/sdk-operation-fixtures.json", import.meta.url), "utf8"),
) as { contract: string; sdks: string[]; cases: Case[] };

test("fixture file is the documented contract", () => {
  assert.equal(fixtures.contract, "relata.sdk-operation-fixtures/v1");
  const names = fixtures.cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(
    [...new Set(fixtures.cases.map((c) => c.family))].sort(),
    ["assertions", "memory", "objects", "search"],
  );
});

const BASE = "http://relata.invalid";

async function dispatch(op: string, a: Json, f: typeof globalThis.fetch): Promise<unknown> {
  const common = { baseUrl: BASE, bearerToken: "t", fetch: f, maxRetries: 0 };
  const num = (v: unknown): number | undefined => (v === undefined ? undefined : Number(v));
  switch (op) {
    case "objects.put":
    case "objects.upsert_ingest":
    case "objects.get":
    case "objects.delete":
    case "objects.list": {
      const o = new ObjectClient({ ...common, purpose: "analytics" });
      if (op === "objects.put") {
        return o.upsert(String(a["object_type"]), String(a["object_id"]), a["fields"] as Json, {
          ...(a["expected_version"] !== undefined ? { expectedVersion: num(a["expected_version"])! } : {}),
          ...(a["if_absent"] === true ? { ifAbsent: true } : {}),
        });
      }
      if (op === "objects.upsert_ingest") {
        return o.upsert(String(a["object_type"]), String(a["object_id"]), a["fields"] as Json);
      }
      if (op === "objects.get") return o.get(String(a["object_type"]), String(a["object_id"]));
      if (op === "objects.list") {
        return o.list(String(a["object_type"]), {
          ...(a["limit"] !== undefined ? { limit: num(a["limit"])! } : {}),
        });
      }
      return o.delete(String(a["object_type"]), String(a["object_id"]), {
        ...(a["expected_version"] !== undefined ? { expectedVersion: num(a["expected_version"])! } : {}),
      });
    }
    case "search.query": {
      const c = new RelataClient({ ...common, defaultPurpose: "analytics" });
      const r = await c.search({
        query: String(a["query"]),
        type: String(a["type"]),
        ...(a["limit"] !== undefined ? { limit: num(a["limit"])! } : {}),
        ...(a["highlight"] === true ? { highlight: true } : {}),
      });
      return {
        hit_ids: r.hits.map((h) => h.id),
        hit_fields: r.hits.map((h) => h.fields),
        hit_scores: r.hits.map((h) => h.score),
        hit_highlight_spans: r.hits.map((h) => h.highlightSpans),
        total: r.total,
        estimated_total_hits: r.estimatedTotalHits,
      };
    }
    case "memory.add":
    case "memory.search":
    case "memory.get": {
      const m = new Memory(BASE, { purpose: "analytics", bearerToken: "t", fetch: f });
      if (op === "memory.add") {
        return m.add(String(a["content"]), {
          ...(a["confidence"] !== undefined ? { confidence: num(a["confidence"])! } : {}),
          ...(a["memory_class"] !== undefined ? { memoryClass: String(a["memory_class"]) } : {}),
        });
      }
      if (op === "memory.search") {
        return m.search(String(a["query"]), a["top_k"] !== undefined ? { topK: num(a["top_k"])! } : {});
      }
      return m.get(String(a["memory_id"]));
    }
    default: {
      const s = new AssertionsClient(common);
      if (op === "assertions.record") return s.record(a["assertion"] as Json);
      if (op === "assertions.get") return s.get(String(a["id"]));
      if (op === "assertions.list") {
        return s.list({
          ...(a["subject_type"] !== undefined ? { subjectType: String(a["subject_type"]) } : {}),
          ...(a["subject_id"] !== undefined ? { subjectId: String(a["subject_id"]) } : {}),
          ...(a["predicate"] !== undefined ? { predicate: String(a["predicate"]) } : {}),
          ...(a["state"] !== undefined ? { state: String(a["state"]) } : {}),
          ...(a["limit"] !== undefined ? { limit: num(a["limit"])! } : {}),
        });
      }
      if (op === "assertions.confirm") return s.confirm(String(a["id"]), String(a["reason"]));
      if (op === "assertions.revoke") return s.revoke(String(a["id"]), String(a["reason"]));
      throw new Error(`fixture op ${op} has no TypeScript dispatch`);
    }
  }
}

for (const c of fixtures.cases.filter((x) => (x.sdks ?? fixtures.sdks).includes(SDK))) {
  test(`${c.family}: request and result match the shared expectation: ${c.name}`, async () => {
    const seen: { url: URL; method: string; headers: Headers; body: string }[] = [];
    const f: typeof globalThis.fetch = async (input, init) => {
      seen.push({
        url: new URL(String(input)),
        method: String(init?.method ?? "GET"),
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify(c.wire.body), {
        status: c.wire.status,
        headers: { "content-type": c.wire.status >= 400 ? "application/problem+json" : "application/json" },
      });
    };
    let got: unknown;
    let thrown: unknown;
    try {
      got = await dispatch(c.call.op, c.call.args, f);
    } catch (e) {
      thrown = e;
    }

    assert.equal(seen.length, 1);
    const want: Request = { ...c.request, ...(c.request_override?.[SDK] ?? {}) };
    const req = seen[0]!;
    assert.equal(req.method, want.method);
    assert.equal(req.url.pathname, want.path);
    assert.deepEqual(Object.fromEntries(req.url.searchParams), want.query ?? {});
    for (const [k, v] of Object.entries(want.headers ?? {})) assert.equal(req.headers.get(k), v, k);
    if (want.ndjson !== undefined) {
      assert.deepEqual(req.body.replace(/\n+$/, "").split("\n").map((l) => JSON.parse(l)), want.ndjson);
    } else if (want.body !== undefined) {
      assert.deepEqual(JSON.parse(req.body), want.body);
    } else {
      assert.equal(req.body, "");
    }
    if (c.expect.error !== undefined) {
      const err = thrown as { statusCode?: number; code?: string; currentVersion?: number | null };
      assert.ok(thrown, "the call must reject");
      assert.equal(err.statusCode, c.expect.error.status);
      assert.equal(err.code, c.expect.error.code);
      if (c.expect.error.current_version !== undefined) {
        assert.equal(err.currentVersion, c.expect.error.current_version);
      }
      return;
    }
    if (thrown !== undefined) throw thrown;
    const exp = c.expect_override?.[SDK] ?? c.expect;
    assert.deepEqual(got, exp.result);
  });
}
