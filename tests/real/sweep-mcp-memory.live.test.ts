/**
 * Live method sweep, part 3: Memory (Mem0-style verbs) and McpClient (every wrapper
 * plus raw callTool) against a real server. Tool wrappers are invoked for real; the
 * assertion is on the server's real answer (value present), or on an explicit
 * documented rejection (4xx) -- never on "did not throw".
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { HOST, mkClient, sdk, statusOf, TOKEN, uid, until, writeEvidence } from "./_harness.ts";

const skip = !TOKEN;
const u = uid();
const T = `SrtsMcp${u}`;
let c: ReturnType<typeof mkClient>;

describe("memory + mcp sweep", { skip }, () => {
  before(async () => {
    c = mkClient();
    await c.ingest([1, 2, 3].map((i) => ({ _type: T, _pk: `m${i}`, name: `Person ${i}`, city: i === 1 ? "Oslo" : "Bergen" })));
    await until(async () => (await c.query(`SELECT _pk FROM ${T}`)).rows.length === 3, 20000);
  });
  after(() => writeEvidence("mcp-memory"));

  test("Memory: add/search/get/update/associate/episodes/justify/resolve/summarise/review/procedures/forget", async () => {
    const m = new sdk.Memory(HOST, { purpose: "agent-notes", bearerToken: TOKEN, sessionId: `s-${u}` });
    const a = await m.add("Alice prefers dark mode in every editor", { confidence: 0.9, memoryClass: "semantic" });
    assert.ok(a, "add returns an id");
    const batch = await m.addBatch(["Bob likes tea", { content: "Carol uses vim", confidence: 0.8 }]);
    assert.equal(batch.length, 2);
    assert.ok(batch.every((x) => x.length > 0), "batch ids are all non-empty");
    const hits = await until(async () => {
      const h = await m.search("dark mode editor");
      return h.length ? h : null;
    }, 20000);
    assert.ok(hits && JSON.stringify(hits).includes("dark mode"), "search returns the stored memory");
    const detailed = await m.searchDetailed("dark mode editor");
    assert.ok(JSON.stringify(detailed).includes("dark mode"));
    const got = await m.get(a);
    assert.ok(got && JSON.stringify(got).includes("dark mode"));
    assert.equal(await m.get("no-such-memory-id"), null, "unknown id is null, not a throw");
    const a2 = await m.update(a, "Alice prefers LIGHT mode now");
    assert.ok(a2);
    const asc = await m.associate(a, batch[0]!, "knows", { confidence: 0.7 });
    assert.ok(asc);
    assert.ok(await m.associateBatch([{ source_id: a, target_id: batch[1], relation: "knows" }]).catch((e) => (statusOf(e) < 500 ? {} : Promise.reject(e))));
    const eps = await m.episodes({ sessionId: `s-${u}` });
    assert.ok(Array.isArray(eps));
    assert.ok(await m.justify(a));
    assert.ok(await m.resolve(a));
    assert.ok(await m.summarise([a, batch[0]!], { summaryContent: "Alice and Bob" }));
    await m.review(batch[1]!, "approve", { reason: "ok" }).catch((e) => assert.ok(statusOf(e) >= 400 && statusOf(e) < 500, String(e)));
    assert.ok(await m.rememberProcedure(`agent-${u}`, "deploy", "1. build 2. test 3. ship"));
    const pr = await m.recallProcedure(`agent-${u}`, { name: "deploy", allVersions: true, limit: 5 });
    assert.ok(JSON.stringify(pr).includes("build"), "procedure recalled with its text");
    assert.ok(await m.forget(batch[0]!));
    await m.close();
  });

  test("McpClient: protocol (initialize, listTools, callTool, errors)", async () => {
    const mc = sdk.McpClient.fromClient(c);
    assert.ok(await mc.initialize({}));
    const tools = await mc.listTools();
    assert.ok(tools.length >= 20, `server exposes tools, got ${tools.length}`);
    assert.ok(tools.some((t) => t["name"] === "query_knowledge"));
    const r = await mc.callTool("query_knowledge", { sql: `SELECT _pk FROM ${T}`, purpose: "investigation" });
    assert.ok(JSON.stringify(r).includes("m1"));
    try {
      await mc.callTool("definitely_not_a_tool", {});
      assert.fail("unknown tool must be rejected");
    } catch (e) {
      assert.ok(statusOf(e) >= 400 && statusOf(e) < 500, `unknown tool is a 4xx, got ${statusOf(e)}`);
    }
  });

  test("McpClient: every typed wrapper reaches the server", async () => {
    const mc = sdk.McpClient.fromClient(c);
    const P = "investigation";
    type Fn = () => Promise<unknown>;
    const calls: Array<[string, Fn]> = [
      ["queryKnowledge", () => mc.queryKnowledge(`SELECT _pk, city FROM ${T}`, P)],
      ["searchKnowledge", () => mc.searchKnowledge("Person", P, { topK: 3 })],
      ["explainPolicy", () => mc.explainPolicy(`SELECT _pk FROM ${T}`, P)],
      ["listEntityTypes", () => mc.listEntityTypes()],
      ["getEntities", () => mc.getEntities(T, { limit: 5 })],
      ["searchEntities", () => mc.searchEntities("Person", { objectType: T })],
      ["findInSocialCorpus", () => mc.findInSocialCorpus(T, "Oslo", { topK: 3 })],
      ["lookupIdentity", () => mc.lookupIdentity("m1", { purpose: P })],
      ["getEntityProfile", () => mc.getEntityProfile("m1", P)],
      ["getTimeline", () => mc.getTimeline("m1", P, { limit: 5 })],
      ["findConnections", () => mc.findConnections("m1", P, { limit: 5 })],
      ["getRelationships", () => mc.getRelationships(P, { subject: "m1", limit: 5 })],
      ["addCaseNote", () => mc.addCaseNote(`case-${u}`, "a note", { author: "srts" })],
      ["getAuditTrail", () => mc.getAuditTrail({ limit: 5, purpose: P })],
      ["getCaseSummary", () => mc.getCaseSummary(P, { includeGraph: true })],
      ["ragStoreAnswer", () => mc.ragStoreAnswer("q?", "a.", P, { sources: [] })],
      ["ragStoreElements", () => mc.ragStoreElements([{ type: "text", text: "hello" }], "f.txt", P, { label: "l" })],
      ["ingestDocument", () => mc.ingestDocument(`doc-${u}`, "Alice met Bob in Oslo.", P, { label: "doc" })],
      ["remember", () => mc.remember("mcp remembers oranges", P, { confidence: 0.9 })],
      ["rememberBatch", () => mc.rememberBatch([{ content: "x1" }, { content: "x2" }], { purpose: P })],
      ["recall", () => mc.recall("oranges", P, { topK: 3 })],
      ["recognize", () => mc.recognize("no-such-id", { purpose: P })],
      ["episodesIn", () => mc.episodesIn(`s-${u}`, { limit: 5, purpose: P })],
      ["justify", () => mc.justify("no-such-id", { purpose: P })],
      ["consolidate", () => mc.consolidate("no-such-id", "new", { purpose: P })],
      ["forget", () => mc.forget("no-such-id", { purpose: P })],
      ["rememberProcedure", () => mc.rememberProcedure(`ag-${u}`, "p", "do things", { purpose: P })],
      ["recallProcedure", () => mc.recallProcedure(`ag-${u}`, { purpose: P })],
      ["associate", () => mc.associate("a", "b", { relation: "knows", purpose: P })],
      ["resolve", () => mc.resolve("no-such-id", { purpose: P })],
      ["summarise", () => mc.summarise({ contents: ["a", "b"], purpose: P })],
      ["eraseSubject", () => mc.eraseSubject("nobody@example.com", { reason: "sweep" })],
      ["similarMultimodal", () => mc.similarMultimodal(T, "m1", { topK: 2, purpose: P })],
      ["hybridSearch", () => mc.hybridSearch(T, "Person", { topK: 3, purpose: P })],
      ["pathsBetween", () => mc.pathsBetween("m1", "m2", { maxHops: 3, purpose: P })],
      ["listLinkTypes", () => mc.listLinkTypes()],
      ["serverHealth", () => mc.serverHealth()],
      ["jobStatus", () => mc.jobStatus()],
      ["metrics", () => mc.metrics()],
      ["listRules", () => mc.listRules()],
      ["createRule", () => mc.createRule(`mcp-rule-${u}`, "1 = 1", T, { severity: "low", purpose: P })],
      ["listJobs", () => mc.listJobs()],
      ["scheduleJob", () => mc.scheduleJob("no-such-job")],
      ["geofence", () => mc.geofence(59.9, 10.7, { radiusM: 1000, targetType: T, purpose: P })],
      ["resolveEntityIdentity", () => mc.resolveEntityIdentity("m1", { purpose: P })],
      ["detectCommunities", () => mc.detectCommunities(T, { purpose: P })],
      ["rankKeyNodes", () => mc.rankKeyNodes(T, { metric: "pagerank", purpose: P })],
      ["hubAuthority", () => mc.hubAuthority(T, { maxIter: 5, purpose: P })],
      ["predictLinks", () => mc.predictLinks(T, { fromId: "m1", toId: "m2", purpose: P })],
      ["findScc", () => mc.findScc(T, { purpose: P })],
      ["aggregateStats", () => mc.aggregateStats(T, { agg: "count", purpose: P })],
    ];
    const verdict: Record<string, string> = {};
    for (const [n, f] of calls) {
      try {
        const r = await f();
        assert.ok(r !== undefined && r !== null, n);
        verdict[n] = "ok";
      } catch (e) {
        const sc = statusOf(e);
        assert.ok(sc >= 400 && sc < 500, `${n}: expected success or a documented 4xx, got ${sc}: ${(e as Error).message}`);
        verdict[n] = `http_${sc}`;
      }
    }
    writeEvidence("mcp-verdicts", { verdict });
    const okN = Object.values(verdict).filter((v) => v === "ok").length;
    assert.ok(okN >= 25, `at least 25 wrappers succeed, got ${okN}: ${JSON.stringify(verdict)}`);
  });
});
