import {
  aggregateUsageEvents,
  aggregateUsageWithBaseline,
  createClient,
  recordUsage,
  type DocumentUsageEventRow,
  type LegacyUsageBaseline,
} from "../src/index.ts";
import { createExactUsageFetch } from "../src/usage-precision.ts";

// Install packages/ontology/v1/document-usage.json and grant this tenant
// permission to append DocumentUsageEvent before running the example.
const bearerToken = process.env["RELATA_BEARER_TOKEN"];
const tenant = process.env["RELATA_TENANT"];
if (!tenant) throw new Error("Set RELATA_TENANT to the destination tenant ID");
const targetId = process.env["RELATA_USAGE_TARGET_ID"] ?? "report-42";
const idempotencyKey = process.env["RELATA_USAGE_IDEMPOTENCY_KEY"] ?? "answer-42:citation-1";

const client = createClient(process.env["RELATA_URL"] ?? "http://localhost:9090", {
  ...(bearerToken ? { bearerToken } : {}),
  tenant,
  fetch: createExactUsageFetch(),
});

const receipt = await recordUsage(client, {
  // Keep this key stable if the request is retried after a lost response.
  idempotencyKey,
  target: { object_type: "DocumentSource", key: "report_id", value: targetId },
  purpose: "rag-usage",
  cited: true,
  retrieved: true,
  feedbackScore: 0.9,
});

// The token also needs read permission for DocumentUsageEvent. This bounded
// governed inventory query is intentionally fail-closed at the cap so an
// incomplete result is never presented as complete counters.
const eventLimit = 10_000;
const events = await client.query<DocumentUsageEventRow>(
  "SELECT event_id, target_type, target_id, observed_at, cited, retrieved, feedback_score " +
    "FROM DocumentUsageEvent WHERE target_type = 'DocumentSource' " +
    `AND target_id = '${targetId.replaceAll("'", "''")}' LIMIT 10000`,
  { purpose: "rag-usage" },
);
if (events.rowCount >= eventLimit) {
  throw new Error(`Usage event inventory reached the ${eventLimit} row cap; paginate before aggregation`);
}
const summary = aggregateUsageEvents(events.rows, {
  object_type: "DocumentSource",
  key: "report_id",
  value: targetId,
});
const target = { object_type: "DocumentSource", key: "report_id", value: targetId } as const;
// Synthetic pre-cutover state for demonstrating the versioned reducer. Real
// applications load this record from their governed migration export.
const baseline: LegacyUsageBaseline = {
  formatVersion: "document-usage-baseline-v1",
  target,
  cutoverAt: "0",
  citationCount: 7,
  retrievalCount: 11,
  feedbackAvg: 0.6,
  feedbackCount: null,
  lastCitedAt: null,
};
const migrated = aggregateUsageWithBaseline(events.rows, target, baseline);
const trustedMigrated = aggregateUsageWithBaseline(events.rows, target, {
  ...baseline,
  feedbackCount: 2,
});
let wrongTargetRejected = false;
try {
  aggregateUsageWithBaseline(events.rows, target, {
    ...baseline,
    target: { ...target, value: "other" },
  });
} catch {
  wrongTargetRejected = true;
}
console.log(JSON.stringify({
  receipt: { event_id: receipt.eventId, status: receipt.status, durability: receipt.durability },
  summary: {
    target_type: summary.targetType,
    target_id: summary.targetId,
    event_count: summary.eventCount,
    citation_count: summary.citationCount,
    retrieval_count: summary.retrievalCount,
    feedback_count: summary.feedbackCount,
    feedback_avg: summary.feedbackAvg,
    last_cited_at_ns: summary.lastCitedAt,
  },
  migration: {
    baseline_format_version: migrated.legacy.formatVersion,
    citation_count: migrated.citationCount,
    retrieval_count: migrated.retrievalCount,
    legacy_feedback_avg: migrated.legacy.feedbackAvg,
    post_cutover_feedback_avg: migrated.postCutover.feedbackAvg,
    feedback_count: migrated.feedbackCount,
    feedback_avg: migrated.feedbackAvg,
    trusted_feedback_count: trustedMigrated.feedbackCount,
    trusted_feedback_avg: trustedMigrated.feedbackAvg,
    wrong_target_rejected: wrongTargetRejected,
  },
}));
await client.close();
