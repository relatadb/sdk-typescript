// #6779: an MCP tool error keeps the server's `code` and reason instead of a bare
// `HTTP 400`. Bodies are recorded from `POST /v1/mcp/tools/call`.
import test from "node:test";
import assert from "node:assert/strict";
import { McpClient } from "./mcp.ts";
import { RelataError } from "./errors.ts";

const RULE_DETAIL = "invalid condition_sql: parse error: expected '=', found 'SELECT'";

// Current server: `detail`, `code` and the HTTP problem in `structuredContent`.
const CREATE_RULE_BODY = {
  content: [{ type: "text", text: RULE_DETAIL }],
  isError: true,
  code: "rule-condition-invalid",
  detail: RULE_DETAIL,
  structuredContent: {
    type: "https://relatadb.dev/errors/rule-condition-invalid",
    title: "Bad Request",
    status: 400,
    detail: RULE_DETAIL,
    code: "rule-condition-invalid",
  },
};

// v3.0.0-rc.4 server: the reason only in `content[0].text`.
const RECOGNIZE_TEXT = "field 'id' has wrong type (expected string, got object)";
const RC4_RECOGNIZE_BODY = {
  content: [{ type: "text", text: RECOGNIZE_TEXT }],
  isError: true,
  code: "invalid_params",
};

function client(body: unknown): McpClient {
  const fetch: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  return new McpClient({ baseUrl: "http://relata.invalid", fetch });
}

async function caught(p: Promise<unknown>): Promise<RelataError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof RelataError, String(e));
    return e;
  }
  assert.fail("expected the call to throw");
}

test("createRule error keeps code and detail", async () => {
  const err = await caught(
    client(CREATE_RULE_BODY).createRule("r1", "SELECT * FROM Person WHERE name = 'x'", "Person"),
  );
  assert.equal(err.statusCode, 400);
  assert.equal(err.code, "rule-condition-invalid");
  assert.ok(err.message.includes(RULE_DETAIL), err.message);
});

test("MCP envelope text is the fallback detail", async () => {
  const err = await caught(
    client(RC4_RECOGNIZE_BODY).recognize({ id: "m1" } as unknown as string),
  );
  assert.equal(err.code, "invalid_params");
  assert.ok(err.message.includes(RECOGNIZE_TEXT), err.message);
});
