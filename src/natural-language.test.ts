import assert from "node:assert/strict";
import test from "node:test";
import type { RelataClient } from "./client.ts";
import { queryInNaturalLanguage } from "./natural-language.ts";

test("queryInNaturalLanguage uses visible schema and governed query", async () => {
  const calls: string[] = [];
  let queryOptions: { purpose?: string; timeoutMs?: number } | undefined;
  const client = {
    async querySchema(purpose: string) {
      calls.push(`schema:${purpose}`);
      return { purpose, object_types: ["Person"], link_types: ["Knows"] };
    },
    async query(sql: string, options: { purpose?: string; timeoutMs?: number }) {
      queryOptions = options;
      calls.push(`query:${options.purpose}:${sql}`);
      return {
        rows: [{ name: "Ada", citation: { chunk_id: "chunk-1", report_id: "doc-1" } }],
        queryId: "q1", elapsedMs: 1, rowCount: 1, columns: ["name", "citation"],
      };
    },
  } as unknown as RelataClient;
  let prompt = "";
  const result = await queryInNaturalLanguage(client, "find a person", {
    purpose: "analytics",
    timeoutMs: 25,
    complete: async (value) => {
      prompt = value;
      return { text: "SELECT * FROM Person", modelId: "local-model" };
    },
    answer: async (_question, governedResult, context) => {
      assert.equal(context.maxOutputTokens, 512);
      assert.deepEqual(governedResult.rows[0]?.["citation"], {
        chunk_id: "chunk-1", report_id: "doc-1",
      });
      return { text: "Ada is supported by chunk-1.", modelId: "answer-model" };
    },
  });
  assert.match(prompt, /Visible object types: Person/);
  assert.equal(result.sql, "SELECT * FROM Person LIMIT 100");
  assert.equal(result.result.rows[0]?.["name"], "Ada");
  assert.equal(result.answerModelId, "answer-model");
  assert.equal(result.answer, "Ada is supported by chunk-1.");
  assert.equal(result.modelId, "local-model");
  assert.deepEqual(queryOptions, { purpose: "analytics", timeoutMs: 25 });
  assert.deepEqual(calls, [
    "schema:analytics",
    "query:analytics:SELECT * FROM Person LIMIT 100",
  ]);
});

test("queryInNaturalLanguage propagates provider failures without executing SQL", async () => {
  let queryCalls = 0;
  const client = {
    async querySchema() {
      return { purpose: "analytics", object_types: ["Person"], link_types: [] };
    },
    async query() {
      queryCalls += 1;
      throw new Error("must not reach governed query");
    },
  } as unknown as RelataClient;
  await assert.rejects(
    queryInNaturalLanguage(client, "find a person", {
      purpose: "analytics",
      complete: async () => { throw new Error("provider unavailable"); },
    }),
    /provider unavailable/,
  );
  assert.equal(queryCalls, 0);
});

test("queryInNaturalLanguage propagates governed-query timeout errors", async () => {
  const timeout = new Error("query timed out");
  const optionsSeen: { timeoutMs?: number }[] = [];
  const client = {
    async querySchema() {
      return { purpose: "analytics", object_types: ["Person"], link_types: [] };
    },
    async query(_sql: string, options: { timeoutMs?: number }) {
      optionsSeen.push(options);
      throw timeout;
    },
  } as unknown as RelataClient;
  await assert.rejects(
    queryInNaturalLanguage(client, "find a person", {
      purpose: "analytics",
      timeoutMs: 10,
      complete: async () => "SELECT * FROM Person",
    }),
    (error: unknown) => error === timeout,
  );
  assert.deepEqual(optionsSeen, [{ purpose: "analytics", timeoutMs: 10 }]);
});

test("queryInNaturalLanguage rejects completion outside its bounded read-only contract", async () => {
  const client = {
    async querySchema() {
      return { purpose: "analytics", object_types: [], link_types: [] };
    },
    async query() {
      throw new Error("must not execute rejected SQL");
    },
  } as unknown as RelataClient;
  await assert.rejects(
    queryInNaturalLanguage(client, "show me", {
      purpose: "analytics",
      complete: async () => "DELETE FROM Person",
    }),
    /read-only SELECT/,
  );
});
