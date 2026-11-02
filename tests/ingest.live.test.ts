/**
 * Ingestion-contract run through the TypeScript SDK against a live server
 * (#5689, #5742, #5743). Mirrors scripts/sdk_ingest_e2e.py: idempotent typed
 * bulk with a durable source checkpoint, retry/conflict behaviour, upsert, CSV
 * text, a contract with quarantine, and prepared document rows from the shared
 * two-provider fixture read back in order.
 *
 * Skips unless RELATA_TOKEN (a registry data token) is set. Run:
 * scripts/sdk_ingest_live.sh (needs a running server), or
 * `node --experimental-strip-types --test tests/ingest.live.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RelataClient, IngestClient, IngestControlClient } from "../src/index.ts";

const BASE = process.env.RELATA_HOST || "http://localhost:9090";
const DATA = process.env.RELATA_TOKEN;
const FIXTURES = new URL("../../contract-tests/fixtures/", import.meta.url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function statusOf(err: unknown): number {
  return (err as { statusCode?: number })?.statusCode ?? 0;
}

test("ingestion contract live run", { skip: !DATA }, async () => {
  const client = new RelataClient({ baseUrl: BASE, bearerToken: DATA, defaultPurpose: "investigation" });
  const ingest = IngestClient.fromClient(client);
  const control = IngestControlClient.fromClient(client);
  const run = String(Date.now());
  const rows = async (sql: string): Promise<Array<Record<string, unknown>>> =>
    (await client.query(sql, { purpose: "investigation" })).rows as Array<Record<string, unknown>>;
  const waitRows = async (sql: string, want: number) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const got = await rows(sql);
      if (got.length >= want || Date.now() > deadline) return got;
      await sleep(100);
    }
  };

  const ty = `TsIng${run}`;
  const key = `ts-batch-${run}`;
  const source = `ts/source-${run}`;
  const batch = [
    { _pk: "a", qty: 3, note: null, wide: "9007199254740993" },
    { _pk: "b", qty: 4, note: "x", wide: "12345678901234567890.123" },
  ];
  const cp = { source, position: "10", expected_position: "" };

  // 1. idempotent, synchronous, checkpointed bulk
  const r1 = await ingest.bulk(ty, batch, { idempotencyKey: key, durability: "sync", sourceCheckpoint: cp });
  assert.equal(r1["inserted"], 2);
  assert.equal((r1["source_checkpoint"] as Record<string, unknown>)["advanced"], true);
  const got = await rows(`SELECT _pk, note, wide FROM ${ty}`);
  const a = got.find((r) => r["_pk"] === "a");
  assert.ok(a && a["note"] === null && a["wide"] === "9007199254740993", "null and exact text survive");

  // 2. retry replays the recorded response, writes nothing
  const r2 = await ingest.bulk(ty, batch, { idempotencyKey: key, durability: "sync", sourceCheckpoint: cp });
  assert.equal(r2["idempotent_replay"], true);
  assert.equal(r2["inserted"], 2);
  assert.equal((await rows(`SELECT _pk FROM ${ty}`)).length, 2);

  // 3. same key, different body
  await assert.rejects(
    ingest.bulk(ty, [{ _pk: "a", qty: 99 }], { idempotencyKey: key, durability: "sync" }),
    (e) => statusOf(e) === 409,
  );

  // 4. stale compare-and-set checkpoint
  await assert.rejects(
    ingest.bulk(ty, [{ _pk: "c", qty: 1 }], {
      durability: "sync",
      onConflict: "upsert",
      sourceCheckpoint: { source, position: "11", expected_position: "5" },
    }),
    (e) => statusOf(e) === 409,
  );
  assert.equal((await rows(`SELECT _pk FROM ${ty}`)).length, 2, "refused batch wrote nothing");
  assert.equal((await control.checkpoint(source))["position"], "10");

  // 5. upsert supersedes in place
  const r5 = await ingest.bulk(ty, [{ _pk: "b", qty: 40, note: "y" }], { onConflict: "upsert", durability: "sync" });
  const live = await rows(`SELECT _pk, qty FROM ${ty} WHERE _pk = 'b'`);
  assert.equal(r5["updated"], 1);
  assert.equal(live.length, 1);
  assert.equal(live[0]["qty"], 40);

  // 6. CSV text is stored as the exact source text
  const csvTy = `TsCsv${run}`;
  await ingest.bulkCsv(csvTy, readFileSync(new URL("structured-ingest-q03.csv", FIXTURES), "utf8"));
  const csv = await waitRows(`SELECT * FROM ${csvTy}`, 1);
  assert.equal(csv.length, 1);
  assert.equal(String(csv[0]["exact_int64"]), "9007199254740993");
  assert.equal(String(csv[0]["decimal_text"]), "12345678901234567890.12345678901234567890");

  // 7. contract + quarantine = explicit partial acceptance
  const dataset = `tsreadings${run}`;
  const cty = `TsReading${run}`;
  await control.putContract(dataset, {
    version: 1,
    object_type: cty,
    fields: [
      { name: "id", type: "string", required: true },
      { name: "temp", type: "number", min: -50, max: 150, required: true },
    ],
  });
  const rc = await ingest.bulk(
    cty,
    [
      { _pk: "r1", id: "r1", temp: 20.5, _source_offset: "seg:0" },
      { _pk: "r2", id: "r2", temp: 999, _source_offset: "seg:1" },
    ],
    { contract: { dataset } },
  );
  const c = rc["contract"] as Record<string, unknown>;
  assert.equal(c["accepted"], 1);
  assert.equal(c["quarantined"], 1);
  const items = (await control.listQuarantine({ dataset }))["items"] as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0]["source_offset"], "seg:1");
  assert.equal(items[0]["reason"], "above_max:temp");

  // 8. prepared documents, two independent providers, read back in order
  const fixture = JSON.parse(readFileSync(new URL("document-ingest-preservation.json", FIXTURES), "utf8"));
  for (const provider of fixture.providers as Array<{ name: string; objects: Array<Record<string, unknown>> }>) {
    const remap = new Map<string, string>();
    for (const o of provider.objects) {
      for (const f of ["_pk", "chunk_id", "report_id", "node_id"]) {
        const v = o[f];
        if (typeof v === "string" && !remap.has(v)) remap.set(v, `${v}@${run}`);
      }
    }
    const fix = (v: unknown): unknown => {
      if (typeof v === "string") {
        for (const [old, next] of remap) {
          if (v === old || v.startsWith(`${old}:`) || v.startsWith(`${old}::`)) return next + v.slice(old.length);
        }
        return v;
      }
      return Array.isArray(v) ? v.map(fix) : v;
    };
    const objs = provider.objects.map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fix(v)])));
    const resp = await client.ingestDocument(objs, "investigation");
    let task = await client.ingestDocumentStatus(resp.taskId);
    for (let i = 0; i < 200 && (task.status === "pending" || task.status === "queued"); i++) {
      await sleep(100);
      task = await client.ingestDocumentStatus(resp.taskId);
    }
    assert.equal(task.taskId, resp.taskId, `${provider.name}: task_id preserved`);
    assert.equal(task.status, "complete", `${provider.name}: ${JSON.stringify(task)}`);
    assert.equal(task.rowsWritten, objs.length);
    assert.equal(task.rowsDropped, 0);
    const want = objs
      .filter((o) => o["_type"] === "DocumentChunk")
      .sort((x, y) => Number(x["sequence_index"]) - Number(y["sequence_index"]));
    const report = want[0]["report_id"];
    const chunks = await waitRows(
      `SELECT chunk_id, sequence_index, prev_chunk_id, next_chunk_id, page_start FROM DocumentChunk WHERE report_id = '${report}' ORDER BY sequence_index`,
      want.length,
    );
    assert.deepEqual(chunks.map((g) => g["chunk_id"]), want.map((w) => w["chunk_id"]), `${provider.name}: chunk order`);
    assert.deepEqual(
      chunks.map((g) => [g["prev_chunk_id"], g["next_chunk_id"]]),
      want.map((w) => [w["prev_chunk_id"], w["next_chunk_id"]]),
      `${provider.name}: neighbor links`,
    );
    assert.deepEqual(chunks.map((g) => g["page_start"]), want.map((w) => w["page_start"]));
  }
});
