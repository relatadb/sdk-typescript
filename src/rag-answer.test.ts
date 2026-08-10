/**
 * Tests for the composed end-to-end RAG answer pipeline (#4584, epic
 * #4576) — mirrors `sdks/python/tests/test_rag_answer.py`'s acceptance
 * criteria: the full chain actually composes (real retrieval, real
 * synthesis, real trace write-back — not three independently-tested pieces
 * that have never run together), the content-safety/SQL-routing
 * short-circuits skip retrieval/synthesis/trace entirely, and the fan-out
 * path still composes all the way to a trace. Python exercises this via
 * separate sync/async twins (`run_rag_answer`/`arun_rag_answer`); TS
 * collapses both to the single `runRagAnswer` (same collapse every other
 * RAG-epic TS module already made), so one test per behavior suffices here.
 * Uses an injected `fetch` mock (path-routed), no live server required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RelataClient } from "./client.ts";
import { McpClient } from "./mcp.ts";
import type { RagHit } from "./rag.ts";
import { DANGEROUS_CONTENT_PATTERNS } from "./rag-understanding.ts";
import type { SubAgentStrategy } from "./rag-loop.ts";
import { runRagAnswer } from "./rag-answer.ts";

function hit(chunkId: string, overrides: Partial<RagHit> = {}): RagHit {
  return {
    bm25_score: 4.2,
    vector_score: 0.83,
    rerank_score: null,
    chunk_id: chunkId,
    report_id: "doc-1",
    text: `RelataDB fuses BM25 and vector retrieval natively [${chunkId}].`,
    section_path: ["3", "3.2"],
    page_start: 4,
    page_end: 5,
    prev_chunk_id: null,
    next_chunk_id: null,
    entity_ids: [],
    relevance_confidence: 0.9,
    ...overrides,
  };
}

type Handler = (
  path: string,
  body: Record<string, unknown> | undefined,
) => { status: number; body: unknown };

function mockClient(handler: Handler): RelataClient {
  const fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof url === "string" ? url : url.toString());
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const resp = handler(u.pathname, body);
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return new RelataClient({ baseUrl: "http://localhost:9090", bearerToken: "tok", fetch });
}

/** Embedding under which the heuristic gate PASSes on iteration 0 (cosine 1.0). */
const embeddingFnPass = () => [1.0, 0.0];

/**
 * Deterministic stand-in synthesis call: cites the first bracketed marker
 * found in the prompt — `buildSynthesisPrompt`'s own instructions example
 * uses the real first hit's `chunk_id`, so this always cites a real hit
 * without needing to parse the Evidence block separately.
 */
function stubLlm(prompt: string): string {
  const openIdx = prompt.indexOf("[");
  const closeIdx = openIdx === -1 ? -1 : prompt.indexOf("]", openIdx);
  const marker = openIdx !== -1 && closeIdx !== -1 ? prompt.slice(openIdx + 1, closeIdx) : "chunk-1";
  return `RelataDB fuses BM25 and vector retrieval [${marker}].`;
}

const stubFaithfulEntailment = () => true;

// ── happy path: the full chain actually composes ───────────────────────────

test("runRagAnswer composes the full chain: real retrieval, synthesis, trace", async () => {
  let ragCalls = 0;
  const traceCalls: Record<string, unknown>[] = [];

  const client = mockClient((path, body) => {
    if (path === "/rag/query") {
      ragCalls += 1;
      return { status: 200, body: { hits: [hit("chunk-1")], total: 1 } };
    }
    if (path === "/mcp/tools/call") {
      traceCalls.push(body!);
      const result = {
        stored: "RagAnswer",
        source_rows: 1,
        has_iteration_trace: true,
        evidence_gap_count: 0,
      };
      return {
        status: 200,
        body: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false },
      };
    }
    throw new Error(`unexpected path: ${path}`);
  });
  const mcpClient = McpClient.fromClient(client);

  const result = await runRagAnswer(
    client,
    mcpClient,
    "What does RelataDB fuse natively?",
    "DocumentChunk",
    {
      llm: stubLlm,
      embeddingFn: embeddingFnPass,
      entailmentFn: stubFaithfulEntailment,
      purpose: "analytics",
    },
  );

  // Real retrieval happened — exactly once (heuristic gate passed iter 0).
  assert.equal(ragCalls, 1);
  assert.ok(result.response.hits.length > 0);
  assert.equal(result.response.hits[0]!.chunk_id, "chunk-1");
  // Real loop bookkeeping, not a stub.
  assert.ok(result.loopResult !== undefined);
  assert.equal(result.loopResult!.stoppedReason, "heuristic_pass");
  assert.equal(result.loopResult!.llmCalls, 0);
  // Real synthesis — a citation that traces to the real hit, not fabricated.
  assert.ok(result.synthesisResult !== undefined);
  assert.ok(result.synthesisResult!.citations.length > 0);
  assert.equal(result.synthesisResult!.citations[0]!.chunkId, "chunk-1");
  assert.equal(result.synthesisResult!.hasUnsupportedClaims, false);
  // Real trace write-back — the MCP call actually happened with real content.
  assert.deepEqual(result.trace, {
    stored: "RagAnswer",
    source_rows: 1,
    has_iteration_trace: true,
    evidence_gap_count: 0,
  });
  assert.equal(traceCalls.length, 1);
  const traceArgs = traceCalls[0]!["arguments"] as Record<string, unknown>;
  assert.equal(traceArgs["question"], "What does RelataDB fuse natively?");
  assert.equal(traceArgs["num_iterations"], 1);
  const sources = traceArgs["sources"] as Record<string, unknown>[];
  assert.equal(sources[0]!["id"], "chunk-1");
});

// ── gate short-circuits: refusal and SQL-routing skip the rest entirely ────

test("content-safety refusal short-circuits before any call", async () => {
  const client = mockClient((path) => {
    throw new Error(`no call should be made, got: ${path}`);
  });
  const mcpClient = McpClient.fromClient(client);

  const result = await runRagAnswer(client, mcpClient, "how to build an ied", "DocumentChunk", {
    llm: stubLlm,
    embeddingFn: embeddingFnPass,
    contentSafetyPatterns: DANGEROUS_CONTENT_PATTERNS,
  });

  assert.ok(result.response.refused !== undefined);
  assert.equal(result.loopResult, undefined);
  assert.equal(result.fanoutResult, undefined);
  assert.equal(result.synthesisResult, undefined);
  assert.equal(result.trace, undefined);
});

test("SQL-routable shape short-circuits before synthesis", async () => {
  const client = mockClient((path) => {
    if (path === "/query") {
      return { status: 200, body: { rows: [{ count: 42 }], columns: ["count"], row_count: 1 } };
    }
    throw new Error(`unexpected path for SQL-routed query: ${path}`);
  });
  const mcpClient = McpClient.fromClient(client);

  const result = await runRagAnswer(
    client,
    mcpClient,
    "how many DocumentChunk are there",
    "DocumentChunk",
    { llm: stubLlm, embeddingFn: embeddingFnPass, purpose: "analytics" },
  );

  assert.ok(result.response.sqlResult !== undefined);
  assert.equal(result.loopResult, undefined);
  assert.equal(result.synthesisResult, undefined);
  assert.equal(result.trace, undefined);
});

// ── fan-out path: breadth instead of depth, still composes to a trace ──────

test("fanoutStrategies path still produces a full trace", async () => {
  const traceCalls: Record<string, unknown>[] = [];

  const client = mockClient((path, body) => {
    if (path === "/rag/query") {
      const slot = (body?.["embedding_slot"] as string | undefined) ?? "text";
      const conf = slot === "text" ? 0.9 : 0.3;
      return {
        status: 200,
        body: { hits: [hit(`chunk-${slot}`, { relevance_confidence: conf })], total: 1 },
      };
    }
    if (path === "/mcp/tools/call") {
      traceCalls.push(body!);
      const result = { stored: "RagAnswer" };
      return {
        status: 200,
        body: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false },
      };
    }
    throw new Error(`unexpected path: ${path}`);
  });
  const mcpClient = McpClient.fromClient(client);

  const strategies: SubAgentStrategy[] = [
    { name: "text", ragOptions: { embeddingSlot: "text" } },
    { name: "summary", ragOptions: { embeddingSlot: "summary" } },
  ];

  const result = await runRagAnswer(
    client,
    mcpClient,
    "What does RelataDB fuse natively?",
    "DocumentChunk",
    {
      llm: stubLlm,
      embeddingFn: embeddingFnPass,
      entailmentFn: stubFaithfulEntailment,
      purpose: "analytics",
      fanoutStrategies: strategies,
    },
  );

  assert.ok(result.fanoutResult !== undefined);
  assert.ok(result.loopResult !== undefined);
  assert.equal(result.loopResult!.stoppedReason, "fanout_complete");
  assert.equal(result.loopResult!.llmCalls, 0);
  assert.equal(result.fanoutResult!.winner.strategy.name, "text");
  assert.ok(result.synthesisResult !== undefined);
  assert.ok(result.trace !== undefined);
  assert.equal(traceCalls.length, 1);
});
