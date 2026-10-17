/** Client for the optional RIFN feed broker service. */

import { TypedClientBase } from "./_typed-http.ts";

/** Publisher-side RIFN entry. The broker validates its signature and fields. */
export interface FeedEntry extends Record<string, unknown> {
  entry_id: string;
  channel: string;
  publisher_id: string;
  published_at: string;
  valid_from: string;
  valid_to?: string | null;
  tlp: "WHITE" | "GREEN" | "AMBER" | "RED";
  confidence: number;
  payload_kind: string;
  payload: unknown;
  publisher_signature: string;
}

/** Options for a client explicitly connected to a feed broker URL. */
export interface FeedBrokerClientOptions {
  bearerToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  extraHeaders?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  maxResponseBytes?: number;
}

/**
 * Client for RIFN broker HTTP endpoints. Construct it with the broker URL,
 * which is separate from the Relata database URL. It intentionally has no
 * `fromClient` helper because the broker is an optional external service.
 */
export class FeedBrokerClient extends TypedClientBase {
  constructor(brokerUrl: string, options: FeedBrokerClientOptions = {}) {
    super({ ...options, baseUrl: brokerUrl });
  }

  /** Broker liveness and capacity counters. */
  async health(): Promise<Record<string, unknown>> {
    return this._get("/feed/health");
  }

  /** Public feed channel list. */
  async channels(): Promise<Record<string, unknown>[]> {
    return this._get<Record<string, unknown>[]>("/feed/channels");
  }

  /** Publish a signed candidate; durable mode acknowledges manifest selection.
   * Exact replay preserves its original stamp; changed metadata conflicts.
   * Storage failures can be uncertain. This POST is not automatically retried.
   */
  async publish(
    publisherDid: string,
    entry: FeedEntry,
  ): Promise<Record<string, unknown>> {
    if (!publisherDid.trim()) throw new TypeError("publisherDid is required");
    return this._postWithHeaders("/feed/publish", entry, {
      "X-Publisher-Did": publisherDid,
    });
  }
}
