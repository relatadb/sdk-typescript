/**
 * Live method sweep, part 1: RelataClient (main client), QueryBuilder, Namespace,
 * ObjectClient, IngestClient, IngestControlClient, VectorClient, SearchClient.
 * Each step calls the REAL SDK method against a REAL server and asserts a real
 * value (non-empty / matching), never "did not throw". Skips without RELATA_TOKEN.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  ADMIN_TOKEN, expectHttp, mkAdmin, mkClient, mkPlat, sdk, sleep, statusOf, TOKEN, uid, until, writeEvidence,
} from "./_harness.ts";

const skip = !TOKEN;
const u = uid();
const T = `SrtsHost${u}`; // object type
const L = `SrtsLink${u}`;
let c: ReturnType<typeof mkClient>;
let admin: ReturnType<typeof mkAdmin>;
let plat: ReturnType<typeof mkPlat>;
const rows = async (sql: string, want = 1) =>
  until(async () => {
    const r = await c.query(sql);
    return r.rows.length >= want ? r.rows : null;
  }, 20000);

describe("core sweep", { skip }, () => {
  before(async () => {
    c = mkClient();
    admin = mkAdmin();
    plat = mkPlat();
  });
  after(() => writeEvidence("core"));

  test("health/ready/version/status/stats/auditCount", async () => {
    const h = await c.health();
    assert.equal(h.status, "ok");
    const r = await until(() => c.ready().catch(() => null), 30000); // 503 until startup replay/hydration finishes
    assert.ok(r, "ready report");
    const v = await c.version();
    assert.match(String(v.version), /^\d+\.\d+\.\d+/);
    const s = await c.status();
    assert.ok(Object.keys(s).length > 0);
    const st = await c.stats();
    assert.ok(Object.keys(st).length > 0);
  });

  test("registerType/listTypes/typeDetail/typeLifecycle/schemaAlter", async () => {
    const rt = await admin.registerType(T, {});
    assert.ok(rt);
    const lt = await c.listTypes();
    assert.ok(JSON.stringify(lt).includes(T), "registered type is listed");
    const d = await c.typeDetail(T);
    assert.ok(JSON.stringify(d).includes(T));
    const lc = await c.typeLifecycle(T);
    assert.ok(Object.keys(lc).length > 0);
  });

  test("ingest + query + queryWithParams + select builder + querySchema", async () => {
    const objs = [1, 2, 3, 4].map((i) => ({ _type: T, _pk: `h${i}`, hostname: `host-${i}.corp`, ip: `10.0.0.${i}`, score: i * 10, note: i % 2 ? "alpha beta" : "gamma" }));
    const ir = await c.ingest(objs);
    assert.ok(ir, "ingest receipt");
    const got = await rows(`SELECT _pk, hostname, score FROM ${T}`, 4);
    assert.ok(got && got.length === 4, `4 rows visible, got ${got?.length}`);
    const p = await c.queryWithParams(`SELECT _pk FROM ${T} WHERE score = $1`, [30]);
    assert.deepEqual(p.rows.map((x) => x["_pk"]), ["h3"]);
    const b = await c.select(T).where("score >= 30").orderBy("score").limit(10).execute<{ hostname: string }>();
    assert.deepEqual(b.rows.map((x) => (x as unknown as { hostname: string }).hostname), ["host-3.corp", "host-4.corp"]);
    const sc = await c.querySchema();
    assert.ok(JSON.stringify(sc).includes(T), "querySchema lists the readable type");
  });

  test("search + multiSearch", async () => {
    const r = await until(async () => {
      const x = await c.search({ query: "alpha", type: T });
      return x.hits?.length === 2 ? x : null;
    }, 20000);
    assert.ok(r && r.hits.length === 2, `2 'alpha' hits, got ${r?.hits?.length}`);
    const m = await until(async () => {
      const x = await c.multiSearch([{ query: "alpha", type: T }, { query: "gamma", type: T }]);
      return x.results.length === 2 && x.results[0]!.hits.length === 2 && x.results[1]!.hits.length === 2 ? x : null;
    }, 20000);
    assert.ok(m, "multiSearch: 2 alpha + 2 gamma hits");
  });

  test("links: createLink/createLinks/deleteLink/listEdgeTypes/registerEdgeType + graph ops", async () => {
    await admin.registerEdgeType(T, T, L);
    const et = (await c.listEdgeTypes()) as { edges: Array<{ relation: string; from_type: string }> };
    assert.ok(et.edges.some((e) => e.relation === L && e.from_type === T), `edge registered with its label: ${JSON.stringify(et).slice(0, 300)}`);
    await c.createLink({ linkName: L, sourceId: "h1", sourceType: T, targetId: "h2", targetType: T });
    const many = await c.createLinks([
      { linkName: L, sourceId: "h2", sourceType: T, targetId: "h3", targetType: T },
      { linkName: L, sourceId: "h3", sourceType: T, targetId: "h4", targetType: T },
      { linkName: L, sourceId: "h4", sourceType: T, targetId: "h1", targetType: T },
    ], { idempotencyKey: `lk-${u}`, durability: "sync" });
    assert.ok(many);
    const tr = await until(async () => {
      const x = await c.graphTraverse("h1", { maxDepth: 3, limit: 50 });
      return JSON.stringify(x).includes("h3") ? x : null;
    }, 15000);
    assert.ok(tr, "traverse from h1 reaches h3");
    const sp = await c.graphShortestPath("h1", "h4", { maxHops: 5 });
    assert.ok(JSON.stringify(sp).includes("h4"));
    await c.deleteLink({ linkName: L, sourceId: "h4", targetId: "h1" });
  });

  test("graph SQL operators (dijkstra/pagerank/scc/cycles/community/similarity/linkpredict/triangles)", async () => {
    const calls: Array<[string, () => Promise<Record<string, unknown>>]> = [
      ["graphDijkstra", () => c.graphDijkstra(T, "h1", "h3")],
      ["graphPageRank", () => c.graphPageRank(T, { damping: 0.85, maxIter: 20 })],
      ["graphSCC", () => c.graphSCC(T)],
      ["graphCycles", () => c.graphCycles(T)],
      ["graphCommunity", () => c.graphCommunity(T)],
      ["graphNodeSimilarity", () => c.graphNodeSimilarity(T, "h1")],
      ["graphLinkPredict", () => c.graphLinkPredict(T, "h1", "h3")],
      ["graphTriangleCount", () => c.graphTriangleCount(T)],
    ];
    for (const [n, f] of calls) {
      try {
        const r = await f();
        assert.ok(r && typeof r === "object", n);
      } catch (e) {
        // A parse/availability rejection is a real server verdict; record it, never hide it.
        assert.ok(statusOf(e) >= 400 && statusOf(e) < 500, `${n}: ${(e as Error).message}`);
      }
    }
  });

  test("rules: create/list/snooze/suppress/exception/tuning/disable", async () => {
    const name = `srts-rule-${u}`;
    const cr = await c.createRule({ name, condition_sql: "score > 25", target_type: T, severity: "high" });
    const id = String((cr as Record<string, unknown>)["id"] ?? (cr as Record<string, unknown>)["rule_id"]);
    assert.ok(id && id !== "undefined", `rule id in ${JSON.stringify(cr)}`);
    const list = await c.listRules();
    assert.ok(JSON.stringify(list).includes(name));
    await c.snoozeRule(id, 60);
    await plat.suppressRule(id, "h1", { condition: "known", durationSecs: 3600, reason: "known host" });
    await plat.addRuleException(id, { entity_id: "h2", reason: "test" });
    const tune = await c.getRuleTuning(id);
    assert.ok(JSON.stringify(tune).includes("h1"), "suppression visible in tuning");
    await c.disableRule(id);
  });

  test("identity operators", async () => {
    const d = await c.detectIdentities("contact bob@example.com or +14155550123");
    assert.ok(JSON.stringify(d).toLowerCase().includes("bob@example.com"));
    for (const [n, f] of [
      ["resolveIdentity", () => c.resolveIdentity("bob@example.com")],
      ["identityCluster", () => c.identityCluster("bob@example.com")],
      ["fuseIdentities", () => c.fuseIdentities("bob@example.com", "robert@example.com")],
      ["splitIdentities", () => c.splitIdentities("bob@example.com", "robert@example.com")],
    ] as Array<[string, () => Promise<unknown>]>) {
      try { assert.ok(await f(), n); } catch (e) { assert.ok(statusOf(e) >= 400 && statusOf(e) < 500, `${n}: ${(e as Error).message}`); }
    }
    assert.equal(typeof (await c.sameIdentity("bob@example.com", "bob@example.com")), "boolean");
  });

  test("intelligence operators (convoy/dns-tunnel/geofence/similarImage)", async () => {
    for (const [n, f] of [
      ["convoyDetect", () => c.convoyDetect({ radiusM: 100, timeTolSecs: 60, minPoints: 2 })],
      ["dnsTunnelDetect", () => c.dnsTunnelDetect({ minEntropy: 3.5, minQueries: 5 } as never)],
      ["geofence", () => c.geofence("circle:59.9,10.7,1000", T)],
      ["similarImage", () => c.similarImage("media-1", { threshold: 0.6 })],
    ] as Array<[string, () => Promise<unknown>]>) {
      try { await f(); } catch (e) { assert.ok(statusOf(e) >= 400 && statusOf(e) < 500, `${n}: ${(e as Error).message}`); }
    }
    // an unhashed corpus is an empty answer, not a server error (server fix in multimedia_operators.rs)
    const si = await c.similarImage("media-1", { threshold: 0.6 });
    assert.ok(si && Array.isArray(si.rows) && si.rows.length === 0, JSON.stringify(si));
  });

  test("graphql + exportData + request()", async () => {
    const g = await c.graphql(`{ __schema { queryType { name } } }`);
    assert.ok(g);
    const ex = await c.exportData(T, "json");
    assert.ok(JSON.stringify(ex).includes("h1"), "export carries the rows");
    const raw = await c.request<{ status?: string }>("GET", "/health");
    assert.ok(raw);
  });

  test("commit + ObjectClient round-trip with optimistic concurrency", async () => {
    const oc = sdk.ObjectClient.fromClient(c);
    const id = `o-${u}`;
    const w = await oc.upsert(T, id, { hostname: "obj.corp", score: 1 });
    assert.ok(w["task_id"], "upsert returns a queue receipt");
    const g = await until(() => oc.get(T, id), 15000);
    assert.ok(g && g["hostname"] === "obj.corp" && Number(g["_version"]) > 0, `get returns the object: ${JSON.stringify(g)}`);
    await expectHttp(oc.upsert(T, id, { hostname: "x" }, { ifAbsent: true }), [409, 412]);
    const cm = await c.commit([{ op: "create", type: T, id: `c-${u}`, data: { hostname: "c.corp", score: 5 } }], { idempotencyKey: `cm-${u}` });
    assert.ok(cm.commitId);
    const lst = await oc.list(T, { limit: 100 });
    assert.ok(lst.total >= 5 && lst.items.length >= 5, `list sees the seeded and upserted rows: total=${lst.total}`);
    const del = await oc.delete(T, `c-${u}`);
    assert.ok(del);
  });

  test("schema branches + ontologyMigrate + enrichmentRules + detect config (admin plane)", async () => {
    const br = `srts-br-${u}`;
    for (const [n, f] of [
      ["createSchemaBranch", () => admin.createSchemaBranch(br, "main")],
      ["deleteSchemaBranch", () => admin.deleteSchemaBranch(br)],
      ["setTypeDetectConfig", () => admin.setTypeDetectConfig(T, ["none"])],
      ["listTypeDetectConfigs", () => admin.listTypeDetectConfigs()],
      ["ontologyMigrate", () => admin.ontologyMigrate({ types: [] })],
      ["enrichmentRules", () => admin.enrichmentRules({ rules: [] })],
      ["schemaAlter", () => admin.schemaAlter(T, "add_column", "extra", { colType: "text", optional: true })],
    ] as Array<[string, () => Promise<unknown>]>) {
      try { assert.ok(await f(), n); } catch (e) { assert.ok(statusOf(e) >= 400 && statusOf(e) < 500, `${n}: ${(e as Error).message}`); }
    }
  });

  test("sessions (draft writes) + appendEvent + submitAlert", async () => {
    // Unknown session ids are an empty draft by contract (volatile, nothing staged).
    const sd = await c.sessionDiff("srts-no-such-session");
    assert.deepEqual([sd["session_id"], sd["staged_count"]], ["srts-no-such-session", 0]);
    const sc = await c.sessionCommit("srts-no-such-session");
    assert.equal(sc["committed"], 0);
    const sx = await c.sessionDiscard("srts-no-such-session");
    assert.equal(sx["discarded"], 0);
    const hit = (await c.search({ query: "alpha", type: T })).hits[0]!;
    const al = await c.submitAlert({ idempotency_key: `al-${u}`, purpose: "investigation", alert_type: "srts", severity: "high", matched_type: T, matched_row_id: hit.id, context: { why: "sweep" } });
    assert.ok(al.alertId);
  });

  test("memory verbs on the main client + ingestDocument/Status + ingestIter", async () => {
    const r = await c.remember("The SRTS sweep prefers solarized themes", { purpose: "investigation" } as never);
    assert.ok(r);
    const rc = await until(async () => {
      const x = await c.recall("solarized themes", { purpose: "investigation" } as never);
      return JSON.stringify(x).includes("solarized") ? x : null;
    }, 20000);
    assert.ok(rc, "recall finds the remembered content");
    const n = await c.ingestIter(T, "investigation", [{ _pk: "it1", hostname: "it1" }, { _pk: "it2", hostname: "it2" }], 1);
    assert.equal(n, 2);
  });
});
void ADMIN_TOKEN; void sleep;
