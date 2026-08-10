/**
 * Tests for `coref.ts` — session-scoped coreference resolution (RAG epic,
 * #4530). Mirrors `sdks/python/tests/test_coref.py` (#4580 TS/Go parity).
 *
 * Uses a tiny in-process fake `MemoryItem` store (dispatched via a custom
 * `fetch` stand-in) that reproduces the real server's session-exact-match
 * scoping closely enough to prove the acceptance criteria without a live
 * server: two-turn resolution, bounded one-row state, zero-cost single-turn
 * calls, and cross-session isolation.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CorefResolver, Memory, hasUnresolvedPronoun, subjectFromHit } from "./index.ts";
import type { RagHit } from "./index.ts";

const BASE = "http://localhost:9090";

interface Row {
  content: string;
  session_id: string;
}

/**
 * Minimal in-process fake reproducing the `/memory/*` contract this module
 * depends on: `remember` inserts, `consolidate` supersedes (pop old id,
 * insert new), and `recall` filters by exact `session_id` match.
 */
class FakeMemoryServer {
  rows = new Map<string, Row>();
  rememberCalls = 0;
  consolidateCalls = 0;
  recallCalls = 0;
  #nextId = 0;

  #newId(): string {
    this.#nextId += 1;
    return `mem-${this.#nextId}`;
  }

  fetch: typeof globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const u = new URL(typeof url === "string" ? url : url.toString());
    const path = u.pathname;
    const mcp = (result: unknown) =>
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
      });

    if (path === "/memory/remember") {
      this.rememberCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}"));
      const id = this.#newId();
      this.rows.set(id, { content: body.content, session_id: body.session_id });
      return new Response(mcp({ id, session_id: body.session_id }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path === "/memory/consolidate") {
      this.consolidateCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}"));
      const old = this.rows.get(body.id);
      this.rows.delete(body.id);
      const newId = this.#newId();
      const sessionId = old ? old.session_id : "";
      this.rows.set(newId, { content: body.content, session_id: sessionId });
      return new Response(mcp({ new_id: newId }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path === "/memory/recall") {
      this.recallCalls += 1;
      const sid = u.searchParams.get("session_id") ?? "";
      const rows = [...this.rows.entries()]
        .filter(([, r]) => r.session_id === sid)
        .map(([id, r]) => ({ id, content: r.content, session_id: r.session_id }));
      return new Response(mcp({ rows }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected path: ${path}`);
  }) as typeof globalThis.fetch;
}

function resolverPair(): { coref: CorefResolver; server: FakeMemoryServer } {
  const server = new FakeMemoryServer();
  const memory = new Memory(BASE, { purpose: "agent-notes", fetch: server.fetch });
  return { coref: new CorefResolver(memory), server };
}

// ── the acceptance-criteria regression test ─────────────────────────────────

test('coref: two-turn sequence resolves pronoun to prior subject ("India" -> "it")', async () => {
  const { coref } = resolverPair();

  await coref.rememberSubject("session-1", "India");
  const resolved = await coref.resolve("Where is it located?", "session-1");

  assert.equal(resolved, "Where is India located?");
});

// ── acceptance: exactly one row, never a growing list ───────────────────────

test("coref: state is exactly one row and never grows with turn count", async () => {
  const { coref, server } = resolverPair();

  await coref.rememberSubject("session-1", "India");
  assert.equal(server.rememberCalls, 1);
  assert.equal(server.rows.size, 1);

  await coref.resolve("Where is it located?", "session-1");
  await coref.rememberSubject("session-1", "Paris"); // turn 2 supersedes turn 1
  assert.equal(server.rememberCalls, 1); // no second `add`
  assert.equal(server.consolidateCalls, 1); // superseded via consolidate
  assert.equal(server.rows.size, 1); // still exactly one live row

  await coref.rememberSubject("session-1", "Berlin"); // turn 3 supersedes turn 2
  assert.equal(server.rememberCalls, 1);
  assert.equal(server.consolidateCalls, 2);
  assert.equal(server.rows.size, 1);

  const resolved = await coref.resolve("Where is it now?", "session-1");
  assert.equal(resolved, "Where is Berlin now?");
});

// ── acceptance: single-turn callers pay no extra cost ───────────────────────

test("coref: no sessionId makes zero network calls", async () => {
  const { coref, server } = resolverPair();

  const resolved = await coref.resolve("Where is it located?", "");

  assert.equal(resolved, "Where is it located?");
  assert.equal(server.recallCalls, 0);
  assert.equal(server.rememberCalls, 0);
});

test("coref: query without unresolved pronoun makes zero network calls", async () => {
  const { coref, server } = resolverPair();

  const resolved = await coref.resolve("What is the capital of France?", "session-1");

  assert.equal(resolved, "What is the capital of France?");
  assert.equal(server.recallCalls, 0);
});

test("coref: pronoun with no prior subject returns query unchanged", async () => {
  const { coref, server } = resolverPair();

  const resolved = await coref.resolve("Where is it located?", "session-never-seen");

  assert.equal(resolved, "Where is it located?");
  assert.equal(server.recallCalls, 1);
});

test("coref: local antecedent suppresses the trip", async () => {
  const { coref, server } = resolverPair();
  await coref.rememberSubject("session-1", "India");
  const recallCallsAfterRemember = server.recallCalls;

  const query = "What did Marie Curie discover and how did it change physics?";
  const resolved = await coref.resolve(query, "session-1");

  assert.equal(resolved, query);
  assert.equal(server.recallCalls, recallCallsAfterRemember); // resolve() made no new call
});

// ── acceptance: cross-session isolation ─────────────────────────────────────

test("coref: cross-session isolation", async () => {
  const { coref } = resolverPair();

  await coref.rememberSubject("session-a", "India");
  const resolved = await coref.resolve("Where is it located?", "session-b");

  // session-b never stored a subject, so it must not see session-a's.
  assert.equal(resolved, "Where is it located?");
});

// ── subjectFromHit / hasUnresolvedPronoun unit coverage ─────────────────────

function ragHit(overrides: Partial<RagHit> = {}): RagHit {
  return {
    bm25_score: 1.0,
    vector_score: 1.0,
    rerank_score: null,
    chunk_id: "chunk-1",
    report_id: "doc-1",
    text: "text",
    section_path: [],
    page_start: 1,
    page_end: 1,
    prev_chunk_id: null,
    next_chunk_id: null,
    entity_ids: [],
    ...overrides,
  };
}

test("coref: subjectFromHit uses first entity id", () => {
  const hit = ragHit({ entity_ids: ["India", "New Delhi"] });
  assert.equal(subjectFromHit(hit), "India");
});

test("coref: subjectFromHit returns null without entity ids", () => {
  assert.equal(subjectFromHit(ragHit({ entity_ids: [] })), null);
});

test("coref: hasUnresolvedPronoun", () => {
  assert.equal(hasUnresolvedPronoun("Where is it located?"), true);
  assert.equal(hasUnresolvedPronoun("What is the capital of France?"), false);
  assert.equal(
    hasUnresolvedPronoun("What did Marie Curie discover and how did it change physics?"),
    false,
  );
});
