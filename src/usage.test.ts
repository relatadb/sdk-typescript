import assert from "node:assert/strict";
import test from "node:test";
import { recordUsage, type UsageObservation } from "./usage.ts";
import type { EventAppendReceipt, EventAppendRequest } from "./types.ts";

const receipt: EventAppendReceipt = {
  eventId: "evt_test",
  objectType: "DocumentUsageEvent",
  status: "accepted",
  durability: "local_wal_sync",
};

test("recordUsage maps observations to the generic event contract", async () => {
  let captured: EventAppendRequest | undefined;
  const client = {
    async appendEvent(request: EventAppendRequest): Promise<EventAppendReceipt> {
      captured = request;
      return receipt;
    },
  };
  const observation: UsageObservation = {
    idempotencyKey: "answer-42:citation-1",
    target: { object_type: "DocumentSource", key: "report_id", value: "report-42" },
    purpose: "rag-usage",
    cited: false,
    retrieved: true,
    feedbackScore: 0.75,
  };

  assert.equal(await recordUsage(client, observation), receipt);
  assert.deepEqual(captured, {
    object_type: "DocumentUsageEvent",
    idempotency_key: "answer-42:citation-1",
    target: observation.target,
    purpose: "rag-usage",
    attributes: { cited: false, retrieved: true, feedback_score: 0.75 },
  });
});

test("recordUsage requires a stable key and at least one valid observation", async () => {
  let calls = 0;
  const client = {
    async appendEvent(): Promise<EventAppendReceipt> {
      calls += 1;
      return receipt;
    },
  };
  const target = { object_type: "DocumentSource", key: "report_id", value: "report-42" };
  await assert.rejects(() => recordUsage(client, { idempotencyKey: " ", target, cited: true }), /idempotencyKey/);
  await assert.rejects(() => recordUsage(client, {
    idempotencyKey: "é".repeat(129), target, cited: true,
  }), /idempotencyKey/);
  await assert.rejects(() => recordUsage(client, { idempotencyKey: "valid", target }), /at least one/);
  await assert.rejects(() => recordUsage(client, {
    idempotencyKey: "valid", target, feedbackScore: Number.NaN,
  }), /feedbackScore/);
  await assert.rejects(() => recordUsage(client, {
    idempotencyKey: "valid", target, feedbackScore: 1.01,
  }), /feedbackScore/);
  assert.equal(calls, 0);
});
