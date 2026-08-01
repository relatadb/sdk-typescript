/**
 * Tests for the LangChain.js memory adapter (#2312).
 *
 * LangChain is not imported (the adapter is framework-agnostic); these tests
 * drive it through a mocked Relata `/memory/*` surface and assert the
 * store/recall/clear behaviour, mirroring
 * `sdks/python/tests/test_adapters.py::test_langchain_save_and_load`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { RelataMemory } from "./langchain.ts";

/** Wrap an inner JSON payload in the MCP envelope the memory verbs return. */
function mcpEnvelope(inner: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(inner) }], isError: false };
}

/** A routing mock `fetch` that serves canned `/memory/*` replies and records calls. */
function mockMemoryServer(): {
  fetch: typeof globalThis.fetch;
  paths: string[];
} {
  const calls: string[] = [];
  let nextId = 0;
  const fetch = (async (url: string | URL | Request): Promise<Response> => {
    const path = new URL(typeof url === "string" ? url : url.toString()).pathname;
    calls.push(path);
    if (path === "/memory/remember") {
      nextId += 1;
      return new Response(JSON.stringify(mcpEnvelope({ id: `mem-${nextId}` })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/memory/recall") {
      return new Response(
        JSON.stringify(
          mcpEnvelope({ rows: [{ id: "a", content: "dark mode", score: 0.9 }] }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (path.startsWith("/memory/forget/")) {
      return new Response(
        JSON.stringify(mcpEnvelope({ memory_item_id: path.split("/").pop() })),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, paths: calls };
}

test("RelataMemory (langchain): memoryKeys reports the configured key", () => {
  const { fetch } = mockMemoryServer();
  const mem = new RelataMemory({ baseUrl: "http://x", purpose: "agent", fetch });
  assert.deepEqual(mem.memoryKeys, ["history"]);
});

test("RelataMemory (langchain): saveContext stores human + ai turns", async () => {
  const { fetch, paths } = mockMemoryServer();
  const mem = new RelataMemory({ baseUrl: "http://x", purpose: "agent", fetch });

  await mem.saveContext({ input: "what theme?" }, { output: "dark mode" });
  assert.equal(paths.filter((p) => p === "/memory/remember").length, 2);
});

test("RelataMemory (langchain): loadMemoryVariables recalls under memoryKey", async () => {
  const { fetch, paths } = mockMemoryServer();
  const mem = new RelataMemory({ baseUrl: "http://x", purpose: "agent", fetch });

  const out = await mem.loadMemoryVariables({ input: "theme preference" });
  assert.ok(String(out["history"]).includes("dark mode"));
  assert.ok(paths.includes("/memory/recall"));
});

test("RelataMemory (langchain): loadMemoryVariables with no input skips the recall round-trip", async () => {
  const { fetch, paths } = mockMemoryServer();
  const mem = new RelataMemory({ baseUrl: "http://x", purpose: "agent", fetch });

  const out = await mem.loadMemoryVariables({});
  assert.equal(out["history"], "");
  assert.equal(paths.length, 0);
});

test("RelataMemory (langchain): clear retracts every stored memory", async () => {
  const { fetch, paths } = mockMemoryServer();
  const mem = new RelataMemory({ baseUrl: "http://x", purpose: "agent", fetch });

  await mem.saveContext({ input: "a" }, { output: "b" });
  await mem.clear();
  assert.equal(paths.filter((p) => p.startsWith("/memory/forget/")).length, 2);
});

test("RelataMemory (langchain): custom memoryKey and topK are honored", async () => {
  const { fetch, paths } = mockMemoryServer();
  const mem = new RelataMemory({
    baseUrl: "http://x",
    purpose: "agent",
    memoryKey: "chat_history",
    topK: 3,
    fetch,
  });
  assert.deepEqual(mem.memoryKeys, ["chat_history"]);
  const out = await mem.loadMemoryVariables({ input: "x" });
  assert.ok("chat_history" in out);
  assert.ok(paths.includes("/memory/recall"));
});
