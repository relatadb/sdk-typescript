import type { RelataClient } from "./client.ts";
import type { EventAppendReceipt, EventTarget } from "./types.ts";

/** Projected rows from an authorized query of `DocumentUsageEvent`. */
export interface DocumentUsageEventRow {
  event_id: string;
  target_type: string;
  target_id: string;
  /** Project as decimal text to preserve server i64 nanoseconds exactly. */
  observed_at: string | number | bigint;
  cited?: boolean | null;
  retrieved?: boolean | null;
  feedback_score?: number | null;
}

/** Counts derived only from the supplied, complete governed event inventory. */
export interface UsageAggregate {
  targetType: string;
  targetId: string;
  eventCount: number;
  citationCount: number;
  retrievalCount: number;
  feedbackCount: number;
  feedbackAvg: number | null;
  /** Exact server-owned i64 nanoseconds since epoch; null until a citation. */
  lastCitedAt: string | null;
}

/** Versioned, frozen snapshot of counters captured before event cutover. */
export interface LegacyUsageBaseline {
  formatVersion: "document-usage-baseline-v1";
  target: EventTarget;
  /** Signed i64 nanoseconds, represented losslessly. */
  cutoverAt: string | number | bigint;
  citationCount: number;
  retrievalCount: number;
  feedbackAvg: number | null;
  /** Null unless a trusted external source retained the original sample count. */
  feedbackCount: number | null;
  lastCitedAt: string | number | bigint | null;
}

/** Combined counters with legacy and post-cutover feedback kept distinguishable. */
export interface MigratedUsageAggregate {
  legacy: LegacyUsageBaseline;
  postCutover: UsageAggregate;
  citationCount: number;
  retrievalCount: number;
  feedbackCount: number | null;
  feedbackAvg: number | null;
  lastCitedAt: string | null;
}

function timestampText(value: string | number | bigint): string {
  let timestamp: bigint;
  if (typeof value === "bigint") {
    timestamp = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("observed_at number must be a safe integer; project it as text");
    }
    timestamp = BigInt(value);
  } else {
    if (!/^-?\d+$/.test(value)) throw new TypeError("observed_at must be an integer timestamp");
    timestamp = BigInt(value);
  }
  if (timestamp < -(1n << 63n) || timestamp >= (1n << 63n)) {
    throw new TypeError("observed_at must fit a signed 64-bit timestamp");
  }
  return timestamp.toString();
}

function semanticPayload(row: DocumentUsageEventRow, timestamp: string): string {
  return JSON.stringify([
    row.target_type,
    row.target_id,
    timestamp,
    row.cited ?? false,
    row.retrieved ?? false,
    row.feedback_score ?? null,
  ]);
}

/**
 * Rebuild the former document usage counters from an already-fetched,
 * complete, purpose-governed event inventory. This is a pure reducer: callers
 * must query the optional event type with the same tenant/purpose that
 * governed writes and must detect query truncation before calling it.
 *
 * Exact duplicate event IDs count once; reuse of an ID with different
 * semantic content fails closed. This does not merge legacy feedback means:
 * old rows did not retain `_feedback_n`.
 */
export function aggregateUsageEvents(
  rows: readonly DocumentUsageEventRow[],
  target: EventTarget,
): UsageAggregate {
  if (!target.object_type.trim() || !target.value.trim()) {
    throw new TypeError("target object_type and value are required");
  }
  const unique = new Map<string, { row: DocumentUsageEventRow; timestamp: string; signature: string }>();
  for (const row of rows) {
    if (!row || typeof row.event_id !== "string" || !row.event_id.trim()) {
      throw new TypeError("every usage event must have an event_id");
    }
    if (row.target_type !== target.object_type || row.target_id !== target.value) {
      throw new TypeError("usage inventory contains a different target");
    }
    const timestamp = timestampText(row.observed_at);
    for (const [name, value] of [["cited", row.cited], ["retrieved", row.retrieved]] as const) {
      if (value != null && typeof value !== "boolean") {
        throw new TypeError(`${name} must be boolean when present`);
      }
    }
    if (row.feedback_score != null && (!Number.isFinite(row.feedback_score)
      || row.feedback_score < 0 || row.feedback_score > 1)) {
      throw new TypeError("feedback_score must be finite and between 0 and 1");
    }
    const signature = semanticPayload(row, timestamp);
    const prior = unique.get(row.event_id);
    if (prior) {
      if (prior.signature !== signature) {
        throw new TypeError(`conflicting usage event id ${row.event_id}`);
      }
      continue;
    }
    unique.set(row.event_id, { row, timestamp, signature });
  }

  let citationCount = 0;
  let retrievalCount = 0;
  let feedbackCount = 0;
  let feedbackTotal = 0;
  let lastCitedAt: string | null = null;
  for (const eventId of [...unique.keys()].sort()) {
    const { row, timestamp } = unique.get(eventId)!;
    if (row.cited === true) {
      citationCount += 1;
      if (lastCitedAt === null || BigInt(timestamp) > BigInt(lastCitedAt)) lastCitedAt = timestamp;
    }
    if (row.retrieved === true) retrievalCount += 1;
    if (row.feedback_score != null) {
      feedbackCount += 1;
      feedbackTotal += row.feedback_score;
    }
  }
  return {
    targetType: target.object_type,
    targetId: target.value,
    eventCount: unique.size,
    citationCount,
    retrievalCount,
    feedbackCount,
    feedbackAvg: feedbackCount === 0 ? null : feedbackTotal / feedbackCount,
    lastCitedAt,
  };
}

/**
 * Combine a frozen v1 snapshot with a complete post-cutover event inventory.
 * Old writers must be drained before snapshotting. Events before the cutover
 * are rejected. If the legacy feedback count is unknown, averages stay
 * separate and the combined feedback fields remain null.
 */
export function aggregateUsageWithBaseline(
  rows: readonly DocumentUsageEventRow[],
  target: EventTarget,
  baseline: LegacyUsageBaseline,
): MigratedUsageAggregate {
  if (baseline.formatVersion !== "document-usage-baseline-v1") {
    throw new TypeError("unsupported legacy usage baseline formatVersion");
  }
  if (baseline.target.object_type !== target.object_type
    || baseline.target.key !== target.key || baseline.target.value !== target.value) {
    throw new TypeError("legacy usage baseline belongs to a different target");
  }
  const cutoverAt = BigInt(timestampText(baseline.cutoverAt));
  for (const [name, value] of [["citationCount", baseline.citationCount], ["retrievalCount", baseline.retrievalCount]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  if (baseline.feedbackCount !== null
    && (!Number.isSafeInteger(baseline.feedbackCount) || baseline.feedbackCount < 0)) {
    throw new TypeError("feedbackCount must be a non-negative safe integer or null");
  }
  if (baseline.feedbackAvg !== null && (!Number.isFinite(baseline.feedbackAvg)
    || baseline.feedbackAvg < 0 || baseline.feedbackAvg > 1)) {
    throw new TypeError("feedbackAvg must be finite and between 0 and 1");
  }
  if (baseline.feedbackCount === 0 && baseline.feedbackAvg !== null) {
    throw new TypeError("feedbackAvg must be null when feedbackCount is zero");
  }
  if (baseline.feedbackCount !== null && baseline.feedbackCount > 0 && baseline.feedbackAvg === null) {
    throw new TypeError("feedbackAvg is required when feedbackCount is positive");
  }
  const combinedCitationCount = baseline.citationCount;
  const combinedRetrievalCount = baseline.retrievalCount;
  const postCutover = aggregateUsageEvents(rows, target);
  for (const row of rows) {
    if (BigInt(timestampText(row.observed_at)) < cutoverAt) {
      throw new TypeError("usage event predates the baseline cutover");
    }
  }
  let feedbackCount: number | null = null;
  let feedbackAvg: number | null = null;
  if (baseline.feedbackCount !== null) {
    feedbackCount = baseline.feedbackCount + postCutover.feedbackCount;
    if (!Number.isSafeInteger(feedbackCount)) throw new TypeError("combined feedbackCount exceeds the safe integer range");
    const total = (baseline.feedbackCount * (baseline.feedbackAvg ?? 0))
      + (postCutover.feedbackCount * (postCutover.feedbackAvg ?? 0));
    feedbackAvg = feedbackCount === 0 ? null : total / feedbackCount;
  }
  const legacyLastCited = baseline.lastCitedAt === null
    ? null
    : timestampText(baseline.lastCitedAt);
  const lastCitedAt = legacyLastCited === null
    ? postCutover.lastCitedAt
    : postCutover.lastCitedAt === null || BigInt(legacyLastCited) > BigInt(postCutover.lastCitedAt)
      ? legacyLastCited
      : postCutover.lastCitedAt;
  const citationCount = combinedCitationCount + postCutover.citationCount;
  const retrievalCount = combinedRetrievalCount + postCutover.retrievalCount;
  if (!Number.isSafeInteger(citationCount) || !Number.isSafeInteger(retrievalCount)) {
    throw new TypeError("combined usage count exceeds the safe integer range");
  }
  return {
    legacy: baseline,
    postCutover,
    citationCount,
    retrievalCount,
    feedbackCount,
    feedbackAvg,
    lastCitedAt,
  };
}

/** One caller-supplied observation for the optional `document-usage` package. */
export interface UsageObservation {
  /** Stable across retries; the application chooses its event identity. */
  idempotencyKey: string;
  /** Logical target reference checked for visibility when the event is appended. */
  target: EventTarget;
  purpose?: string;
  cited?: boolean;
  retrieved?: boolean;
  /** The optional package constrains this score to the inclusive range [0, 1]. */
  feedbackScore?: number;
}

/**
 * Record one immutable document-usage observation through the generic event API.
 *
 * Install the optional `document-usage` schema package first. The caller owns
 * event identity and retries; this module provides a separate reducer for a
 * complete governed inventory. The target is a logical
 * key/value reference, not a version-pinned snapshot; the current contract has
 * no target-revision field. The server checks the caller's tenant and target
 * visibility and returns only after local WAL sync. It rechecks visibility on
 * exact retries, so a deleted/hidden target returns 404 without appending a
 * second row. Cluster deployments are currently rejected by `/v1/ingest/events`.
 */
export async function recordUsage(
  client: Pick<RelataClient, "appendEvent">,
  observation: UsageObservation,
): Promise<EventAppendReceipt> {
  if (!observation.idempotencyKey.trim()
    || new TextEncoder().encode(observation.idempotencyKey).length > 256) {
    throw new TypeError("idempotencyKey must contain 1 to 256 non-whitespace UTF-8 bytes");
  }
  const attributes: Record<string, unknown> = {};
  if (observation.cited !== undefined) attributes["cited"] = observation.cited;
  if (observation.retrieved !== undefined) attributes["retrieved"] = observation.retrieved;
  if (observation.feedbackScore !== undefined) {
    if (!Number.isFinite(observation.feedbackScore)
      || observation.feedbackScore < 0
      || observation.feedbackScore > 1) {
      throw new RangeError("feedbackScore must be finite and between 0 and 1");
    }
    attributes["feedback_score"] = observation.feedbackScore;
  }
  if (Object.keys(attributes).length === 0) {
    throw new TypeError("at least one usage observation must be supplied");
  }
  return client.appendEvent({
    object_type: "DocumentUsageEvent",
    idempotency_key: observation.idempotencyKey,
    target: observation.target,
    ...(observation.purpose === undefined ? {} : { purpose: observation.purpose }),
    attributes,
  });
}
