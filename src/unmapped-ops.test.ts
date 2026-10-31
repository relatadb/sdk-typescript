/**
 * Wire tests for server operations that previously had no SDK method
 * (Refs #5960). Mirrors sdks/python/tests/test_l5_unmapped_ops.py.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { GovernanceClient, IngestClient, RelataClient, SystemClient } from "./index.ts";
import { StreamingClient } from "./streaming.ts";

type Call = { url: string; method: string; body: string | undefined };

function recorder(sse = false): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (sse) {
      return new Response('event: change\ndata: {"id":1}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test("SystemClient: config, specs, mcp sessions, notification patch", async () => {
  const { fetch, calls } = recorder();
  const sys = new SystemClient({ baseUrl: "http://x", fetch });
  await sys.systemConfig();
  await sys.systemSpecs();
  await sys.mcpSessions();
  await sys.mcpSessions({ sessionId: "s 1", limit: 5 });
  await sys.updateNotificationRule("r/1", { enabled: false });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      "GET http://x/v1/system/config",
      "GET http://x/v1/system/specs",
      "GET http://x/v1/mcp/sessions",
      "GET http://x/v1/mcp/sessions?session_id=s+1&limit=5",
      "PATCH http://x/v1/notification-rules/r%2F1",
    ],
  );
  assert.deepEqual(JSON.parse(calls[4]!.body!), { enabled: false });
});

test("GovernanceClient: getRule, removeRuleException, setRetentionPolicy", async () => {
  const { fetch, calls } = recorder();
  const gov = new GovernanceClient({ baseUrl: "http://x", fetch });
  await gov.getRule("a/b");
  await gov.removeRuleException("a/b", "e 1");
  await gov.setRetentionPolicy("TraceSpan", 30);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      "GET http://x/v1/rules/a%2Fb",
      "DELETE http://x/v1/rules/a%2Fb/exceptions/e%201",
      "POST http://x/v1/retention/policies",
    ],
  );
  assert.deepEqual(JSON.parse(calls[2]!.body!), {
    object_type: "TraceSpan",
    max_age_days: 30,
    action: "delete",
  });
});

test("IngestClient: importStix sends the bundle with format and purpose", async () => {
  const { fetch, calls } = recorder();
  const ing = new IngestClient({ baseUrl: "http://x", purpose: "intel", fetch });
  const bundle = { type: "bundle", id: "bundle--1", objects: [] };
  await ing.importStix(bundle);
  await ing.importStix(bundle, { purpose: "other" });
  assert.equal(calls[0]!.method, "POST");
  const first = new URL(calls[0]!.url);
  assert.equal(first.pathname, "/v1/ingest/import");
  assert.equal(first.searchParams.get("format"), "stix");
  assert.equal(first.searchParams.get("purpose"), "intel");
  assert.equal(new URL(calls[1]!.url).searchParams.get("purpose"), "other");
  assert.deepEqual(JSON.parse(calls[0]!.body!), bundle);
});

test("RelataClient: type detect-config list and set", async () => {
  const { fetch, calls } = recorder();
  const c = new RelataClient({ baseUrl: "http://x", fetch });
  await c.listTypeDetectConfigs();
  await c.setTypeDetectConfig("Person", ["contact"]);
  assert.deepEqual(
    calls.map((x) => `${x.method} ${x.url}`),
    ["GET http://x/v1/types/detect-config", "POST http://x/v1/types/detect-config"],
  );
  assert.deepEqual(JSON.parse(calls[1]!.body!), { type: "Person", packs: ["contact"] });
});

test("StreamingClient: graphChanges and a2aTaskStream consume SSE", async () => {
  const { fetch, calls } = recorder(true);
  const s = new StreamingClient(new RelataClient({ baseUrl: "http://x", fetch }));
  const out: Record<string, unknown>[] = [];
  for await (const ev of s.graphChanges({ type: "Person", reconnect: false })) out.push(ev);
  for await (const ev of s.a2aTaskStream("t/1")) out.push(ev);
  assert.equal(out.length, 2);
  assert.equal(out[0]!["id"], 1);
  assert.equal(calls[0]!.url, "http://x/v1/graph/changes?type=Person");
  assert.equal(calls[1]!.url, "http://x/v1/a2a/tasks/t%2F1/stream");
});

test("StreamingClient: graphChanges without filters has no query string", async () => {
  const { fetch, calls } = recorder(true);
  const s = new StreamingClient(new RelataClient({ baseUrl: "http://x", fetch }));
  for await (const _ev of s.graphChanges({ reconnect: false })) void _ev;
  assert.equal(calls[0]!.url, "http://x/v1/graph/changes");
});
