/**
 * Tests for the typed v1.1 clients — verifies path/method/payload routing for
 * a representative sample (GovernanceClient, McpClient, A2AClient,
 * TokenClient, LogClient, AuditClient, BackupClient, TenantAdminClient,
 * IdentityClient, VectorClient) plus the `fromClient` inheritance of auth +
 * tenant headers.
 *
 * Uses Node's built-in `node:test` runner with an injected `fetch` mock.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  A2AClient,
  AuditClient,
  BackupClient,
  createClient,
  GovernanceClient,
  IdentityClient,
  IngestClient,
  LogClient,
  McpClient,
  RelataClient,
  SystemClient,
  TenantAdminClient,
  TokenClient,
  unwrapMcp,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  bodyText?: string;
}

function mockFetch(
  responses: MockResponse[] | MockResponse,
): {
  fetch: typeof globalThis.fetch;
  calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
  }>;
} {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
  }> = [];
  const fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlString = typeof url === "string" ? url : url.toString();
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: urlString,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? (init.body as string) : undefined,
    });
    const next = queue.shift() ?? { status: 200, body: {} };
    const status = next.status ?? 200;
    const headerMap = new Headers();
    for (const [k, v] of Object.entries(next.headers ?? {})) headerMap.set(k, v);
    headerMap.set("content-type", headerMap.get("content-type") ?? "application/json");
    const bodyText =
      next.bodyText ??
      (typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {}));
    return new Response(bodyText, { status, headers: headerMap });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function mcpEnvelope(inner: unknown): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(inner) }],
    isError: false,
  };
}

// ---------------------------------------------------------------------------
// fromClient inheritance
// ---------------------------------------------------------------------------

test("fromClient: typed clients inherit baseUrl, bearerToken, tenant, purpose", async () => {
  const { fetch, calls } = mockFetch({ body: { rules: [] } });
  const relata = new RelataClient({
    baseUrl: "http://srv:8080/",
    bearerToken: "tok",
    defaultPurpose: "compliance",
    tenant: "acme",
    fetch,
  });
  const gov = GovernanceClient.fromClient(relata);
  await gov.listRules();
  assert.equal(calls[0]?.url, "http://srv:8080/rules");
  assert.equal(calls[0]?.headers["authorization"], "Bearer tok");
  assert.equal(calls[0]?.headers["x-relata-tenant-id"], "acme");
});

// ---------------------------------------------------------------------------
// GovernanceClient
// ---------------------------------------------------------------------------

test("GovernanceClient: listRules, createRule, importSigma, placeLegalHold, requestBreakglass, submitDsar", async () => {
  const queue: MockResponse[] = [
    { body: { rules: [{ id: "r1" }] } }, // listRules
    { body: { id: "r2", name: "big-xfer" } }, // createRule
    { body: { rules_imported: 1, rules_skipped: 0 } }, // importSigma
    { body: { case_id: "c1", object_type: "Person" } }, // placeLegalHold
    { body: { request_id: "bg1", status: "pending" } }, // requestBreakglass
    { body: { dsar_id: "d1" } }, // submitDsar
  ];
  const { fetch, calls } = mockFetch(queue);
  const gov = new GovernanceClient({ baseUrl: "http://x", fetch, purpose: "compliance" });

  const rules = await gov.listRules({ objectType: "Transaction" });
  assert.equal(rules.length, 1);
  assert.ok(calls[0]?.url.includes("/rules?object_type=Transaction"));

  const rule = await gov.createRule({ name: "big-xfer" });
  assert.equal(rule["id"], "r2");
  assert.equal(calls[1]?.method, "POST");
  assert.ok(calls[1]?.url.includes("/rules?purpose=compliance"));

  const sigma = await gov.importSigma("title: x");
  assert.equal(sigma["rules_imported"], 1);
  assert.ok(calls[2]?.url.includes("/rules/sigma?purpose=compliance"));
  assert.equal(calls[2]?.headers["content-type"], "application/x-yaml");
  assert.equal(calls[2]?.body, "title: x");

  const hold = await gov.placeLegalHold("c1", "Person", { field: "env", value: "prod" });
  assert.equal(hold["case_id"], "c1");
  assert.deepEqual(JSON.parse(calls[3]?.body ?? "{}"), {
    case_id: "c1",
    object_type: "Person",
    field: "env",
    value: "prod",
  });

  const bg = await gov.requestBreakglass("SRC-0042", { justification: "urgent triage" });
  assert.equal(bg["request_id"], "bg1");
  assert.deepEqual(JSON.parse(calls[4]?.body ?? "{}"), {
    source_id: "SRC-0042",
    justification: "urgent triage",
  });

  const dsar = await gov.submitDsar("alice@x.com", "gdpr-art-15", { scope: "email" });
  assert.equal(dsar["dsar_id"], "d1");
  assert.ok(calls[5]?.url.includes("/gdpr/dsar?"));
  assert.ok(calls[5]?.url.includes("subject_identity=alice%40x.com"));
  assert.ok(calls[5]?.url.includes("reason=gdpr-art-15"));
  assert.ok(calls[5]?.url.includes("scope=email"));
});

test("GovernanceClient: createRule/importSigma require a purpose", async () => {
  const { fetch } = mockFetch({ body: {} });
  const gov = new GovernanceClient({ baseUrl: "http://x", fetch });
  await assert.rejects(() => gov.createRule({ name: "x" }), /purpose/i);
  await assert.rejects(() => gov.importSigma("title: x"), /purpose/i);
});

test("GovernanceClient: suppressRule sends entity_id, not a bare pattern", async () => {
  const { fetch, calls } = mockFetch({ body: { rule_id: "r1" } });
  const gov = new GovernanceClient({ baseUrl: "http://x", fetch });
  await gov.suppressRule("r1", "entity-42", { condition: "known FP" });
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    entity_id: "entity-42",
    condition: "known FP",
  });
});

test("GovernanceClient: snoozeRule, addRuleException, getRuleTuning", async () => {
  const queue: MockResponse[] = [
    { body: { rule_id: "r1", snoozed_until: "2026-01-01T00:00:00Z" } },
    { body: { rule_id: "r1" } },
    { body: { snoozed_until_ns: null, suppressed_entities: [] } },
  ];
  const { fetch, calls } = mockFetch(queue);
  const gov = new GovernanceClient({ baseUrl: "http://x", fetch });

  await gov.snoozeRule("r1", 3600);
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), { duration_secs: 3600 });

  await gov.addRuleException("r1", { entity_id: "e1" });
  assert.ok(calls[1]?.url.endsWith("/rules/r1/exceptions"));

  await gov.getRuleTuning("r1");
  assert.equal(calls[2]?.method, "GET");
  assert.ok(calls[2]?.url.endsWith("/rules/r1/tuning"));
});

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

test("McpClient: initialize, listTools, callTool, queryKnowledge", async () => {
  const queue: MockResponse[] = [
    { body: mcpEnvelope({ protocol_version: "1.0" }) }, // initialize
    { body: mcpEnvelope({ tools: [{ name: "t1" }] }) }, // listTools
    { body: mcpEnvelope({ rows: [{ id: "p1" }] }) }, // queryKnowledge
    { body: mcpEnvelope({ ok: true }) }, // callTool raw
  ];
  const { fetch, calls } = mockFetch(queue);
  const mcp = new McpClient({ baseUrl: "http://x", fetch });

  const init = await mcp.initialize();
  assert.equal(init["protocol_version"], "1.0");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    client_id: "relata-typescript-sdk",
    version: "1.0",
  });

  const tools = await mcp.listTools();
  assert.equal(tools.length, 1);

  const result = await mcp.queryKnowledge("SELECT * FROM Person", "analytics");
  const rows = result["rows"] as Array<Record<string, unknown>>;
  assert.equal(rows[0]?.["id"], "p1");
  assert.deepEqual(JSON.parse(calls[2]?.body ?? "{}"), {
    name: "query_knowledge",
    arguments: { sql: "SELECT * FROM Person", purpose: "analytics" },
  });

  const raw = await mcp.callTool("custom_tool", { foo: "bar" });
  assert.equal(raw["ok"], true);
});

// ---------------------------------------------------------------------------
// #2322 — 42 (+4) previously Rust-only MCP tool wrappers, ported to TS.
//
// Each assertion checks the wire tool `name` and the `arguments` sent match
// the server's real registration (source of truth: the `input_schema`
// blocks in `crates/relata-cli/src/serve.rs` and
// `crates/relata-cli/src/serve/mcp/procedure.rs`), not merely that the
// method exists.
// ---------------------------------------------------------------------------

async function callAndCapture(
  fn: (mcp: McpClient) => Promise<unknown>,
): Promise<{ name: unknown; arguments: Record<string, unknown> }> {
  const { fetch, calls } = mockFetch([{ body: mcpEnvelope({ ok: true }) }]);
  const mcp = new McpClient({ baseUrl: "http://x", fetch });
  await fn(mcp);
  return JSON.parse(calls[0]?.body ?? "{}");
}

test("McpClient #2322: rememberBatch sends items", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.rememberBatch([{ content: "a" }], { purpose: "analytics" }),
  );
  assert.equal(seen.name, "remember_batch");
  assert.deepEqual(seen.arguments["items"], [{ content: "a" }]);
  assert.equal(seen.arguments["purpose"], "analytics");
});

test("McpClient #2322: recognize sends id", async () => {
  const seen = await callAndCapture((mcp) => mcp.recognize("mem-1"));
  assert.equal(seen.name, "recognize");
  assert.equal(seen.arguments["id"], "mem-1");
});

test("McpClient #2322: episodesIn sends session_id and limit", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.episodesIn("sess-1", { limit: 5 }),
  );
  assert.equal(seen.name, "episodes_in");
  assert.equal(seen.arguments["session_id"], "sess-1");
  assert.equal(seen.arguments["limit"], 5);
});

test("McpClient #2322: justify sends id", async () => {
  const seen = await callAndCapture((mcp) => mcp.justify("mem-1"));
  assert.equal(seen.name, "justify");
  assert.equal(seen.arguments["id"], "mem-1");
});

test("McpClient #2322: consolidate sends id and content", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.consolidate("mem-1", "updated", { confidence: 0.5 }),
  );
  assert.equal(seen.name, "consolidate");
  assert.equal(seen.arguments["id"], "mem-1");
  assert.equal(seen.arguments["content"], "updated");
  assert.equal(seen.arguments["confidence"], 0.5);
});

test("McpClient #2322: forget sends id and retain_days", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.forget("mem-1", { retainDays: 30 }),
  );
  assert.equal(seen.name, "forget");
  assert.equal(seen.arguments["id"], "mem-1");
  assert.equal(seen.arguments["retain_days"], 30);
});

test("McpClient #2322: rememberProcedure sends schema fields", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.rememberProcedure("agent-1", "onboarding", "do the thing"),
  );
  assert.equal(seen.name, "remember_procedure");
  assert.equal(seen.arguments["agent_id"], "agent-1");
  assert.equal(seen.arguments["name"], "onboarding");
  assert.equal(seen.arguments["instruction_text"], "do the thing");
});

test("McpClient #2322: recallProcedure sends agent_id", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.recallProcedure("agent-1", { name: "onboarding", allVersions: true }),
  );
  assert.equal(seen.name, "recall_procedure");
  assert.equal(seen.arguments["agent_id"], "agent-1");
  assert.equal(seen.arguments["name"], "onboarding");
  assert.equal(seen.arguments["all_versions"], true);
});

test("McpClient #2322: associate sends from_id/to_id/relation", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.associate("mem-1", "mem-2", { relation: "contradicts" }),
  );
  assert.equal(seen.name, "associate");
  assert.equal(seen.arguments["from_id"], "mem-1");
  assert.equal(seen.arguments["to_id"], "mem-2");
  assert.equal(seen.arguments["relation"], "contradicts");
});

test("McpClient #2322: resolve sends id", async () => {
  const seen = await callAndCapture((mcp) => mcp.resolve("mem-1"));
  assert.equal(seen.name, "resolve");
  assert.equal(seen.arguments["id"], "mem-1");
});

test("McpClient #2322: summarise sends ids", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.summarise({ ids: ["mem-1", "mem-2"], scope: "topic:fraud" }),
  );
  assert.equal(seen.name, "summarise");
  assert.deepEqual(seen.arguments["ids"], ["mem-1", "mem-2"]);
  assert.equal(seen.arguments["scope"], "topic:fraud");
});

test("McpClient #2322: nlQuery sends query", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.nlQuery("find all persons in Dublin", { interpret: true }),
  );
  assert.equal(seen.name, "nl_query");
  assert.equal(seen.arguments["query"], "find all persons in Dublin");
  assert.equal(seen.arguments["interpret"], true);
});

test("McpClient #2322: eraseSubject sends subject and reason", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.eraseSubject("alice@example.com", { reason: "user-request" }),
  );
  assert.equal(seen.name, "erase_subject");
  assert.equal(seen.arguments["subject"], "alice@example.com");
  assert.equal(seen.arguments["reason"], "user-request");
});

test("McpClient #2322: ingestMedia sends object_type", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.ingestMedia("MediaContent", { bytesB64: "Zm9v" }),
  );
  assert.equal(seen.name, "ingest_media");
  assert.equal(seen.arguments["object_type"], "MediaContent");
  assert.equal(seen.arguments["bytes_b64"], "Zm9v");
});

test("McpClient #2322: similarMultimodal sends entity_type and id", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.similarMultimodal("Document", "doc-1", { topK: 5 }),
  );
  assert.equal(seen.name, "similar_multimodal");
  assert.equal(seen.arguments["entity_type"], "Document");
  assert.equal(seen.arguments["id"], "doc-1");
  assert.equal(seen.arguments["entity_id"], undefined);
});

test("McpClient #2322: hybridSearch sends entity_type and query", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.hybridSearch("Document", "fraud ring"),
  );
  assert.equal(seen.name, "hybrid_search");
  assert.equal(seen.arguments["entity_type"], "Document");
  assert.equal(seen.arguments["query"], "fraud ring");
});

test("McpClient #2322: pathsBetween sends from and to", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.pathsBetween("a", "b", { maxHops: 6 }),
  );
  assert.equal(seen.name, "paths_between");
  assert.equal(seen.arguments["from"], "a");
  assert.equal(seen.arguments["to"], "b");
  assert.equal(seen.arguments["max_hops"], 6);
});

test("McpClient #2322: listLinkTypes sends no args", async () => {
  const seen = await callAndCapture((mcp) => mcp.listLinkTypes());
  assert.equal(seen.name, "list_link_types");
});

test("McpClient #2322: serverHealth sends no args", async () => {
  const seen = await callAndCapture((mcp) => mcp.serverHealth());
  assert.equal(seen.name, "server_health");
});

test("McpClient #2322: jobStatus sends no args", async () => {
  const seen = await callAndCapture((mcp) => mcp.jobStatus());
  assert.equal(seen.name, "job_status");
});

test("McpClient #2322: metrics sends no args", async () => {
  const seen = await callAndCapture((mcp) => mcp.metrics());
  assert.equal(seen.name, "metrics");
});

test("McpClient #2322: listRules sends no args", async () => {
  const seen = await callAndCapture((mcp) => mcp.listRules());
  assert.equal(seen.name, "list_rules");
});

test("McpClient #2322: createRule sends name and condition_sql", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.createRule("high-value-txn", "amount > 10000", { severity: "high" }),
  );
  assert.equal(seen.name, "create_rule");
  assert.equal(seen.arguments["name"], "high-value-txn");
  assert.equal(seen.arguments["condition_sql"], "amount > 10000");
  assert.equal(seen.arguments["severity"], "high");
  assert.equal(seen.arguments["purpose"], "security");
});

test("McpClient #2322: importSigma sends yaml key", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.importSigma("title: test\n"),
  );
  assert.equal(seen.name, "import_sigma");
  assert.equal(seen.arguments["yaml"], "title: test\n");
  assert.equal(seen.arguments["sigma_yaml"], undefined);
});

test("McpClient #2322: listJobs sends no args", async () => {
  const seen = await callAndCapture((mcp) => mcp.listJobs());
  assert.equal(seen.name, "list_jobs");
});

test("McpClient #2322: scheduleJob sends name", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.scheduleJob("transaction_ring"),
  );
  assert.equal(seen.name, "schedule_job");
  assert.equal(seen.arguments["name"], "transaction_ring");
});

test("McpClient #2322: listWorkflows sends no args", async () => {
  const seen = await callAndCapture((mcp) => mcp.listWorkflows());
  assert.equal(seen.name, "list_workflows");
});

test("McpClient #2322: runWorkflow sends name", async () => {
  const seen = await callAndCapture((mcp) => mcp.runWorkflow("aml-review"));
  assert.equal(seen.name, "run_workflow");
  assert.equal(seen.arguments["name"], "aml-review");
});

test("McpClient #2322: workflowStatus sends run_id", async () => {
  const seen = await callAndCapture((mcp) => mcp.workflowStatus("run-1"));
  assert.equal(seen.name, "workflow_status");
  assert.equal(seen.arguments["run_id"], "run-1");
});

test("McpClient #2322: traceCrypto sends address", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.traceCrypto("bc1qxyz", { maxHops: 3 }),
  );
  assert.equal(seen.name, "trace_crypto");
  assert.equal(seen.arguments["address"], "bc1qxyz");
  assert.equal(seen.arguments["max_hops"], 3);
  assert.equal(seen.arguments["purpose"], "analytics");
});

test("McpClient #2322: beneficialOwnership sends party", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.beneficialOwnership("Acme Holdings"),
  );
  assert.equal(seen.name, "beneficial_ownership");
  assert.equal(seen.arguments["party"], "Acme Holdings");
});

test("McpClient #2322: reconstructWire sends account", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.reconstructWire("IE12BOFI90000112345678"),
  );
  assert.equal(seen.name, "reconstruct_wire");
  assert.equal(seen.arguments["account"], "IE12BOFI90000112345678");
});

test("McpClient #2322: traceHawala sends seed", async () => {
  const seen = await callAndCapture((mcp) => mcp.traceHawala("actor-1"));
  assert.equal(seen.name, "trace_hawala");
  assert.equal(seen.arguments["seed"], "actor-1");
});

test("McpClient #2322: geofence sends lat/lon", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.geofence(53.35, -6.26, { radiusM: 500 }),
  );
  assert.equal(seen.name, "geofence");
  assert.equal(seen.arguments["lat"], 53.35);
  assert.equal(seen.arguments["lon"], -6.26);
  assert.equal(seen.arguments["radius_m"], 500);
});

test("McpClient #2322: resolveEntityIdentity sends identity", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.resolveEntityIdentity("alice@example.com"),
  );
  assert.equal(seen.name, "resolve_entity_identity");
  assert.equal(seen.arguments["identity"], "alice@example.com");
});

test("McpClient #2322: detectCommunities sends entity_type", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.detectCommunities("Person", { algo: "leiden" }),
  );
  assert.equal(seen.name, "detect_communities");
  assert.equal(seen.arguments["entity_type"], "Person");
  assert.equal(seen.arguments["algo"], "leiden");
});

test("McpClient #2322: rankKeyNodes sends entity_type and metric", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.rankKeyNodes("Person", { metric: "betweenness" }),
  );
  assert.equal(seen.name, "rank_key_nodes");
  assert.equal(seen.arguments["entity_type"], "Person");
  assert.equal(seen.arguments["metric"], "betweenness");
});

test("McpClient #2322: hubAuthority sends entity_type", async () => {
  const seen = await callAndCapture((mcp) => mcp.hubAuthority("Person"));
  assert.equal(seen.name, "hub_authority");
  assert.equal(seen.arguments["entity_type"], "Person");
});

test("McpClient #2322: predictLinks sends entity_type", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.predictLinks("Person", { fromId: "p1", toId: "p2", method: "jaccard" }),
  );
  assert.equal(seen.name, "predict_links");
  assert.equal(seen.arguments["entity_type"], "Person");
  assert.equal(seen.arguments["from_id"], "p1");
  assert.equal(seen.arguments["to_id"], "p2");
  assert.equal(seen.arguments["method"], "jaccard");
});

test("McpClient #2322: findScc sends entity_type", async () => {
  const seen = await callAndCapture((mcp) => mcp.findScc("Person"));
  assert.equal(seen.name, "find_scc");
  assert.equal(seen.arguments["entity_type"], "Person");
});

test("McpClient #2322: screenSanctions sends name", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.screenSanctions("John Doe", { threshold: 0.9 }),
  );
  assert.equal(seen.name, "screen_sanctions");
  assert.equal(seen.arguments["name"], "John Doe");
  assert.equal(seen.arguments["threshold"], 0.9);
  assert.equal(seen.arguments["purpose"], "compliance_review");
});

test("McpClient #2322: aggregateStats sends entity_type", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.aggregateStats("Transaction", { agg: "SUM", column: "amount" }),
  );
  assert.equal(seen.name, "aggregate_stats");
  assert.equal(seen.arguments["entity_type"], "Transaction");
  assert.equal(seen.arguments["agg"], "SUM");
  assert.equal(seen.arguments["column"], "amount");
});

test("McpClient #2322: investigateEntity sends entity_type and id", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.investigateEntity("Person", "p1"),
  );
  assert.equal(seen.name, "investigate_entity");
  assert.equal(seen.arguments["entity_type"], "Person");
  assert.equal(seen.arguments["id"], "p1");
});

test("McpClient #2322: findThreats sends entity_type", async () => {
  const seen = await callAndCapture((mcp) => mcp.findThreats("Person"));
  assert.equal(seen.name, "find_threats");
  assert.equal(seen.arguments["entity_type"], "Person");
});

test("McpClient #2322: searchVideoFrames sends query_id", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.searchVideoFrames("frame-1", { topK: 10 }),
  );
  assert.equal(seen.name, "search_video_frames");
  assert.equal(seen.arguments["query_id"], "frame-1");
  assert.equal(seen.arguments["top_k"], 10);
});

test("McpClient #2322: faceMatch sends probe_id", async () => {
  const seen = await callAndCapture((mcp) =>
    mcp.faceMatch("probe-1", { threshold: 0.9 }),
  );
  assert.equal(seen.name, "face_match");
  assert.equal(seen.arguments["probe_id"], "probe-1");
  assert.equal(seen.arguments["threshold"], 0.9);
});

test("unwrapMcp: returns response unchanged when not enveloped", () => {
  const flat = { rows: [1, 2, 3] };
  assert.equal(unwrapMcp(flat), flat);
  const enveloped = {
    content: [{ type: "text", text: '{"a": 1}' }],
  };
  assert.deepEqual(unwrapMcp(enveloped), { a: 1 });
});

// ---------------------------------------------------------------------------
// A2AClient
// ---------------------------------------------------------------------------

test("A2AClient: submitTask, getTask, saveCheckpoint, agentCard", async () => {
  const queue: MockResponse[] = [
    { body: { id: "t1", status: "queued" } }, // submitTask
    { body: { id: "t1", status: "running" } }, // getTask
    { body: { ok: true } }, // saveCheckpoint (PUT)
    { body: { skills: [] } }, // agentCard
  ];
  const { fetch, calls } = mockFetch(queue);
  const a2a = new A2AClient({ baseUrl: "http://x", fetch });

  const task = await a2a.submitTask({ name: "do-thing" });
  assert.equal(task["id"], "t1");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), { name: "do-thing" });

  const poll = await a2a.getTask("t1");
  assert.equal(poll["status"], "running");
  assert.equal(calls[1]?.url, "http://x/a2a/tasks/t1");

  const saved = await a2a.saveCheckpoint("th1", "c1", { checkpoint: {} });
  assert.equal(saved["ok"], true);
  assert.equal(calls[2]?.method, "PUT");
  assert.equal(calls[2]?.url, "http://x/a2a/checkpoints/th1/c1");

  const card = await a2a.agentCard();
  assert.deepEqual(card["skills"], []);
  assert.equal(calls[3]?.url, "http://x/.well-known/agent.json");
});

// ---------------------------------------------------------------------------
// TokenClient
// ---------------------------------------------------------------------------

test("TokenClient: remember, check, revoke, stats", async () => {
  const queue: MockResponse[] = [
    { body: { newly_inserted: true } }, // remember
    { body: { present: false } }, // check
    { body: { revoked: true } }, // revoke
    { body: { count: 5, oldest_ns: 99, eviction_policy: "lru" } }, // stats
  ];
  const { fetch, calls } = mockFetch(queue);
  const tc = new TokenClient({ baseUrl: "http://x", fetch });

  assert.equal(await tc.remember("tok-1"), true);
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), { id: "tok-1" });

  assert.deepEqual(await tc.check("tok-1"), { present: false });

  assert.equal(await tc.revoke("tok-1"), true);
  assert.equal(calls[2]?.method, "DELETE");

  const stats = await tc.stats();
  assert.equal(stats.count, 5);
  assert.equal(stats.oldestNs, 99);
  assert.equal(stats.evictionPolicy, "lru");
});

// ---------------------------------------------------------------------------
// LogClient
// ---------------------------------------------------------------------------

test("LogClient: append, head, loadLeaves (base64 round-trip)", async () => {
  const queue: MockResponse[] = [
    { body: { index: 7, commit_ns: 12345 } }, // append
    { body: { head: 7 } }, // head
    {
      body: {
        leaves: [
          { index: 5, data_b64: "aGVsbG8=", commit_ns: 100 }, // "hello"
          { index: 6, data_b64: "d29ybGQ=", commit_ns: 101 }, // "world"
        ],
      },
    },
  ];
  const { fetch } = mockFetch(queue);
  const log = new LogClient({ baseUrl: "http://x", fetch });

  const [index, commitNs] = await log.append("hello");
  assert.equal(index, 7);
  assert.equal(commitNs, 12345);

  const head = await log.head();
  assert.equal(head, 7);

  const leaves = await log.loadLeaves({ since: 4, limit: 10 });
  assert.equal(leaves.length, 2);
  assert.equal(leaves[0]?.index, 5);
  assert.equal(new TextDecoder().decode(leaves[0]?.data ?? new Uint8Array()), "hello");
  assert.equal(new TextDecoder().decode(leaves[1]?.data ?? new Uint8Array()), "world");
});

// ---------------------------------------------------------------------------
// AuditClient
// ---------------------------------------------------------------------------

test("AuditClient: count, entries filters, findByRequestId", async () => {
  const queue: MockResponse[] = [
    { body: { entries: 42, chain_valid: true } }, // count
    {
      body: {
        entries: [{ request_id: "r1", action: "query" }],
        next_cursor: null,
        chain_valid: true,
      },
    }, // findByRequestId
  ];
  const { fetch, calls } = mockFetch(queue);
  const audit = new AuditClient({ baseUrl: "http://x", fetch });

  const c = await audit.count();
  assert.equal(c["entries"], 42);

  const row = await audit.findByRequestId("r1");
  assert.notEqual(row, null);
  assert.equal(row?.["action"], "query");
  // findByRequestId should have used request_id + limit=1 in the query string
  assert.ok(calls[1]?.url.includes("request_id=r1"));
  assert.ok(calls[1]?.url.includes("limit=1"));
});

// ---------------------------------------------------------------------------
// BackupClient
// ---------------------------------------------------------------------------

test("BackupClient: create, list, restore, restoreStatus shape mapping", async () => {
  const queue: MockResponse[] = [
    {
      body: {
        snapshot_id: "s1",
        kind: "full",
        written_at_ns: 100,
        size_bytes: 4096,
        sha256: "abc",
        row_count: 50,
        path: "/p",
      },
    }, // create
    { body: { backups: [{ snapshot_id: "s1", kind: "full", size_bytes: 4096 }] } }, // list
    { body: { restore_id: "rst-1" } }, // restore
    { body: { restore_id: "rst-1", snapshot_id: "s1", status: "completed" } }, // restoreStatus
  ];
  const { fetch } = mockFetch(queue);
  const backup = new BackupClient({ baseUrl: "http://x", fetch });

  const ref = await backup.create({ kind: "full" });
  assert.equal(ref.snapshotId, "s1");
  assert.equal(ref.sizeBytes, 4096);

  const list = await backup.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.snapshotId, "s1");

  const restoreId = await backup.restore("s1");
  assert.equal(restoreId, "rst-1");

  const status = await backup.restoreStatus("rst-1");
  assert.equal(status.status, "completed");
});

// ---------------------------------------------------------------------------
// TenantAdminClient
// ---------------------------------------------------------------------------

test("TenantAdminClient: me, create, get, delete, setQuota, createSharing", async () => {
  const queue: MockResponse[] = [
    { body: { tenant_id: "acme" } }, // me
    { body: { tenant_id: "t1", tier: "standard" } }, // create
    { body: { tenant_id: "t1" } }, // get
    { body: { deleted: true } }, // delete
    { body: { quota: 1000 } }, // setQuota
    { body: { partner_tenant: "p1" } }, // createSharing
  ];
  const { fetch, calls } = mockFetch(queue);
  const tenants = new TenantAdminClient({ baseUrl: "http://x", fetch });

  const me = await tenants.me();
  assert.equal(me["tenant_id"], "acme");

  const created = await tenants.create("t1", { tier: "premium" });
  assert.equal(created["tier"], "standard"); // server returns its value
  assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), {
    tenant_id: "t1",
    tier: "premium",
  });

  const got = await tenants.get("t1");
  assert.equal(got["tenant_id"], "t1");
  assert.equal(calls[2]?.url, "http://x/platform/tenants/t1");

  await tenants.delete("t1");
  assert.equal(calls[3]?.method, "DELETE");

  await tenants.setQuota("t1", 1000);
  assert.equal(calls[4]?.method, "PUT");
  assert.deepEqual(JSON.parse(calls[4]?.body ?? "{}"), { quota: 1000 });

  await tenants.createSharing("t1", "p1", { objectType: "Person" });
  assert.deepEqual(JSON.parse(calls[5]?.body ?? "{}"), {
    partner_tenant: "p1",
    object_type: "Person",
    action: "read",
  });
});

// ---------------------------------------------------------------------------
// IdentityClient
// ---------------------------------------------------------------------------

test("IdentityClient: label, registerLookup, eraseSubject", async () => {
  const queue: MockResponse[] = [
    { body: { ok: true } }, // label
    { body: { name: "lk1" } }, // registerLookup
    { body: { receipt: "r1" } }, // eraseSubject
  ];
  const { fetch, calls } = mockFetch(queue);
  const id = new IdentityClient({ baseUrl: "http://x", fetch });

  await id.label("alice@x.com", "primary-email");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    identity: "alice@x.com",
    label: "primary-email",
    confidence: 1.0,
  });

  await id.registerLookup("lk1", "a,b,c", { keyColumn: "k" });
  assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), {
    name: "lk1",
    csv_data: "a,b,c",
    key_column: "k",
  });

  const receipt = await id.eraseSubject("alice@x.com", "gdpr-art-17", {
    purpose: "compliance",
  });
  assert.equal(receipt["receipt"], "r1");
  const body = JSON.parse(calls[2]?.body ?? "{}");
  assert.equal(body["purpose"], "compliance");
  assert.ok(body["sql"].includes("ERASE SUBJECT 'alice@x.com'"));
  assert.ok(body["sql"].includes("CERTIFY"));
});

// ---------------------------------------------------------------------------
// SystemClient
// ---------------------------------------------------------------------------

test("SystemClient: llmConfig, testLlm, jobsStatus", async () => {
  const queue: MockResponse[] = [
    { body: { endpoint: "http://llm" } },
    { body: { ok: true, latency_ms: 12 } },
    { body: { jobs: [{ id: "j1" }] } },
  ];
  const { fetch, calls } = mockFetch(queue);
  const sys = new SystemClient({ baseUrl: "http://x", fetch });

  await sys.llmConfig();
  assert.equal(calls[0]?.url, "http://x/config/llm");

  await sys.testLlm("hello", { model: "gpt-4" });
  assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), {
    prompt: "hello",
    model: "gpt-4",
  });

  await sys.jobsStatus();
  assert.equal(calls[2]?.url, "http://x/jobs");
});

test("SystemClient: jobs and workflow methods (#723)", async () => {
  const queue: MockResponse[] = [
    { body: { name: "c2_beacon_detect", status: "ok" } }, // jobStatus
    { body: { workflows: ["demo_flow"] } }, // listWorkflows
    { body: { name: "demo_flow" } }, // registerWorkflow
    { body: { name: "demo_flow", steps: [] } }, // getWorkflow
    { body: { run_id: "run-1", status: "running" } }, // runWorkflow
    { body: { run_id: "run-1", status: "ok" } }, // workflowStatus
    { body: { run_id: "run-1", attempt_count: 1, last_error: null, steps: [] } }, // workflowRun
  ];
  const { fetch, calls } = mockFetch(queue);
  const sys = new SystemClient({ baseUrl: "http://x", fetch });

  await sys.jobStatus("c2_beacon_detect");
  assert.equal(calls[0]?.url, "http://x/jobs/c2_beacon_detect");

  await sys.listWorkflows();
  assert.equal(calls[1]?.url, "http://x/workflows");

  await sys.registerWorkflow("demo_flow", []);
  assert.equal(calls[2]?.url, "http://x/workflows");
  assert.equal(calls[2]?.method, "POST");

  await sys.getWorkflow("demo_flow");
  assert.equal(calls[3]?.url, "http://x/workflows/demo_flow");

  await sys.runWorkflow("demo_flow");
  assert.equal(calls[4]?.url, "http://x/workflows/demo_flow/run");
  assert.equal(calls[4]?.method, "POST");

  await sys.workflowStatus("demo_flow");
  assert.equal(calls[5]?.url, "http://x/workflows/demo_flow/status");

  const detail = await sys.workflowRun("run-1");
  assert.equal(calls[6]?.url, "http://x/workflows/runs/run-1");
  assert.equal(detail.attempt_count, 1);
  assert.equal(detail.last_error, null);
});

// ---------------------------------------------------------------------------
// IngestClient
// ---------------------------------------------------------------------------

test("IngestClient: bulk NDJSON + bulkCsv + mediaStatus paths", async () => {
  const queue: MockResponse[] = [
    { body: { accepted: 2, rejected: 0 } }, // bulk
    { body: { accepted: 3, rejected: 0 } }, // bulkCsv
    { body: { status: "done" } }, // mediaStatus
  ];
  const { fetch, calls } = mockFetch(queue);
  const ing = new IngestClient({ baseUrl: "http://x", purpose: "p", fetch });

  const bulk = await ing.bulk("Person", [{ id: "1" }, { id: "2" }]);
  assert.equal(bulk["accepted"], 2);
  assert.ok(calls[0]?.url.startsWith("http://x/ingest?"));
  assert.ok(calls[0]?.url.includes("object_type=Person"));
  assert.ok(calls[0]?.url.includes("purpose=p"));
  assert.equal(calls[0]?.headers["content-type"], "application/x-ndjson");
  assert.deepEqual(calls[0]?.body?.split("\n").map((l) => JSON.parse(l)), [
    { id: "1" },
    { id: "2" },
  ]);

  const csv = await ing.bulkCsv("Transaction", "a,b\n1,2");
  assert.equal(csv["accepted"], 3);
  assert.equal(calls[1]?.headers["content-type"], "text/csv");

  const media = await ing.mediaStatus("task-1");
  assert.equal(media["status"], "done");
  assert.equal(calls[2]?.url, "http://x/ingest/media/task-1");
});

// ---------------------------------------------------------------------------
// VectorClient (uses the parent client's query path)
// ---------------------------------------------------------------------------

test("VectorClient: knnSearch emits pgvector cosine SQL via the parent query path", async () => {
  const { fetch, calls } = mockFetch({
    body: {
      data: [{ id: "p1", name: "Alice" }],
      query_id: "q1",
      elapsed_ms: 3,
    },
  });
  const relata = new RelataClient({
    baseUrl: "http://x",
    defaultPurpose: "analytics",
    fetch,
  });
  const vectors = new (await import("./vectors.ts")).VectorClient(relata);
  const rows = await vectors.knnSearch("Person", "_emb", [0.1, 0.2]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.["id"], "p1");
  const body = JSON.parse(calls[0]?.body ?? "{}");
  assert.ok(body["sql"].includes("ORDER BY _emb <=>"));
  assert.ok(body["sql"].includes("[0.1,0.2]"));
  assert.equal(body["purpose"], "analytics");
});

// ---------------------------------------------------------------------------
// S3Client
// ---------------------------------------------------------------------------

test("S3Client: http() PUT/GET against the S3 door", async () => {
  const { fetch, calls } = mockFetch([
    { status: 200, body: "", headers: { etag: '"abc"' } }, // PUT
    { status: 200, body: "PDF-CONTENT" }, // GET
  ]);
  const { S3Client } = await import("./s3.ts");
  const s3 = new S3Client("http://x:9090", { bearerToken: "tok", tenant: "acme", fetch });

  const put = await s3.putObject("bucket", "report.pdf", "data-bytes", {
    contentType: "application/pdf",
  });
  assert.equal(put.status, 200);
  assert.equal(put.headers["etag"], '"abc"');
  assert.equal(calls[0]?.method, "PUT");
  assert.equal(calls[0]?.url, "http://x:9090/bucket/report.pdf");
  assert.equal(calls[0]?.headers["authorization"], "Bearer tok");
  assert.equal(calls[0]?.headers["x-relata-tenant-id"], "acme");
  assert.equal(calls[0]?.headers["content-type"], "application/pdf");

  const got = await s3.getObject("bucket", "report.pdf");
  assert.equal(got.status, 200);
  assert.equal(new TextDecoder().decode(got.body), "PDF-CONTENT");
});

// ---------------------------------------------------------------------------
// StreamingClient (smoke test: NDJSON row stream)
// ---------------------------------------------------------------------------

test("StreamingClient: queryRows yields parsed NDJSON rows", async () => {
  // Build a Response with a ReadableStream body — one NDJSON line per chunk.
  const ndjson = `{"id":"r1"}\n{"id":"r2"}\n{"id":"r3"}\n`;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(ndjson));
      controller.close();
    },
  });
  const fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(stream, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    })) as typeof globalThis.fetch;
  const relata = new RelataClient({
    baseUrl: "http://x",
    defaultPurpose: "analytics",
    fetch,
  });
  const { StreamingClient } = await import("./streaming.ts");
  const streaming = new StreamingClient(relata);
  const rows: Record<string, unknown>[] = [];
  for await (const row of streaming.queryRows("SELECT * FROM Person")) {
    rows.push(row);
  }
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.["id"], "r1");
  assert.equal(rows[2]?.["id"], "r3");
});
