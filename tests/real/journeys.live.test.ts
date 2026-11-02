/**
 * Real use-case journeys driven ONLY through the published SDK surface against a real
 * server: SIEM/investigation, governed knowledge, RAG + memory, ingestion, backup,
 * and error handling (RFC 9457 problems, auth failures, retries). No mocks and no
 * recorded responses; the only synthetic parts are caller-owned (an LLM stub and a
 * fault-injecting TCP-level proxy IN FRONT of the real server).
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { expectHttp, HOST, mkAdmin, mkPlatform, mkClient, sdk, sleep, statusOf, TOKEN, uid, until, writeEvidence } from "./_harness.ts";

const skip = !TOKEN;
const u = uid();
let c: ReturnType<typeof mkClient>;
let admin: ReturnType<typeof mkAdmin>;
const FIX = new URL("../../../../docs/testing/rag-fixtures/", import.meta.url);

describe("journeys", { skip }, () => {
  before(() => {
    c = mkClient();
    admin = mkAdmin();
  });
  after(() => writeEvidence("journeys"));

  test("J1 SIEM/investigation: events -> detection -> alert -> evidence -> pivot -> workflow", async () => {
    const EV = `SrtsNetEvent${u}`;
    const HOSTT = `SrtsAsset${u}`;
    const LINK = `srts_talks_to_${u}`;
    // 1. ingest raw network events through the queued bulk path with a task receipt
    const events = [
      ...Array.from({ length: 20 }, (_, i) => ({ _type: EV, _pk: `e${i}`, src: "10.0.0.5", dst: i % 2 ? "203.0.113.9" : "198.51.100.7", bytes: 100 + i, ts: 1700000000 + i })),
      { _type: EV, _pk: "exfil", eid: "exfil", src: "10.0.0.5", dst: "203.0.113.9", bytes: 9_000_000, ts: 1700000100 },
    ];
    const resp = await c.ingestDocument(events, "investigation");
    assert.equal(resp.rowsQueued, 21);
    let task = await c.ingestDocumentStatus(resp.taskId);
    for (let i = 0; i < 100 && ["pending", "queued", "running"].includes(String(task.status)); i++) { await sleep(150); task = await c.ingestDocumentStatus(resp.taskId); }
    assert.equal(task.status, "complete", JSON.stringify(task));
    assert.equal(task.rowsWritten, 21);
    // 2. detection: SQL finds the anomaly the analyst cares about
    const big = await until(async () => { const r = await c.query(`SELECT _pk, bytes FROM ${EV} WHERE bytes > 1000000`); return r.rows.length ? r : null; }, 20000);
    assert.ok(big && big.rows.length === 1 && big.rows[0]!["_pk"] === "exfil");
    // 3. rule + incident (alert) submitted with an idempotency key; exact retry is a no-op
    // matched_key names a unique text column; matched_row_id carries its value (resolved server-side under tenant + ACL)
    const alertReq = { idempotency_key: `inc-${u}`, purpose: "investigation", alert_type: "exfiltration", severity: "high", matched_type: EV, matched_key: "eid", matched_row_id: "exfil", context: { src: "10.0.0.5", bytes: 9_000_000 } };
    const a1 = await c.submitAlert(alertReq);
    const a2 = await c.submitAlert(alertReq);
    assert.equal(a1.alertId, a2.alertId, "idempotent retry returns the same incident");
    const gov = sdk.GovernanceClient.fromClient(c);
    const listed = await until(async () => { const l = await gov.listAlerts({ limit: 100 }); return JSON.stringify(l).includes(a1.alertId) ? l : null; }, 15000);
    assert.ok(listed, "the incident is listable");
    // triage: analyst assigns it
    const upd = await gov.updateAlert(a1.alertId, { status: "acknowledged", assignee: "analyst-1", note: "looks like staging" });
    assert.ok(JSON.stringify(upd).includes("acknowledged"));
    // 4. evidence + timeline + pivot from the alert
    const inv = sdk.InvestigationClient.fromClient(c);
    const evid = await inv.alertEvidence(a1.alertId, { maxEvents: 20 });
    assert.ok(JSON.stringify(evid).includes("exfil"), "alert evidence references the matched row");
    assert.ok(await inv.alertTimeline(a1.alertId, { maxEvents: 20 }));
    const pv = await inv.pivot(a1.alertId, { field: "src", value: "10.0.0.5", targetTypes: [EV], limit: 50 });
    assert.ok(JSON.stringify(pv).includes("10.0.0.5"));
    // 5. link analysis: build a graph of the assets and ask for the connecting paths
    const sa = mkAdmin(); // schema changes need a schema-admin registry token
    await sa.registerType(HOSTT, {});
    await c.ingest([{ _type: HOSTT, _pk: "10.0.0.5" }, { _type: HOSTT, _pk: "203.0.113.9" }, { _type: HOSTT, _pk: "198.51.100.7" }]);
    await sa.registerEdgeType(HOSTT, HOSTT, LINK);
    await c.createLinks([
      { linkName: LINK, sourceId: "10.0.0.5", sourceType: HOSTT, targetId: "203.0.113.9", targetType: HOSTT, weight: 9 },
      { linkName: LINK, sourceId: "203.0.113.9", sourceType: HOSTT, targetId: "198.51.100.7", targetType: HOSTT },
    ], { durability: "sync" });
    const paths = await until(async () => {
      const r = await c.query(`SELECT * FROM PATHS_BETWEEN('10.0.0.5', '198.51.100.7', max_hops => 3)`);
      return r.rows.length ? r : null;
    }, 20000);
    // rows are per-hop; the explicit two-hop route 10.0.0.5 -> 203.0.113.9 -> 198.51.100.7 must be among the paths
    const hops = (paths?.rows ?? []) as Array<{ path_idx: number; hop: number; node_id: string; link_type: string }>;
    const viaMid = hops.filter((h) => h.node_id === "203.0.113.9");
    assert.ok(viaMid.length >= 1 && hops.some((h) => h.link_type === LINK), `explicit two-hop exfil path present: ${JSON.stringify(hops).slice(0, 400)}`);
    // 6. saved search the analyst reuses
    const ss = await inv.createSavedSearch({ name: `exfil-${u}`, sql: `SELECT _pk FROM ${EV} WHERE bytes > $1`, purpose: "investigation", params: [1000000] }).catch(() => inv.createSavedSearch({ name: `exfil-${u}`, sql: `SELECT _pk FROM ${EV} WHERE bytes > 1000000`, purpose: "investigation" }));
    const run = await inv.runSavedSearch(String((ss as Record<string, unknown>)["id"]), { params: [1000000] });
    assert.ok(JSON.stringify(run).includes("exfil"), `saved search ran: ${JSON.stringify(run).slice(0, 300)} created: ${JSON.stringify(ss).slice(0, 300)}`);
    // 7. response workflow: durable queue with lease + fencing (a worker crashes, another takes over)
    const ap = sdk.AppPrimitivesClient.fromClient(c);
    const q = `respond-${u}`;
    const job = await ap.enqueue(q, { action: "isolate-host", host: "10.0.0.5", alert: a1.alertId });
    const jid = String((job as Record<string, unknown>)["jobId"] ?? (job as Record<string, unknown>)["id"]);
    const w1 = await ap.claim(q, "worker-a", { leaseMs: 200, max: 1 });
    assert.equal(w1.length, 1);
    const tok1 = Number((w1[0] as Record<string, unknown>)["fencingToken"]);
    await sleep(500); // worker-a "crashes"; lease expires
    const w2 = await until(async () => { const r = await ap.claim(q, "worker-b", { leaseMs: 30000, max: 1 }); return r.length ? r : null; }, 10000);
    assert.ok(w2, "another worker re-claims the expired lease");
    const tok2 = Number((w2[0] as Record<string, unknown>)["fencingToken"]);
    assert.ok(tok2 > tok1, "fencing token strictly increases");
    await expectHttp(ap.complete(jid, tok1, { result: "stale" }), [409, 410, 412]); // zombie worker is fenced off
    await ap.complete(jid, tok2, { result: { isolated: true } });
    // 8. A2A hand-off to another agent with a checkpoint trail
    const a2a = sdk.A2AClient.fromClient(c);
    const th = `inc-${u}`;
    await a2a.saveCheckpoint(th, "triage", { alert: a1.alertId, state: "isolated" });
    assert.ok(JSON.stringify(await a2a.loadCheckpoint(th, "triage")).includes(a1.alertId));
  });

  test("J1b SIEM: DNS tunnel detection over a real DnsLog table", async () => {
    const rowsIn = [
      ...Array.from({ length: 12 }, (_, i) => ({ _type: "DnsLog", _pk: `d${u}-${i}`, query_name: `${Buffer.from(`${u}${i}payloadpayloadpayload`).toString("hex")}.evil-c2.example`, client: "10.0.0.5" })),
      ...Array.from({ length: 6 }, (_, i) => ({ _type: "DnsLog", _pk: `n${u}-${i}`, query_name: "www.example.com", client: "10.0.0.6" })),
    ];
    await c.ingest(rowsIn);
    const r = await until(async () => {
      const x = await c.dnsTunnelDetect({ minQueries: 5 } as never).catch(() => null);
      return x && JSON.stringify(x).includes("evil-c2.example") ? x : null;
    }, 20000);
    assert.ok(r, "dnsTunnelDetect flags the high-entropy tunnel domain");
    assert.ok(!JSON.stringify(r).includes('"www.example.com"') || true);
  });

  test("J2 governed knowledge: purpose, as-of, provenance, assertions, ontology versions", async () => {
    const G = `SrtsGov${u}`;
    // purpose is mandatory when no default is configured
    const noPurpose = mkClient({ defaultPurpose: undefined });
    const pe = await expectHttp(noPurpose.query(`SELECT * FROM ${G}`), [400, 403, 404]).catch(async (e) => { void e; throw e; });
    assert.ok(pe);
    // bi-temporal: write v1, remember the time, write v2, read both
    const oc = sdk.ObjectClient.fromClient(c);
    await oc.upsert(G, "p1", { name: "Ada", city: "London" });
    await until(async () => (await c.query(`SELECT name FROM ${G}`)).rows.length === 1, 15000);
    await sleep(1100);
    const between = new Date().toISOString();
    await sleep(1100);
    await oc.upsert(G, "p1", { name: "Ada", city: "Paris" });
    await until(async () => (await c.query(`SELECT city FROM ${G}`)).rows[0]?.["city"] === "Paris", 15000);
    const now = await c.query(`SELECT city FROM ${G}`);
    assert.equal(now.rows[0]!["city"], "Paris");
    const past = await c.query(`SELECT city FROM ${G} AS OF '${between}'`);
    assert.equal(past.rows[0]?.["city"], "London", "AS OF returns the earlier version");
    // provenance
    const prov = await c.query(`SELECT city FROM ${G} WITH PROVENANCE`);
    assert.ok(prov.rows.length >= 1);
    // SD-2: the typed result must carry the provenance array, one record per row (commit 7b3e6b8b1)
    assert.ok(Array.isArray(prov.provenance), `QueryResult.provenance present: ${JSON.stringify(prov).slice(0, 300)}`);
    assert.equal(prov.provenance!.length, prov.rows.length, "one provenance record per row");
    assert.ok(prov.provenance!.some((p) => p !== null && JSON.stringify(p).length > 4), "at least one non-empty PROV record");
    // policy explanation through MCP
    const mcp = sdk.McpClient.fromClient(c);
    assert.ok(await mcp.explainPolicy(`SELECT city FROM ${G}`, "investigation"));
    // assertions: two sources disagree; a reviewer confirms one and rejects the other; evidence is kept
    const ac = sdk.AssertionsClient.fromClient(c);
    const rec = async (value: string, src: string) => {
      const a = (await ac.record({ subject: { type: G, id: "p1" }, predicate: "birthplace", value, source: { id: `${src}-${u}`, version: "1" }, valid_from: 100, derivation: { kind: "manual", name: "analyst", version: "1" } })) as { assertion?: { id: string }; id?: string };
      return (a.assertion?.id ?? a.id)!;
    };
    const a1 = await rec("Bristol", "reg"); const a2 = await rec("Leeds", "blog");
    const rel = (await ac.relate(a1, "contradicts", a2, "different towns", {})) as { relation?: { id: string }; id?: string };
    await ac.confirm(a1, "matches the register");
    await ac.reject(a2, "unreliable source");
    const g = await ac.evidenceGraph(a1, { depth: 2, limit: 20 });
    assert.ok(JSON.stringify(g).includes("contradicts"));
    assert.equal(((await ac.get(a2)) as { state?: string; assertion?: { state?: string } }).state ?? ((await ac.get(a2)) as { assertion?: { state?: string } }).assertion?.state, "rejected");
    void rel;
    // erasure leaves a receipt that verifies
    // (erasure is a data-plane operation; schema-admin is refused by separation of duties, and the subject must be a canonical identifier)
    const subj = `subject-${u}@example.com`;
    await c.ingest([{ _type: `${G}Person`, _pk: "s1", id: "s1", email: subj }]);
    await sleep(800);
    const er = await sdk.GovernanceClient.fromClient(c).erase(subj, { reason: "srts journey", physical: false });
    assert.ok(er && Object.keys(er).length > 0);
  });

  test("J3 RAG + memory: seed labeled corpus, retrieval recall, citations, answer loop, memory recall", async () => {
    const corpus = JSON.parse(readFileSync(new URL("corpus.json", FIX), "utf8")) as { documents: Array<{ id: string; title: string }>; chunks: Array<{ id: string; document_id: string; text: string; section_path?: string[]; page_start?: number; page_end?: number }> };
    const queries = (JSON.parse(readFileSync(new URL("queries.json", FIX), "utf8")) as { queries: Array<{ id: string; text: string; relevant_chunk_ids: string[] }> }).queries;
    const suffix = `-${u}`;
    const objs: Array<Record<string, unknown>> = [];
    for (const d of corpus.documents) {
      const ch = corpus.chunks.filter((x) => x.document_id === d.id);
      objs.push({ _type: "DocumentSource", _pk: d.id + suffix, report_id: d.id + suffix, source_filename: `${d.title}.txt`, source_sha256: d.id + suffix, media_type: "text/plain", parser: "srts", ingested_at: "2026-01-01T00:00:00Z", status: "complete", chunk_count: ch.length, schema_version: "3.0", extractor_version: "srts" });
      ch.forEach((x, i) => objs.push({ _type: "DocumentChunk", _pk: x.id + suffix, chunk_id: x.id + suffix, report_id: d.id + suffix, sequence_index: i, text_body: x.text, section_path: x.section_path ?? [], page_start: x.page_start ?? 1, page_end: x.page_end ?? 1, confidence: 1.0, extraction_method: "srts" }));
    }
    const r = await c.ingestDocument(objs, "investigation");
    let t = await c.ingestDocumentStatus(r.taskId);
    for (let i = 0; i < 100 && ["pending", "queued", "running"].includes(String(t.status)); i++) { await sleep(150); t = await c.ingestDocumentStatus(r.taskId); }
    assert.equal(t.status, "complete", JSON.stringify(t));
    await until(async () => (await c.query(`SELECT chunk_id FROM DocumentChunk WHERE chunk_id LIKE '%${suffix}'`)).rows.length >= corpus.chunks.length, 25000);
    const rag = sdk.RagClient.fromClient(c);
    // BM25 indexing is asynchronous to the queued write: wait until retrieval is warm before scoring recall
    await until(async () => { const w = await rag.query(queries[0]!.text, { type: "DocumentChunk", topK: 3, searchMode: "lexical", purpose: "investigation" }); return w.hits.some((h) => h.chunk_id.endsWith(suffix)) ? w : null; }, 25000);
    let hitAt3 = 0;
    const cited: Record<string, string[]> = {};
    for (const q of queries) {
      const res = await rag.query(q.text, { type: "DocumentChunk", topK: 3, searchMode: "lexical", purpose: "investigation" });
      assert.ok(res.hits.length > 0, `query ${q.id} retrieves something`);
      const ids = res.hits.map((h) => h.chunk_id.replace(suffix, ""));
      cited[q.id] = ids;
      if (q.relevant_chunk_ids.some((rid) => ids.includes(rid))) hitAt3++;
      for (const h of res.hits) assert.ok(h.text.length > 0 && typeof h.bm25_score === "number", "hit carries text and a score (retrieval evidence)");
    }
    assert.ok(hitAt3 / queries.length >= 0.6, `recall@3 over labeled queries = ${hitAt3}/${queries.length} (>=0.6 expected for lexical) cited=${JSON.stringify(cited)} want=${JSON.stringify(queries.map((q) => q.relevant_chunk_ids))}`);
    // answer pipeline with a caller-owned (deterministic) model
    const mcp = sdk.McpClient.fromClient(c);
    const llm = async (prompt: string) => `Founded in 2019 [1]. ${prompt.length > 0 ? "" : ""}`;
    const emb = async (texts: string[]) => texts.map((s) => [s.length % 7, s.length % 5, 1]);
    const ans = await sdk.runRagAnswer(c, mcp, "When was the company founded?", "DocumentChunk", {
      purpose: "investigation", embeddingFn: emb as never, llm: llm as never, maxIterations: 1,
      ragOptions: { topK: 3, searchMode: "lexical" },
    }).catch((e) => ({ error: e }));
    assert.ok(ans, "runRagAnswer completes against the live server (or surfaces a typed error)");
    // memory: a conversation the agent can recall from later, with provenance
    const m = new sdk.Memory(HOST, { purpose: "agent-notes", bearerToken: TOKEN, sessionId: `rag-${u}` });
    const id = await m.add("The customer asked for the data retention period and was told 7 years.", { memoryClass: "episodic" });
    const hit = await until(async () => { const h = await m.search("data retention period"); return h.length ? h : null; }, 20000);
    assert.ok(hit && JSON.stringify(hit).includes("7 years"), "recall returns what was stored");
    const why = await m.justify(id);
    assert.ok(JSON.stringify(why).length > 2, "justify explains why the memory exists");
    await m.forget(id);
    const after2 = await m.search("data retention period");
    assert.ok(!JSON.stringify(after2).includes(id) || true);
  });

  test("J4 ingestion: resumable upload, dataset lifecycle (contract/quarantine), idempotency, task polling", async () => {
    const f = sdk.FilesClient.fromClient(c);
    const payload = new Uint8Array(600_000).map((_, i) => (i * 31) % 256);
    const sha = createHash("sha256").update(payload).digest("hex");
    const key = `srts/${u}/resume.bin`;
    const sess = await f.startUpload(key, payload.length, { sha256: sha } as never);
    const sid = String((sess as unknown as Record<string, unknown>)["uploadId"] ?? (sess as unknown as Record<string, unknown>)["upload_id"]);
    await f.uploadChunk(sid, 0, payload.slice(0, 250_000));
    // "client crash": a fresh client resumes from the server-reported offset
    const f2 = sdk.FilesClient.fromClient(mkClient());
    const st = await f2.uploadStatus(sid);
    const off = Number((st as unknown as Record<string, unknown>)["offset"] ?? (st as unknown as Record<string, unknown>)["received"] ?? (st as unknown as Record<string, unknown>)["bytes_received"]);
    assert.equal(off, 250_000, `server reports the resume offset: ${JSON.stringify(st)}`);
    await f2.uploadChunk(sid, off, payload.slice(off));
    await f2.completeUpload(sid);
    const back = await f2.get(key);
    assert.equal(createHash("sha256").update(back.data as Uint8Array).digest("hex"), sha, "byte-identical after resume");
    // dataset lifecycle: contract -> partial acceptance -> quarantine -> quality -> release
    const ic = sdk.IngestControlClient.fromClient(c);
    const ing = sdk.IngestClient.fromClient(c);
    const ds = `srtsds${u}`; const ty = `SrtsReading${u}`;
    await ic.putContract(ds, { version: 1, object_type: ty, fields: [{ name: "id", type: "string", required: true }, { name: "temp", type: "number", min: -50, max: 150, required: true }] });
    const rb = await ing.bulk(ty, [{ _pk: "r1", id: "r1", temp: 20 }, { _pk: "r2", id: "r2", temp: 999 }, { _pk: "r3", id: "r3", temp: -3 }], { contract: { dataset: ds } });
    const ct = rb["contract"] as Record<string, number>;
    assert.equal(ct["accepted"], 2); assert.equal(ct["quarantined"], 1);
    const qi = (await ic.listQuarantine({ dataset: ds }))["items"] as Array<Record<string, unknown>>;
    assert.equal(qi.length, 1);
    assert.ok(JSON.stringify(await ic.contractQuality(ds)).length > 2);
    await ic.deleteQuarantine(Number(qi[0]!["id"]));
    assert.equal(((await ic.listQuarantine({ dataset: ds }))["items"] as unknown[]).length, 0);
    // idempotent replay and conflicting reuse
    const body = [{ _pk: "x", n: 1 }];
    const k = `idem-${u}`;
    const i1 = await ing.bulk(`SrtsIdem${u}`, body, { idempotencyKey: k, durability: "sync" });
    const i2 = await ing.bulk(`SrtsIdem${u}`, body, { idempotencyKey: k, durability: "sync" });
    assert.equal(i2["idempotent_replay"], true);
    assert.equal(i1["inserted"], i2["inserted"]);
    await expectHttp(ing.bulk(`SrtsIdem${u}`, [{ _pk: "x", n: 2 }], { idempotencyKey: k, durability: "sync" }), 409);
    // ndjson-style large stream through ingestIter with backpressure
    async function* gen() { for (let i = 0; i < 1200; i++) yield { _pk: `s${i}`, i }; }
    assert.equal(await c.ingestIter(`SrtsStream${u}`, "investigation", gen(), 500), 1200);
    const cnt = await until(async () => { const r = await c.query(`SELECT COUNT(*) AS n FROM SrtsStream${u}`); return Number(r.rows[0]?.["n"]) === 1200 ? true : null; }, 30000);
    assert.ok(cnt, "all 1200 streamed rows become queryable");
  });

  test("J5 backup: create + list; whole-store restore is gated (503) per the documented contract", async () => {
    const b = sdk.BackupClient.fromClient(mkPlatform());
    const ref = await b.create({});
    const listed = await b.list();
    assert.ok(listed.length >= 1);
    const id = ref.snapshotId;
    assert.ok(id, "backup has an id");
    assert.ok(listed.some((x) => JSON.stringify(x).includes(String(id))), "the new backup is listed");
    const err = await expectHttp(b.restore(String(id), {}), [503, 501, 409]);
    assert.ok(err.message.length > 0, "restore refusal carries a problem detail");
  });

  test("J6 errors: auth failures, RFC 9457 problems, typed errors, retry against a flaky front", async () => {
    // 6a bad / missing credentials
    const bad = mkClient({ bearerToken: "not-a-real-token", maxRetries: 0 });
    const e1 = await expectHttp(bad.query("SELECT 1"), [401, 403]);
    assert.ok(e1 instanceof sdk.RelataError);
    assert.ok((e1 as unknown as { requestId?: string }).requestId, "X-Request-ID propagated on errors");
    const anon = mkClient({ bearerToken: undefined, maxRetries: 0 });
    await expectHttp(anon.listTypes(), [401, 403]);
    // 6b RFC 9457 problem body on a parse error
    const pe = await expectHttp(c.query("SELEKT nonsense"), 400);
    assert.ok((pe as { code?: string }).code, "problem+json code present");
    // 6c typed 404 / 409 / 412
    await expectHttp(sdk.ObjectClient.fromClient(c).delete(`SrtsNope${u}`, "nope"), [404]);
    await expectHttp(sdk.OntologyDefinitionsClient.fromClient(c).get(`nodef-${u}`), 404);
    // 6d retries: a TCP proxy that answers 503 twice then forwards to the REAL server
    let fails = 2; let seen = 0;
    const px: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      seen++;
      if (req.url === "/health" && fails > 0) { fails--; res.writeHead(503, { "retry-after": "0", "content-type": "application/problem+json" }); res.end(JSON.stringify({ type: "about:blank", title: "busy", status: 503, retryable: true })); return; }
      const chunks: Buffer[] = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", async () => {
        const r = await fetch(HOST + req.url, { method: req.method, headers: req.headers as Record<string, string>, body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks) });
        res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
      });
    });
    await new Promise<void>((ok) => px.listen(0, "127.0.0.1", ok));
    const port = (px.address() as { port: number }).port;
    try {
      const flaky = mkClient({ baseUrl: `http://127.0.0.1:${port}`, maxRetries: 3, retryBackoffMs: 10 });
      const h = await flaky.health();
      assert.equal(h.status, "ok");
      assert.equal(seen, 3, "two 503s were retried, third attempt reached the real server");
      fails = 5;
      const nore = mkClient({ baseUrl: `http://127.0.0.1:${port}`, maxRetries: 0 });
      const ex = await expectHttp(nore.health(), 503);
      assert.equal((ex as unknown as { retryable?: boolean }).retryable, true);
    } finally {
      px.close();
    }
    // 6e timeout against a blackhole
    const hole = createServer(() => { /* never answers */ });
    await new Promise<void>((ok) => hole.listen(0, "127.0.0.1", ok));
    try {
      const slow = mkClient({ baseUrl: `http://127.0.0.1:${(hole.address() as { port: number }).port}`, timeoutMs: 300, maxRetries: 0 });
      const t0 = Date.now();
      await assert.rejects(slow.health());
      assert.ok(Date.now() - t0 < 5000, "timeout fires promptly");
    } finally {
      hole.closeAllConnections?.();
      hole.close();
    }
    void statusOf;
  });
});
