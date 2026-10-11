import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsageEvents, aggregateUsageWithBaseline, recordUsage, type LegacyUsageBaseline, type UsageObservation } from "./usage.ts";
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

const target = { object_type: "DocumentSource", key: "report_id", value: "report-42" } as const;

test("aggregateUsageEvents deduplicates exact IDs and rebuilds former counters", () => {
  const rows = [
    { event_id: "evt-b", target_type: target.object_type, target_id: target.value, observed_at: 20, cited: true, retrieved: true, feedback_score: 0.4 },
    { event_id: "evt-a", target_type: target.object_type, target_id: target.value, observed_at: 10, cited: true, retrieved: true, feedback_score: 0.8 },
    { event_id: "evt-b", target_type: target.object_type, target_id: target.value, observed_at: 20, cited: true, retrieved: true, feedback_score: 0.4 },
    { event_id: "evt-c", target_type: target.object_type, target_id: target.value, observed_at: 30, retrieved: true },
  ];
  const result = aggregateUsageEvents(rows, target);
  assert.deepEqual(result, {
    targetType: "DocumentSource",
    targetId: "report-42",
    eventCount: 3,
    citationCount: 2,
    retrievalCount: 3,
    feedbackCount: 2,
    feedbackAvg: result.feedbackAvg,
    lastCitedAt: "20",
  });
  assert.ok(Math.abs((result.feedbackAvg ?? 0) - 0.6) < 1e-12);
  assert.deepEqual(aggregateUsageEvents([...rows].reverse(), target), result);
});

test("aggregateUsageEvents rejects conflict, cross-target, missing ID, and invalid scores", () => {
  const row = { event_id: "evt-1", target_type: target.object_type, target_id: target.value, observed_at: 10, cited: true };
  assert.throws(() => aggregateUsageEvents([row, { ...row, cited: false }], target), /conflicting/);
  assert.throws(() => aggregateUsageEvents([{ ...row, target_id: "other" }], target), /different target/);
  assert.throws(() => aggregateUsageEvents([{ ...row, event_id: " " }], target), /event_id/);
  assert.throws(() => aggregateUsageEvents([{ ...row, feedback_score: Number.POSITIVE_INFINITY }], target), /feedback_score/);
  assert.throws(() => aggregateUsageEvents([{ ...row, feedback_score: 1.1 }], target), /feedback_score/);
  assert.throws(() => aggregateUsageEvents([{ ...row, observed_at: Number.MAX_SAFE_INTEGER + 1 }], target), /project it as text/);
});

test("aggregateUsageEvents preserves exact modern epoch nanoseconds", () => {
  const base = 1_791_710_000_000_000_000n;
  const rows = [
    { event_id: "evt-later", target_type: target.object_type, target_id: target.value, observed_at: (base + 1n).toString(), cited: true },
    { event_id: "evt-earlier", target_type: target.object_type, target_id: target.value, observed_at: base.toString(), cited: true },
  ];
  assert.equal(aggregateUsageEvents(rows, target).lastCitedAt, (base + 1n).toString());
});

test("aggregateUsageWithBaseline keeps unknown legacy feedback separate", () => {
  const baseline: LegacyUsageBaseline = {
    formatVersion: "document-usage-baseline-v1",
    target,
    cutoverAt: "100",
    citationCount: 8,
    retrievalCount: 12,
    feedbackAvg: 0.6,
    feedbackCount: null,
    lastCitedAt: "90",
  };
  const rows = [{ event_id: "evt-new", target_type: target.object_type, target_id: target.value, observed_at: "101", cited: true, retrieved: true, feedback_score: 0.9 }];
  const result = aggregateUsageWithBaseline(rows, target, baseline);
  assert.equal(result.citationCount, 9);
  assert.equal(result.retrievalCount, 13);
  assert.equal(result.lastCitedAt, "101");
  assert.equal(result.postCutover.feedbackAvg, 0.9);
  assert.equal(result.legacy.feedbackAvg, 0.6);
  assert.equal(result.feedbackCount, null);
  assert.equal(result.feedbackAvg, null);
});

test("aggregateUsageWithBaseline weights only a trusted legacy sample count", () => {
  const result = aggregateUsageWithBaseline(
    [{ event_id: "evt-new", target_type: target.object_type, target_id: target.value, observed_at: "100", feedback_score: 1 }],
    target,
    { formatVersion: "document-usage-baseline-v1", target, cutoverAt: "100", citationCount: 0, retrievalCount: 0, feedbackAvg: 0.5, feedbackCount: 2, lastCitedAt: null },
  );
  assert.equal(result.feedbackCount, 3);
  assert.ok(Math.abs((result.feedbackAvg ?? 0) - 2 / 3) < 1e-12);
});

test("aggregateUsageWithBaseline rejects old events and invalid snapshot versions", () => {
  const baseline: LegacyUsageBaseline = {
    formatVersion: "document-usage-baseline-v1", target, cutoverAt: "100", citationCount: 0,
    retrievalCount: 0, feedbackAvg: null, feedbackCount: null, lastCitedAt: null,
  };
  assert.throws(() => aggregateUsageWithBaseline(
    [{ event_id: "old", target_type: target.object_type, target_id: target.value, observed_at: "99" }],
    target,
    baseline,
  ), /predates/);
  assert.throws(() => aggregateUsageWithBaseline([], target, { ...baseline, formatVersion: "v2" as never }), /formatVersion/);
  assert.throws(() => aggregateUsageWithBaseline([], target, {
    ...baseline, target: { ...target, value: "another-report" },
  }), /different target/);
});
