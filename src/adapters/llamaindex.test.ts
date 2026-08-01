/**
 * Tests for the LlamaIndex.TS memory adapter (#2312).
 *
 * LlamaIndex is not imported (the adapter is framework-agnostic); these tests
 * drive it through a mocked Relata `/memory/*` surface, mirroring
 * `sdks/python/tests/test_adapters.py::test_llamaindex_put_get_reset`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { RelataMemory } from "./llamaindex.ts";

function mcpEnvelope(inner: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(inner) }], isError: false };
}

function mockMemoryServer(): { fetch: typeof globalThis.fetch; paths: string[] } {
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
        JSON.stringify(mcpEnvelope({ rows: [{ id: "a", content: "dark mode", score: 0.9 }] })),
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

test("RelataMemory (llamaindex): exposes BaseMemoryBlock-shaped id/priority/isLongTerm", () => {
  const { fetch } = mockMemoryServer();
  const mem = new RelataMemory({ baseUrl: "http://x", purpose: "agent", fetch });
  assert.equal(mem.id, "relata-memory");
  assert.equal(mem.priority, 0);
  assert.equal(mem.isLongTerm, true);
});

test("RelataMemory (llamaindex): put stores a message and records its role", async () => {
  const { fetch, paths } = mockMemoryServer();
  const mem = new RelataMemory({ baseUrl: "http://x", purpose: "agent", fetch });
  await mem.put([{ role: "user", content: "remember dark mode" }]);
  assert.equal(paths.filter((p) => p === "/memory/remember").length, 1);
});

test("RelataMemory (llamaindex): get recalls relevant memories from the last message", async () => {
  const { fetch, paths } = mockMemoryServer();
  const mem = new RelataMemory({ baseUrl: "http://x", purpose: "agent", fetch });

  const hits = await mem.get([{ role: "user", content: "theme preference" }]);
  assert.equal(hits[0]?.["content"], "dark mode");
  assert.ok(paths.includes("/memory/recall"));
});

test("RelataMemory (llamaindex): get with no messages returns [] and skips the round-trip", async () => {
  const { fetch, paths } = mockMemoryServer();
  const mem = new RelataMemory({ baseUrl: "http://x", purpose: "agent", fetch });
  assert.deepEqual(await mem.get([]), []);
  assert.equal(paths.length, 0);
});

test("RelataMemory (llamaindex): getAll always returns [] (semantic memory has no full scan)", async () => {
  const { fetch } = mockMemoryServer();
  const mem = new RelataMemory({ baseUrl: "http://x", purpose: "agent", fetch });
  assert.deepEqual(await mem.getAll(), []);
});

test("RelataMemory (llamaindex): reset retracts every memory this instance stored", async () => {
  const { fetch, paths } = mockMemoryServer();
  const mem = new RelataMemory({ baseUrl: "http://x", purpose: "agent", fetch });
  await mem.put({ role: "user", content: "dark mode" });
  await mem.reset();
  assert.ok(paths.some((p) => p.startsWith("/memory/forget/")));
});
