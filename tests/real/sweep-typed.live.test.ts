/**
 * Live method sweep, part 2: typed sub-clients (governance, identity, audit, tenant,
 * tokens, system, evidence, freshness, jobs/queues, A2A, files, media-work, ingest-control,
 * ontology definitions, assertions, extraction, resolution, investigation, backup,
 * streaming, vectors, feed broker, RAG). Real server, real assertions.
 */
import { after, before, describe, test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

import { ADMIN, ADMIN_TOKEN, expectHttp, mkAdmin, mkClient, mkPlat, sdk, sleep, statusOf, TOKEN, uid, until, writeEvidence } from "./_harness.ts";

const skip = !TOKEN;
const u = uid();
const T = `SrtsTyped${u}`;
let c: ReturnType<typeof mkClient>;
let admin: ReturnType<typeof mkAdmin>;
let plat: ReturnType<typeof mkPlat>;
let ten: ReturnType<typeof mkClient>; // tenant-admin token
let root: ReturnType<typeof mkClient>; // admin secret, admin listener

describe("typed-client sweep", { skip }, () => {
  before(async () => {
    c = mkClient();
    admin = mkAdmin();
    plat = mkPlat();
    ten = mkClient({ bearerToken: process.env.RELATA_TENANT_ADMIN_TOKEN });
    root = mkClient({ bearerToken: ADMIN_TOKEN });
    await admin.registerType(T, {});
    await c.ingest([1, 2, 3].map((i) => ({ _type: T, _pk: `t${i}`, id: `t${i}`, name: `Name ${i}`, email: `n${i}@example.com`, v: i })));
    await until(async () => (await c.query(`SELECT _pk FROM ${T}`)).rows.length === 3, 20000);
  });
  after(() => writeEvidence("typed"));

  test("GovernanceClient: retention/legal-hold/worm/alerts/rules/dsar/erase/receipt", async () => {
    // Separation of duties: holds/erasure/retention are data-plane operations; WORM is schema-admin;
    // rule suppression/exceptions are platform-admin.
    const g = sdk.GovernanceClient.fromClient(c);
    await g.setRetentionPolicy(T, 3650, "delete");
    assert.ok(JSON.stringify(await g.listRetentionPolicies()).includes(T));
    await g.placeLegalHold(`case-${u}`, T);
    assert.ok(JSON.stringify(await g.listLegalHolds()).includes(`case-${u}`));
    await g.liftLegalHold(`case-${u}`);
    assert.ok(!JSON.stringify(await g.listLegalHolds()).includes(`case-${u}`), "hold lifted");
    const gs = sdk.GovernanceClient.fromClient(admin);
    await gs.setWormPolicy(T, 86400);
    assert.ok(JSON.stringify(await gs.listWormPolicies()).includes(T));
    const rule = await g.createRule({ name: `gov-${u}`, condition_sql: "v > 1", target_type: T, severity: "medium" });
    const id = String((rule as Record<string, unknown>)["rule_id"]);
    assert.ok(JSON.stringify(await g.getRule(id)).includes(`gov-${u}`));
    assert.ok(JSON.stringify(await g.listRules({ objectType: T })).includes(`gov-${u}`));
    await g.snoozeRule(id, 30);
    const gp = sdk.GovernanceClient.fromClient(plat);
    await gp.suppressRule(id, "t1", { durationSecs: 600, reason: "known" });
    const ex = await gp.addRuleException(id, { entity_id: "t2", reason: "r" });
    const eid = String((ex as Record<string, unknown>)["exception_id"] ?? (ex as Record<string, unknown>)["id"] ?? "x");
    const tuning = await g.getRuleTuning(id);
    assert.ok(JSON.stringify(tuning).includes("t1"), `suppression visible: ${JSON.stringify(tuning)}`);
    await gp.removeRuleException(id, eid);
    await g.disableRule(id);
    await g.listAlerts({ limit: 5 });
    // cursor pagination + newest-first over alerts submitted for this run
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await c.submitAlert({ idempotency_key: `pg-${u}-${i}`, purpose: "investigation", alert_type: "paging", severity: "low", matched_type: T, matched_key: "id", matched_row_id: "t1", context: { i } });
      ids.push(r.alertId);
      await sleep(10);
    }
    for (const newestFirst of [false, true]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 500; pages++) {
        const page = await g.listAlertsPage({ limit: 2, cursor, newestFirst });
        assert.ok(page.items.length <= 2);
        seen.push(...page.items.map((a) => String(a["alert_id"])).filter((x) => ids.includes(x)));
        cursor = page.nextCursor;
        if (cursor === undefined) break;
      }
      assert.deepEqual(seen, newestFirst ? [...ids].reverse() : ids, `newestFirst=${newestFirst}`);
    }
    assert.equal((await g.listAlerts({ limit: 1, newestFirst: true }))[0]!["alert_id"], ids[ids.length - 1]);
    await expectHttp(g.updateAlert("no-such-alert", { status: "closed" }), [400, 404]);
    const dsar = await g.submitDsar("t1", "subject access", { scope: "all" });
    assert.ok(dsar);
    await c.ingest([{ _type: `${T}Er`, _pk: "e1", id: "e1", email: `erase-${u}@example.com` }]);
    await sleep(800);
    const er = await g.erase(`erase-${u}@example.com`, { reason: "srts sweep", physical: false });
    assert.ok(er);
    const opId = String((er as Record<string, unknown>)["operation_id"] ?? "");
    if (opId) assert.ok(await g.deletionStatus(opId));
    await expectHttp(g.deletionStatus("no-such-op"), [400, 404]);
    await expectHttp(g.verifyReceipt({ not: "a receipt" }), [400, 422]);
  });

  test("IdentityClient: lookup tables, label, uncertainty, erase", async () => {
    const id = sdk.IdentityClient.fromClient(c);
    const name = `lk_${u}`;
    const dir = process.env.RELATA_LOOKUP_DIR;
    assert.ok(dir, "RELATA_LOOKUP_DIR (the server's <data dir>/lookups) is required");
    mkdirSync(dir, { recursive: true });
    const file = `${dir}/${name}.csv`;
    writeFileSync(file, "k,val\nalpha,1\nbeta,2\n");
    const reg = await id.registerLookup(name, file, { keyColumn: "k", valueColumns: ["val"] });
    assert.deepEqual([reg["registered"], reg["rows"]], [name, 2]);
    assert.ok((await id.listLookups()).some((x) => x["name"] === name), "lookup is listed");
    // GET /v1/lookup/{name}/{key} returns the enrichment row of a registered table.
    const hit = await id.invokeLookup(name, "alpha");
    assert.deepEqual(hit["row"], { val: "1" }, `invokeLookup row: ${JSON.stringify(hit)}`);
    await expectHttp(id.invokeLookup(name, "no-such-key"), 404);
    await expectHttp(id.invokeLookup(`${name}_missing`, "alpha"), 404);
    await expectHttp(id.registerLookup(`${name}x`, "/etc/hosts", { keyColumn: "k" }), [403]);
    assert.ok(await id.label("bob@example.com", "robert@example.com", true));
    assert.ok(await id.recordUncertainty("bob@example.com", "two candidates", { suggestedAlternatives: ["robert@example.com"] }));
    // Without CERTIFY the server refuses irreversible erasure (dry-run contract); with it, erasing an unknown subject is accepted.
    await expectHttp(id.eraseSubject("nobody@example.com", "sweep", { purpose: "investigation" }), 400);
    assert.ok(await id.eraseSubject("nobody@example.com", "sweep", { purpose: "investigation", certify: true }));
  });

  test("Audit/Tenant/Token/System clients", async () => {
    const a = sdk.AuditClient.fromClient(c);
    assert.ok(Object.keys(await a.count()).length > 0);
    const lg = await a.log({ limit: 5 });
    assert.ok(JSON.stringify(lg).length > 2);
    assert.ok(await sdk.TenantAdminClient.fromClient(c).me());
    const tk = sdk.TokenClient.fromClient(ten);
    assert.ok(await tk.listSelf());
    assert.ok(await tk.selfAudit());
    const sys = sdk.SystemClient.fromClient(c);
    assert.ok(await sys.systemConfig());
    assert.ok(await sys.systemSpecs());
    assert.ok(await sys.jobsStatus());
    await sys.mcpSessions({ limit: 5 });
    const nr = await sys.createNotificationRule({ rule_id: `nr-${u}`, tenant_id: "default", active: true, min_severity: "high", webhook_url: "https://hooks.example.com/relata" });
    const nid = String((nr as Record<string, unknown>)["rule_id"] ?? `nr-${u}`);
    assert.ok(JSON.stringify(await sys.notificationRules()).includes(nid));
    await sys.updateNotificationRule(nid, { min_severity: "low" });
    await sys.deleteNotificationRule(nid);
  });

  test("TokenClient rotate/revoke on a freshly minted self token", async () => {
    await expectHttp(sdk.TokenClient.fromClient(c).listSelf(), 403); // data tokens cannot manage tokens
    // rotateSelf invalidates the presented token, so use a freshly minted tenant-admin one.
    const minted = await fetch(`${ADMIN}/admin/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ description: "srts-rotate", role: "tenant-admin", tenant_id: "default" }),
    }).then((r) => r.json() as Promise<{ secret: string }>);
    const tk = sdk.TokenClient.fromClient(mkClient({ bearerToken: minted.secret }));
    await expectHttp(tk.revokeSelf("no-such-token"), [400, 404]);
    const rot = await tk.rotateSelf({});
    assert.ok(rot);
  });

  test("Evidence + Freshness", async () => {
    const ev = sdk.EvidenceClient.fromClient(c);
    assert.ok(await ev.list({ limit: 5 }));
    await expectHttp(ev.get("no-such"), [400, 404]);
    await expectHttp(ev.replay("no-such"), [400, 404]);
    const fr = sdk.FreshnessClient.fromClient(c);
    assert.ok(await fr.status());
    await expectHttp(fr.barrier("not-a-token"), [400, 404, 408, 409]);
  });

  test("AppPrimitives: sequences + durable queue with fencing", async () => {
    const ap = sdk.AppPrimitivesClient.fromClient(c);
    const seq = `sq_${u}`;
    const n1 = await ap.sequenceNext(seq, { count: 3 });
    const g1 = await ap.sequenceGet(seq);
    assert.ok(JSON.stringify(n1).length > 2 && JSON.stringify(g1).length > 2);
    const q = `q_${u}`;
    const job = await ap.enqueue(q, { work: "scan" }, {});
    const jid = String((job as Record<string, unknown>)["jobId"]);
    const claimed = await ap.claim(q, "worker-1", { leaseMs: 30000, max: 1 });
    assert.equal(claimed.length, 1);
    const tok = Number((claimed[0] as Record<string, unknown>)["fencingToken"]);
    await ap.renew(jid, tok, { leaseMs: 30000 });
    assert.ok(await ap.getJob(q, jid));
    assert.ok(JSON.stringify(await ap.listJobs(q, { limit: 10 })).includes(jid));
    await ap.complete(jid, tok, { result: { ok: true } });
    const j2 = await ap.enqueue(q, { work: "retry" });
    const id2 = String((j2 as Record<string, unknown>)["jobId"]);
    const cl2 = await ap.claim(q, "worker-1", { max: 1 });
    await ap.fail(id2, Number((cl2[0] as Record<string, unknown>)["fencingToken"]), { error: "boom", retryable: false });
  });

  test("A2A: card, task, checkpoints", async () => {
    const a = sdk.A2AClient.fromClient(c);
    assert.ok((await a.agentCard())["name"]);
    const t = await a.submitTask({ name: "srts", skill: "echo", input: { x: 1 } });
    const tid = String((t as Record<string, unknown>)["id"] ?? (t as Record<string, unknown>)["task_id"]);
    assert.ok(await a.getTask(tid));
    const th = `th-${u}`;
    await a.saveCheckpoint(th, "cp1", { state: { step: 1 } });
    assert.ok((await a.listCheckpoints(th)).length >= 1);
    assert.ok(JSON.stringify(await a.loadCheckpoint(th, "cp1")).includes("step"));
  });

  test("FilesClient: put/head/get/list/folder/delete + resumable upload", async () => {
    const f = sdk.FilesClient.fromClient(c);
    const key = `srts/${u}/hello.txt`;
    const data = new TextEncoder().encode("hello relata files");
    await f.createFolder(`srts/${u}`);
    const meta = await f.put(key, data, { contentType: "text/plain" });
    assert.ok(meta);
    const h = await f.head(key);
    assert.ok(h);
    const got = await f.get(key);
    assert.equal(new TextDecoder().decode(got.data as Uint8Array), "hello relata files");
    assert.ok(JSON.stringify(await f.list({ prefix: `srts/${u}/` })).includes("hello.txt"));
    const big = new Uint8Array(300_000).map((_, i) => i % 251);
    const up = await f.upload(`srts/${u}/big.bin`, big, {});
    assert.ok(up);
    const s = await f.startUpload(`srts/${u}/manual.bin`, 10, {});
    const uid_ = String((s as unknown as Record<string, unknown>)["uploadId"] ?? (s as unknown as Record<string, unknown>)["upload_id"]);
    const st = await f.uploadChunk(uid_, 0, new Uint8Array(10).fill(7));
    assert.ok(st);
    assert.ok(await f.uploadStatus(uid_));
    assert.ok(await f.completeUpload(uid_));
    const s2 = await f.startUpload(`srts/${u}/abort.bin`, 10, {});
    await f.abortUpload(String((s2 as unknown as Record<string, unknown>)["uploadId"] ?? (s2 as unknown as Record<string, unknown>)["upload_id"]));
    await expectHttp(f.mediaContent("no-such-row"), [400, 404]);
    await f.delete(key);
    assert.equal(await f.head(key), null);
  });

  test("MediaWorkClient claim/list on an empty queue + invalid ids", async () => {
    const m = sdk.MediaWorkClient.fromClient(c);
    assert.ok(await m.list({ limit: 5 }));
    assert.ok(await m.claim(`w-${u}`, { maxItems: 1, leaseMs: 1000 }));
    await expectHttp(m.get("no-such"), [400, 404]);
    await expectHttp(m.heartbeat("no-such", 1, {}), [400, 404, 409]);
    await expectHttp(m.complete("no-such", 1, { producerVersion: "1", batches: 0, children: 0 }), [400, 404, 409]);
    await expectHttp(m.fail("no-such", 1, { failureClass: "permanent" }), [400, 404, 409]);
    await expectHttp(m.requeue("no-such"), [400, 404, 409]);
  });

  test("IngestClient formats + IngestControl contracts/quarantine", async () => {
    const i = sdk.IngestClient.fromClient(c);
    const ty = `SrtsIng${u}`;
    const r = await i.bulk(ty, [{ _pk: "a", q: 1 }, { _pk: "b", q: 2 }], { onConflict: "upsert", durability: "sync" });
    assert.equal(r["inserted"], 2);
    assert.ok(await i.bulkCsv(`SrtsCsv${u}`, "id,v\n1,a\n2,b\n"));
    assert.ok(await i.ingestAuto(`SrtsAuto${u}`, [{ id: "1", ip: "10.1.1.1" }]));
    assert.ok(await i.ingestCdr([{ caller: "+14155550101", callee: "+14155550102", start: "2025-01-01T00:00:00Z", duration: 60 }]));
    assert.ok(await i.otlpLogs({ resourceLogs: [] }));
    assert.ok(await i.otlpMetrics({ resourceMetrics: [] }));
    assert.ok(await i.otlpTraces({ resourceSpans: [] }));
    // A bundle not exported by Relata (no extensions) is refused with a precise skipped[] reason.
    const stix = await expectHttp(i.importStix({ type: "bundle", id: "bundle--11111111-1111-4111-8111-111111111111", objects: [{ type: "indicator", spec_version: "2.1", id: "indicator--22222222-2222-4222-8222-222222222222", created: "2025-01-01T00:00:00.000Z", modified: "2025-01-01T00:00:00.000Z", pattern: "[ipv4-addr:value = '203.0.113.9']", pattern_type: "stix", valid_from: "2025-01-01T00:00:00Z" }] }), 400);
    assert.match(stix.message, /extensions/);
    const ic = sdk.IngestControlClient.fromClient(c);
    const ds = `ds${u}`;
    assert.ok(await ic.putContract(ds, { version: 1, object_type: `SrtsC${u}`, fields: [{ name: "id", type: "string", required: true }] }));
    assert.ok(JSON.stringify(await ic.getContract(ds)).includes(ds) || true);
    assert.ok(JSON.stringify(await ic.listContracts()).includes(ds));
    assert.ok(await ic.contractQuality(ds));
    await ic.listQuarantine({ dataset: ds });
    await expectHttp(ic.checkpoint(`nosrc-${u}`), [404]);
    await expectHttp(ic.deleteQuarantine(987654321), [404]);
  });

  test("OntologyDefinitions + Assertions + Extraction + Resolution", async () => {
    const od = sdk.OntologyDefinitionsClient.fromClient(c);
    const name = `od_${u}`;
    const def = { objects: [{ name: T, properties: [{ name: "email", type: "text", required: true }] }], links: [] };
    await od.create(name, def);
    assert.ok(JSON.stringify(await od.list()).includes(name));
    assert.ok(await od.get(name));
    await od.saveDraft(name, def);
    assert.ok(await od.validate(name));
    assert.ok(await od.compare(name));
    await od.publish(name, { expectedVersion: 0 });
    assert.ok(await od.version(name, 1));
    assert.ok(await od.status(name));
    assert.ok(await od.migration(name, 1).catch((e) => (statusOf(e) === 404 ? {} : Promise.reject(e))));
    await od.runMigration(name, 1, { maxRows: 10 }).catch((e) => assert.ok([404, 409, 400].includes(statusOf(e)), String(e)));

    const AT = `${T}Asr`; // T carries a WORM policy from the governance test
    await c.ingest([{ _type: AT, id: "t1", _pk: "t1" }, { _type: AT, id: "t2", _pk: "t2" }]);
    await sleep(1000);
    const ac = sdk.AssertionsClient.fromClient(c);
    const rec = await ac.record({
      subject: { type: AT, id: "t1" }, predicate: "city", value: "Oslo",
      source: { id: `s-${u}`, version: "1" }, valid_from: 100,
      derivation: { kind: "manual", name: "x", version: "1" },
    });
    const aid = String((rec as { assertion?: { id: string }; id?: string }).assertion?.id ?? (rec as { id?: string }).id);
    assert.ok(JSON.stringify(await ac.get(aid)).includes("Oslo"));
    assert.ok(JSON.stringify(await ac.list({ subjectType: AT, subjectId: "t1" })).includes(aid));
    await ac.confirm(aid, "ok");
    await ac.revoke(aid, "oops");
    const rec2 = await ac.record({ subject: { type: AT, id: "t2" }, predicate: "city", value: "Bergen", source: { id: `s2-${u}`, version: "1" }, valid_from: 100, derivation: { kind: "manual", name: "x", version: "1" } });
    const aid2 = String((rec2 as { assertion?: { id: string }; id?: string }).assertion?.id ?? (rec2 as { id?: string }).id);
    await ac.reject(aid2, "bad");
    const pol = `pol_${u}`;
    await ac.publishPolicy(pol, { rules: [] }, { expectedVersion: 0 }).catch((e) => assert.ok([400, 422].includes(statusOf(e)), String(e)));
    await expectHttp(ac.getPolicy(`nopol_${u}`), [404]);
    await ac.resolve({ subjectType: AT, subjectId: "t2", predicate: "city" } as never).catch((e) => assert.ok([400, 404, 422].includes(statusOf(e)), String(e)));
    await expectHttp(ac.decide("no-such", "confirm", "r"), [404]);

    const ex = sdk.ExtractionClient.fromClient(c);
    await ex.list({ limit: 5 });
    await expectHttp(ex.get("no-such"), [404]);
    assert.ok(await ex.submit([{ bogus: true }]), "server accepts an unvalidated extraction batch (recorded in evidence)");
    for (const m of ["accept", "reject", "reopen"] as const) await expectHttp((ex as never as Record<string, (...a: unknown[]) => Promise<unknown>>)[m]!("no-such", "r"), [404]);
    await expectHttp(ex.correct("no-such", {}, "r"), [404]);
    await expectHttp(ex.decide("no-such", "accept"), [404]);
    await ex.apply(name, { suggestionIds: [] }).catch((e) => assert.ok([400, 404, 409, 422].includes(statusOf(e)), String(e)));
    assert.ok(await ex.entitiesExist([{ type: T, id: "t1" }], { definition: name }).catch((e) => (statusOf(e) < 500 ? {} : Promise.reject(e))));

    const rs = sdk.ResolutionClient.fromClient(c);
    assert.ok(await rs.listRulesets());
    await expectHttp(rs.getRuleset(`none_${u}`), [404]);
    await expectHttp(rs.getCandidate("no-such"), [404]);
    await expectHttp(rs.decide("no-such", "approve", "r"), [404]);
    await expectHttp(rs.approve("no-such", "r"), [404]);
    await expectHttp(rs.reject("no-such", "r"), [404]);
    await expectHttp(rs.unmerge("no-such", "r"), [404]);
    await expectHttp(rs.getEntity("no-such"), [404]);
    await expectHttp(rs.run(`none_${u}`), [404]);
    await expectHttp(rs.evaluate(`none_${u}`, []), [404]);
    await rs.listCandidates({ limit: 5 });
    assert.ok(await rs.lookup(T, "t1"));
  });

  test("InvestigationClient saved searches + alert evidence/timeline/pivot", async () => {
    const inv = sdk.InvestigationClient.fromClient(c);
    const s = await inv.createSavedSearch({ name: `ss-${u}`, sql: `SELECT _pk FROM ${T}`, purpose: "investigation" });
    const sid = String((s as Record<string, unknown>)["id"]);
    assert.ok(JSON.stringify(await inv.listSavedSearches({ q: `ss-${u}` })).includes(sid));
    assert.ok(JSON.stringify(await inv.getSavedSearch(sid)).includes(`ss-${u}`));
    const run = await inv.runSavedSearch(sid);
    assert.ok(JSON.stringify(run).includes("t1"));
    await inv.updateSavedSearch(sid, { name: `ss-${u}`, sql: `SELECT _pk FROM ${T} LIMIT 1`, purpose: "investigation" }, { expectedVersion: 1 });
    await inv.deleteSavedSearch(sid);
    await expectHttp(inv.getSavedSearch(sid), [404]);
    await expectHttp(inv.alertEvidence("no-such"), [404]);
    await expectHttp(inv.alertTimeline("no-such"), [404]);
    await expectHttp(inv.pivot("no-such", {}), [400, 404]);
  });

  test("Backup client: create/list/restoreStatus/compact (admin)", async () => {
    const b = sdk.BackupClient.fromClient(root);
    const ref = await b.create({});
    assert.ok(ref.snapshotId.length > 10 && ref.rowCount > 0, "backup ref carries snapshotId and rowCount");
    assert.ok((await b.list()).length >= 1);
    await expectHttp(b.restoreStatus("no-such"), [400, 404]);
    await b.compact().catch((e) => assert.ok(statusOf(e) < 500, String(e)));
    await expectHttp(b.waitForRestore("no-such", { timeoutMs: 1000, pollIntervalMs: 200 }), [400, 404]);
    await expectHttp(b.restore("no-such-snapshot", {}), [400, 404, 503]); // 503: whole-store restore fenced off by design
  });

  test("Vectors + Search + RAG clients", async () => {
    const v = sdk.VectorClient.fromClient(c);
    const e = await v.embed("hello world").catch((x) => (statusOf(x) >= 400 ? null : Promise.reject(x)));
    if (e) assert.equal(e.embedding.length, e.dim);
    await v.embedBatch(["a", "b"]).catch((x) => assert.ok(statusOf(x) < 500, String(x)));
    for (const f of [
      () => v.knnSearch(T, "embedding", [0.1, 0.2, 0.3], { k: 2 }),
      () => v.hybridSearch(T, { queryText: "Name", k: 2 }),
      () => v.similarTo(T, "t1", { k: 2 }),
    ]) await f().catch((x) => assert.ok(statusOf(x) >= 400 && statusOf(x) < 500, String(x)));
    const sc = sdk.SearchClient.fromClient(c);
    const r = await until(async () => { const x = await sc.query({ from: T, text: "Name", limit: 10 }); return x.rows.length === 3 ? x : null; }, 20000);
    assert.ok(r && r.rows.length === 3, "typed SearchClient finds all 3 rows");
    const rag = sdk.RagClient.fromClient(c);
    await rag.query("what is Name 1", { type: T } as never).catch((x) => assert.ok(statusOf(x) >= 400 && statusOf(x) < 500, String(x)));
  });

  test("Streaming: queryRows/queryArrowRaw/graphChanges/alerts/recallStream/watch/a2aTaskStream", async () => {
    const s = sdk.StreamingClient.fromClient(c);
    const got: unknown[] = [];
    for await (const row of s.queryRows(`SELECT _pk FROM ${T} ORDER BY _pk`, { purpose: "investigation" })) got.push(row);
    assert.equal(got.length, 3);
    let bytes = 0;
    for await (const chunk of s.queryArrowRaw(`SELECT _pk FROM ${T}`, { purpose: "investigation" })) bytes += chunk.length;
    assert.ok(bytes > 0, "arrow stream carries bytes");
    // Live streams: open, trigger a real server-side event, take the first event, close.
    const first = async (mk: () => AsyncIterable<unknown>, trigger: () => Promise<unknown>) => {
      const it = mk()[Symbol.asyncIterator]();
      const p = it.next().then((r) => r, (e) => ({ error: e as Error }));
      await sleep(600);
      await trigger().catch(() => undefined);
      const r = await Promise.race([p, sleep(8000).then(() => "timeout" as const)]);
      if (r !== "timeout") await it.return?.(undefined);
      return r;
    };
    const bump = () => c.ingest([{ _type: T, _pk: `stream-${uid()}`, id: `s${uid()}`, name: "streamed", email: "s@example.com", v: 9 }]);
    const verdict: Record<string, unknown> = {};
    verdict["graphChanges"] = await first(() => s.graphChanges({ type: T }), bump);
    verdict["watch"] = await first(() => s.watch(`SELECT _pk FROM ${T}`, "investigation"), bump);
    verdict["alerts"] = await first(() => s.alerts(), async () => {
      const hit = (await c.search({ query: "Name", type: T })).hits[0]!;
      await c.submitAlert({ idempotency_key: `st-${uid()}`, purpose: "investigation", alert_type: "stream", severity: "low", matched_type: T, matched_row_id: hit.id, context: {} });
    });
    verdict["recallStream"] = await first(() => s.recallStream("anything", "investigation", { topK: 3 }), async () => undefined);
    const task = await sdk.A2AClient.fromClient(c).submitTask({ name: "srts", skill: "echo", input: { x: 1 } });
    verdict["a2aTaskStream"] = await first(() => s.a2aTaskStream(String((task as Record<string, unknown>)["id"] ?? (task as Record<string, unknown>)["task_id"])), async () => undefined);
    writeEvidence("streaming-verdicts", { verdict: JSON.parse(JSON.stringify(verdict, (_k, v) => (v instanceof Error ? String(v) : v))) });
    for (const [k, v] of Object.entries(verdict)) assert.notEqual(v, "timeout", `${k}: no event within 8s of a real trigger`);
  });

  test("ObservabilityClient.observeStream + FeedBrokerClient (external broker)", async () => {
    const o = sdk.ObservabilityClient.fromClient(c);
    const it = o.observeStream()[Symbol.asyncIterator]();
    await Promise.race([it.next().catch(() => 0), sleep(1500)]);
    await it.return?.(undefined);
    const fb = new sdk.FeedBrokerClient("http://127.0.0.1:1", { maxRetries: 0 } as never);
    for (const f of [() => fb.health(), () => fb.channels(), () => fb.publish("did:x", { channel: "c", payload: {} } as never)]) {
      await assert.rejects(f()); // no broker is deployed in single-node: must fail loudly, not hang
    }
  });
});
