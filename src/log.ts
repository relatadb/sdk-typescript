/**
 * Ordered integrity log SDK (#83 — server routes now shipped).
 *
 * Wraps `POST /log/leaf`, `GET /log/leaves`, `GET /log/head`.
 *
 * Server contract:
 * - `POST /log/leaf` body: `{"data_b64": "<base64>"}` →
 *   `201 {"index": u64, "commit_ns": i64}`
 * - `GET /log/leaves?since=<u64>&limit=<n>` →
 *   `200 {"leaves": [...], "count": n}`
 * - `GET /log/head` → `200 {"head": u64}`
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase, qs } from "./_typed-http.ts";

/** A single log leaf entry. */
export interface LogLeaf {
  index: number;
  data: Uint8Array;
  commitNs: number;
}

/** Decode a raw wire leaf into a {@link LogLeaf}. */
async function toLogLeaf(raw: Record<string, unknown>): Promise<LogLeaf> {
  const dataB64 = String(raw["data_b64"] ?? "");
  // Use the runtime's atob — available in Node 16+, Deno, Bun, browsers.
  const data = typeof atob === "function"
    ? Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0))
    : new Uint8Array(await base64ToBytes(dataB64));
  return {
    index: Number(raw["index"] ?? 0),
    data,
    commitNs: Number(raw["commit_ns"] ?? 0),
  };
}

/** @internal Fallback base64 decoder for runtimes without `atob`. */
async function base64ToBytes(b64: string): Promise<ArrayBuffer> {
  // Node 18+ ships atob; this branch is a safety net only.
  const buf = Buffer.from(b64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Ordered integrity-log client. */
export class LogClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): LogClient {
    return new LogClient(TypedClientBase.clientToCtor(client));
  }

  /**
   * Append `data` as a new log leaf.
   * Wraps `POST /log/leaf`. Returns `[index, commitNs]`.
   *
   * The index is strictly monotonic and gap-free under the single-writer
   * model. The server fsyncs the WAL before returning the index.
   */
  async append(data: Uint8Array | string): Promise<[number, number]> {
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data;
    const dataB64 = bytesToBase64(bytes);
    const resp = await this._post<Record<string, unknown>>("/log/leaf", {
      data_b64: dataB64,
    });
    return [Number(resp["index"] ?? 0), Number(resp["commit_ns"] ?? 0)];
  }

  /** Return the current `writeSeq` (the highest committed index). */
  async head(): Promise<number> {
    const resp = await this._get<Record<string, unknown>>("/log/head");
    return Number(resp["head"] ?? 0);
  }

  /**
   * Load leaves in append order.
   * Wraps `GET /log/leaves?since=<u64>&limit=<n>`.
   *
   * @param since  Exclusive lower bound — leaves with `index > since` are
   *               returned.
   * @param limit  Cap on the response size.
   */
  async loadLeaves(
    opts: { since?: number; limit?: number } = {},
  ): Promise<LogLeaf[]> {
    const path = `/log/leaves${qs({
      since: opts.since ?? 0,
      limit: opts.limit ?? 1000,
    })}`;
    const resp = await this._get<Record<string, unknown>>(path);
    const rawLeaves =
      typeof resp === "object" && resp !== null && Array.isArray(resp["leaves"])
        ? resp["leaves"]
        : Array.isArray(resp)
          ? resp
          : [];
    const out: LogLeaf[] = [];
    for (const r of rawLeaves) {
      if (typeof r === "object" && r !== null) {
        out.push(await toLogLeaf(r as Record<string, unknown>));
      }
    }
    return out;
  }
}

/** @internal Base64-encode bytes using the runtime's `btoa` when available. */
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
  }
  // Node fallback (Buffer is Node-only).
  const buf = Buffer.from(bytes);
  return buf.toString("base64");
}
