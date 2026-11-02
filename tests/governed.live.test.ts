/**
 * Governed-knowledge run through the TypeScript SDK against a live server
 * (#5711, #5712, #5721). Mirrors scripts/sdk_governed_e2e.py. Skips unless
 * RELATA_TOKEN is set. Run: scripts/sdk_governed_live.sh (needs a running
 * server), or `node --experimental-strip-types --test tests/governed.live.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AssertionsClient,
  OntologyDefinitionsClient,
  RelataClient,
  ResolutionClient,
} from "../src/index.ts";

const BASE = process.env.RELATA_HOST || "http://localhost:9090";
const TOKEN = process.env.RELATA_TOKEN;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("governed knowledge live run", { skip: !TOKEN }, async () => {
  const client = new RelataClient({ baseUrl: BASE, bearerToken: TOKEN });
  const od = OntologyDefinitionsClient.fromClient(client);
  const rs = ResolutionClient.fromClient(client);
  const ac = AssertionsClient.fromClient(client);
  const uid = String(Date.now() % 1_000_000_000);
  const ty = `TsGovPerson${uid}`;
  const name = `crm_ts_${uid}`;
  const raw = (method: string, path: string, body?: unknown) =>
    fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  // ---- #5711
  await od.create(name, {
    objects: [{ name: ty, properties: [{ name: "email", type: "text", required: true }] }],
    links: [],
  });
  assert.ok(await od.compare(name));
  assert.ok(await od.publish(name, { expectedVersion: 0 }));
  await assert.rejects(od.publish(name, { expectedVersion: 0 }), (e: unknown) => {
    assert.equal((e as { statusCode?: number }).statusCode, 412);
    return true;
  });
  const ing = await raw("POST", `/v1/ingest?purpose=investigation&object_type=${ty}`, [
    { id: "p1", email: "ada@example.com" },
    { id: "p2", email: "ADA@example.com" },
  ]);
  assert.equal(ing.status, 200);
  let stamped = false;
  for (let i = 0; i < 100 && !stamped; i++) {
    const st = (await od.status(name)) as { types?: Array<{ by_version?: Record<string, number> }> };
    stamped = st.types?.[0]?.by_version?.["1"] === 2;
    if (!stamped) await sleep(200);
  }
  assert.ok(stamped, "ingested rows carry definition version 1");
  const found = await client.search({ query: "ada", type: ty });
  assert.ok(found.hits.length > 0);
  for (const h of found.hits) assert.equal(h.definition?.current, `${name}@1`);

  // ---- #5712
  const ruleset = `ts_people_${uid}`;
  await rs.publishRuleset(ruleset, {
    entity_type: ty,
    confidence_meaning: "test score, not calibrated",
    rules: [{ id: "email", kind: "exact", fields: ["email"], normalize: ["trim", "lowercase"], weight: 0.95, strength: "strong" }],
    thresholds: { auto_merge: 0.9, review: 0.5 },
    approved_thresholds: { min_precision: 0.5, min_recall: 0.5 },
  });
  await rs.run(ruleset);
  const cands = (await rs.listCandidates({ ruleset })) as { items: Array<{ id: string }> };
  assert.equal(cands.items.length, 1);
  const cid = cands.items[0]!.id;
  await rs.approve(cid, "ts sdk");
  assert.equal((await rs.lookup(ty, "p2"))["clustered"], true);
  await rs.unmerge(cid, "wrong person");
  await rs.unmerge(cid, "wrong person"); // idempotent
  assert.equal((await rs.lookup(ty, "p2"))["clustered"], false);

  // ---- #5721
  const rec = async (value: string, src: string): Promise<string> => {
    const a = (await ac.record({
      subject: { type: ty, id: "p1" },
      predicate: "city",
      value,
      source: { id: `${src}-${uid}`, version: "1" },
      valid_from: 100,
      derivation: { kind: "manual", name: "x", version: "1" },
    })) as { assertion?: { id: string }; id?: string };
    return (a.assertion?.id ?? a.id)!;
  };
  const a1 = await rec("Oslo", "s1");
  const a2 = await rec("Bergen", "s2");
  const rel = (await ac.relate(a1, "contradicts", a2, "different cities", { locator: { pointer: "fixture=1" } })) as {
    relation?: { id: string };
    id?: string;
  };
  await ac.assess(a1, "disputed", "ts sdk", { confidence: 0.4, uncertainty: "source age unknown" });
  const g = await ac.evidenceGraph(a1, { depth: 2, limit: 20 });
  assert.ok(JSON.stringify(g).includes("contradicts"));
  await ac.unrelate((rel.relation?.id ?? rel.id)!, "withdrawn");
  const after = (await ac.evidenceGraph(a1, { depth: 2, limit: 20 })) as { relations: unknown[] };
  assert.deepEqual(after.relations, []);
});
