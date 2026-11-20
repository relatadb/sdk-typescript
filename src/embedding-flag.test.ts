/** #5726: search / RAG results expose the query-embedding flag and warn on fallback. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RelataClient } from "./client.ts";
import { RagClient } from "./rag.ts";
import { parseEmbeddingFlag } from "./embedding-flag.ts";
import type { Logger } from "./logger.ts";

const FALLBACK = {
  mode: "lexical-fallback",
  semantic: false,
  model: "cpu-deterministic:v1",
  reason: "no endpoint",
};

function recorder(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const noop = (): void => {};
  return {
    warnings,
    logger: { debug: noop, info: noop, error: noop, warn: (m: string) => warnings.push(m) },
  };
}

function fetchReturning(body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof globalThis.fetch;
}

test("parseEmbeddingFlag reads the wire object and rejects malformed ones", () => {
  assert.deepEqual(parseEmbeddingFlag(FALLBACK), FALLBACK);
  assert.equal(parseEmbeddingFlag({ mode: 1 }), undefined);
  assert.equal(parseEmbeddingFlag(null), undefined);
});

test("query() exposes the flag and warns when semantic is false", async () => {
  const { logger, warnings } = recorder();
  const relata = new RelataClient({
    baseUrl: "http://x",
    defaultPurpose: "p",
    logger,
    fetch: fetchReturning({ rows: 0, data: [], columns: [], embedding: FALLBACK }),
  });
  const r = await relata.query("HYBRID_SEARCH FROM Doc QUERY 'x' LIMIT 5");
  assert.equal(r.embedding?.mode, "lexical-fallback");
  assert.equal(r.embedding?.semantic, false);
  assert.equal(r.embedding?.reason, "no endpoint");
  assert.equal(warnings.length, 1);
});

test("RagClient.query warns on a model-mismatch fallback", async () => {
  const { logger, warnings } = recorder();
  const rag = new RagClient({
    baseUrl: "http://x",
    logger,
    fetch: fetchReturning({ hits: [], embedding: { ...FALLBACK, reason: "model mismatch" } }),
  });
  const resp = await rag.query("x", { type: "DocumentChunk", purpose: "p" });
  assert.equal(resp.embedding?.reason, "model mismatch");
  assert.equal(warnings.length, 1);
});

test("a semantic flag does not warn", async () => {
  const { logger, warnings } = recorder();
  const flag = { mode: "semantic", semantic: true, model: "e5:1", reason: null };
  const relata = new RelataClient({
    baseUrl: "http://x",
    defaultPurpose: "p",
    logger,
    fetch: fetchReturning({ rows: 0, data: [], embedding: flag }),
  });
  const r = await relata.query("HYBRID_SEARCH FROM Doc QUERY 'x' LIMIT 5");
  assert.equal(r.embedding?.semantic, true);
  assert.equal(warnings.length, 0);
});
