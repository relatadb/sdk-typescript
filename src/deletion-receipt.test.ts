import assert from "node:assert/strict";
import test from "node:test";
import { decodeDeletionProgress, decodeDeletionProgressResponse } from "./deletion-receipt.ts";
import { RelataClient } from "./client.ts";
import { ResponseTooLargeError } from "./errors.ts";

const wire = `{"version":1,"operation_id":"operation","scope":"observed_local_source_versions","global_copy_inventory":"incomplete","global_physical_erasure_verified":false,"revision":18446744073709551615,"sources":[{"system_from":9223372036854775806,"closed_at_ns":9223372036854775807}],"peers":[{"receipt":{"revision":18446744073709551615,"updated_ns":1791710000000000001}}],"known_backup_copies":[{"removal_receipt":{"attempted_at_ns":1791710000000000001,"removed_at_ns":1791710000000000003}}],"text":"9223372036854775806"}`;

test("raw receipt decoder preserves nested i64/u64 digits as decimal text", () => {
  const receipt = decodeDeletionProgress(wire);
  assert.equal(receipt.version, "1");
  assert.equal(receipt["revision"], "18446744073709551615");
  const serialized = JSON.stringify(receipt);
  for (const token of ["9223372036854775806", "9223372036854775807", "18446744073709551615", "1791710000000000001", "1791710000000000003"]) {
    assert.ok(serialized.includes(`"${token}"`));
  }
  assert.equal(receipt["text"], "9223372036854775806");
});

test("receipt decoder rejects unsupported parsing, malformed numbers and envelopes", () => {
  for (const raw of [wire.replace("18446744073709551615", "18446744073709551616"), wire.replace('"version":1', '"version":1.0'), "{}", wire + "{}"])
    assert.throws(() => decodeDeletionProgress(raw));
  const original = JSON.parse;
  try {
    JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown) =>
      original(text, reviver ? function (key, value) { return reviver(key, value); } : undefined)) as typeof JSON.parse;
    assert.throws(() => decodeDeletionProgress(wire), /context.source/);
  } finally { JSON.parse = original; }
});

test("raw and streamed receipt limits reject oversized input and cancel", async () => {
  assert.throws(() => decodeDeletionProgress(wire, 8), ResponseTooLargeError);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(9)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(decodeDeletionProgressResponse(new Response(body, { headers: { "content-type": "application/json", "content-length": "1" } }), 8), ResponseTooLargeError);
  assert.equal(cancelled, true);
});

test("existing generic erasure decoding retains ordinary JSON numbers", async () => {
  const client = new RelataClient({ baseUrl: "http://receipt-test", fetch: async () => new Response(wire, { headers: { "content-type": "application/json" } }) });
  const generic = await client.eraseSubject("fixture", "test");
  assert.equal(typeof generic["revision"], "number");
  assert.equal(decodeDeletionProgress(wire)["revision"], "18446744073709551615");
});
