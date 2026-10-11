import type { RelataClient } from "./client.ts";
import type { EventAppendReceipt, EventTarget } from "./types.ts";

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
 * event identity, retries, and any aggregation policy. The target is a logical
 * key/value reference, not a version-pinned snapshot; the current contract has
 * no target-revision field. The server checks the caller's tenant and target
 * visibility and returns only after local WAL sync. It rechecks visibility on
 * exact retries, so a deleted/hidden target returns 404 without appending a
 * second row. Cluster deployments are currently rejected by `/events/append`.
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
