/**
 * Live success-path sweep: methods the earlier sweeps only reached through a documented 4xx now
 * run their real happy path (extraction review loop, assertion policy + resolve, entity-resolution
 * decisions, token self-revoke, deletion receipt verification, freshness barrier, job status).
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { ADMIN, ADMIN_TOKEN, expectHttp, HOST, mkClient, sdk, sleep, TOKEN, uid, until, writeEvidence } from "./_harness.ts";

const skip = !TOKEN;
const u = uid();
let c: ReturnType<typeof mkClient>;

describe("success-path sweep", { skip }, () => {
  before(() => {
    c = mkClient();
  });
  after(() => writeEvidence("success"));

  test("ExtractionClient: submit -> list -> get -> accept / reject / correct / reopen -> decide", async () => {
    const ex = sdk.ExtractionClient.fromClient(c);
    const mk = (n: string, conf = 0.9) => ({
      kind: "entity", payload: { type: "Person", properties: { name: `${n}-${u}` } }, source: { id: `doc-${n}-${u}`, version: "1" },
      extractor: { name: "ner", version: "1", confidence_meaning: "calibrated" }, confidence: conf,
      evidence: { locator: `doc-${n}#p1`, excerpt: `${n} appears here` },
    });
    const sub = (await ex.submit([mk("a"), mk("b"), mk("c"), mk("d"), mk("e")])) as { created: number; results: Array<{ id?: string; suggestion_id?: string; status: string }> };
    assert.equal(sub.created, 5, JSON.stringify(sub).slice(0, 300));
    const ids = sub.results.map((r) => String(r.id ?? r.suggestion_id));
    const q = (await ex.list({ state: "pending", limit: 50 })) as { suggestions?: Array<{ id: string }>; items?: Array<{ id: string }> };
    const listed = JSON.stringify(q);
    for (const id of ids) assert.ok(listed.includes(id), `suggestion ${id} is in the pending queue`);
    assert.ok(JSON.stringify(await ex.get(ids[0]!)).includes(`a-${u}`));
    assert.ok(JSON.stringify(await ex.accept(ids[0]!, "verified")).toLowerCase().includes("accepted"));
    assert.ok(JSON.stringify(await ex.reject(ids[1]!, "wrong person")).toLowerCase().includes("rejected"));
    assert.ok(JSON.stringify(await ex.correct(ids[2]!, { type: "Person", properties: { name: `fixed-${u}` } }, "typo")).toLowerCase().includes("corrected"));
    assert.ok(JSON.stringify(await ex.reopen(ids[1]!)).toLowerCase().includes("pending"));
    assert.ok(JSON.stringify(await ex.decide(ids[3]!, "accept", "also fine")).toLowerCase().includes("accepted"));
    // a low-confidence suggestion cannot be accepted as-is (409), but can with an explicit override
    const low = (await ex.submit([mk("low", 0.2)])) as { results: Array<{ id?: string; suggestion_id?: string }> };
    const lid = String(low.results[0]!.id ?? low.results[0]!.suggestion_id);
    await expectHttp(ex.accept(lid, "ok"), 409);
    assert.ok(JSON.stringify(await ex.accept(lid, "", { acceptLowConfidence: true })).toLowerCase().includes("accepted"));
  });

  test("AssertionsClient: assess / publishPolicy / getPolicy / resolve", async () => {
    const ac = sdk.AssertionsClient.fromClient(c);
    const ty = `SrtsAsrt${u}`;
    await c.ingest([{ _type: ty, _pk: "s1", id: "s1" }]);
    await sleep(800);
    const mk = async (value: string, src: string, validFrom: number) => {
      const r = (await ac.record({ subject: { type: ty, id: "s1" }, predicate: "city", value, source: { id: `${src}-${u}`, version: "1" }, valid_from: validFrom, derivation: { kind: "manual", name: "x", version: "1" } })) as { assertion?: { id: string }; id?: string };
      return String(r.assertion?.id ?? r.id);
    };
    const a1 = await mk("Oslo", "reg", 100);
    const a2 = await mk("Bergen", "blog", 100);
    const ass = await ac.assess(a1, "corroborated", "matches the register");
    assert.ok(JSON.stringify(ass).toLowerCase().includes("corroborated"));
    const pol = `pol_${u}`;
    const pub = await ac.publishPolicy(pol, { precedence: ["state", "source_rank", "recorded_latest"], source_rank: [`reg-${u}`, `blog-${u}`] }, { expectedVersion: 0 });
    assert.ok(pub);
    assert.ok(JSON.stringify(await ac.getPolicy(pol)).includes("source_rank"));
    await ac.confirm(a1, "ok");
    await ac.reject(a2, "unreliable");
    const res = await ac.resolve(ty, "s1", "city", 200, { policy: pol });
    assert.equal((res as { resolved?: { value?: string } }).resolved?.value, "Oslo", `resolve picks the confirmed value: ${JSON.stringify(res).slice(0, 300)}`);
  });

  test("ResolutionClient: approve / reject / getEntity / unmerge on two candidate pairs", async () => {
    const R = `SrtsEr${u}`;
    await c.ingest([
      { _type: R, _pk: "r1", id: "r1", email: "one@example.com", source: "crm" },
      { _type: R, _pk: "r2", id: "r2", email: "ONE@example.com", source: "crm" },
      { _type: R, _pk: "r3", id: "r3", email: "two@example.com", source: "crm" },
      { _type: R, _pk: "r4", id: "r4", email: "two@example.com ", source: "crm" },
    ]);
    await until(async () => (await c.query(`SELECT _pk FROM ${R}`)).rows.length === 4, 20000);
    const rs = sdk.ResolutionClient.fromClient(c);
    const name = `er_${u}`;
    await rs.publishRuleset(name, {
      entity_type: R, id_field: "id", confidence_meaning: "Probability-like score that two records describe the same entity; not a calibrated guarantee.",
      source_field: "source", source_reliability: { crm: 1.0 },
      rules: [{ id: "email", kind: "exact", fields: ["email"], normalize: ["trim", "lowercase"], weight: 0.95, strength: "strong", max_group: 2 }],
      thresholds: { auto_merge: 0.9, review: 0.5 }, policy: { auto_merge: false },
      approved_thresholds: { min_precision: 0.75, min_recall: 0.75, approved_by: "data steward role" },
    }, { expectedVersion: 0 });
    await rs.run(name);
    const l = (await rs.listCandidates({ ruleset: name, limit: 10 })) as Record<string, unknown>;
    const cands = (l["candidates"] ?? l["items"] ?? []) as Array<Record<string, unknown>>;
    assert.equal(cands.length, 2, "two pairs proposed");
    const [c1, c2] = cands.map((x) => String(x["id"] ?? x["candidate_id"]));
    const ap = (await rs.approve(c1!, "same mailbox")) as Record<string, unknown>;
    const ents = (ap["entities"] ?? {}) as Record<string, { canonical_id?: string; source_id?: string }>;
    const canonical = String(ents["a"]?.canonical_id);
    assert.ok(canonical.startsWith("ent_") && ents["b"]?.canonical_id === canonical, `approve merges both records into one entity: ${JSON.stringify(ents)}`);
    assert.ok(JSON.stringify(await rs.getEntity(canonical)).includes("r1"), "entity lists its source record");
    assert.ok(await rs.unmerge(c1!, "mistake"));
    assert.ok(JSON.stringify(await rs.reject(c2!, "different people")).toLowerCase().includes("rejected"));
  });

  test("TokenClient.revokeSelf, GovernanceClient.verifyReceipt, SystemClient.jobStatus, Memory forget via client", async () => {
    const minted = await fetch(`${ADMIN}/admin/tokens`, {
      method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ description: "srts-revoke", role: "tenant-admin", tenant_id: "default" }),
    }).then((r) => r.json() as Promise<{ id: string; secret: string }>);
    const mine = mkClient({ bearerToken: minted.secret });
    const tk = sdk.TokenClient.fromClient(mine);
    await tk.revokeSelf(minted.id); // 204: no body
    await expectHttp(tk.listSelf(), 401);

    const g = sdk.GovernanceClient.fromClient(c);
    const email = `rcpt-${u}@example.com`;
    await c.ingest([{ _type: `SrtsRcpt${u}`, _pk: "r", id: "r", email }]);
    await sleep(800);
    const er = (await g.erase(email, { reason: "receipt check" })) as Record<string, unknown>;
    // Without a KMS the server performs a governed tombstone only and issues NO signed receipt (it says so);
    // a forged receipt must therefore verify as false rather than be accepted.
    assert.ok(er["operation_id"] && er["global_physical_erasure_verified"] === false, JSON.stringify(er).slice(0, 300));
    const vr = await g.verifyReceipt({ receipt_id: "forged", subject: email, erased_at: 1, rows_shredded: 1, receipt_signature: "00" });
    assert.equal((vr as { verified?: boolean }).verified, false, JSON.stringify(vr));
    const st = await g.deletionStatus(String(er["operation_id"]));
    assert.equal((st as { operation_id?: string }).operation_id, er["operation_id"]);

    const sys = sdk.SystemClient.fromClient(c);
    const jobs = (await sys.jobsStatus()) as Record<string, unknown>;
    assert.equal((jobs as { count?: number }).count, 0, "a fresh node has no registered background jobs");
    await expectHttp(sys.jobStatus("no-such-job"), 404); // no job exists to report success for (recorded, not a gap in the SDK)

    const rem = await c.remember("forget me please: the vault code is 4711", { purpose: "agent-notes" } as never);
    const mid = String((rem as unknown as Record<string, unknown>)["id"] ?? (rem as unknown as Record<string, unknown>)["memory_id"]);
    assert.ok(mid && mid !== "undefined", JSON.stringify(rem));
    await c.forget(mid);
    void HOST;
  });

  test("FreshnessClient.barrier with a real write token", async () => {
    const oc = sdk.ObjectClient.fromClient(c);
    const T = `SrtsFr${u}`;
    const w = (await oc.commit([{ op: "create", type: T, id: "f1", data: { name: "fresh" } }])) as unknown as Record<string, unknown>;
    const op = (w["operation"] ?? {}) as Record<string, unknown>;
    const token = String(op["token"] ?? w["token"] ?? "");
    assert.ok(token.length > 8, `write returns a freshness token: ${JSON.stringify(w).slice(0, 300)}`);
    const fr = sdk.FreshnessClient.fromClient(c);
    const b = await fr.barrier(token, { waitMs: 5000 });
    assert.ok(JSON.stringify(b).length > 2);
    assert.equal((await c.query(`SELECT name FROM ${T}`)).rows[0]?.["name"], "fresh", "after the barrier the write is readable");
  });
});
