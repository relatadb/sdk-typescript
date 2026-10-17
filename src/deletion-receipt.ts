import { readCappedResponseBody } from "./_body.ts";
import { DEFAULT_MAX_RESPONSE_BYTES } from "./client.ts";
import { ResponseTooLargeError } from "./errors.ts";

/** Receipt-only JSON values: every integer token is exact decimal text. */
export type ExactReceiptValue = string | boolean | null | ExactReceiptValue[] | { [key: string]: ExactReceiptValue };
/** Opt-in decoding does not authenticate a receipt or establish completion. */
export type ExactDeletionProgress = { [key: string]: ExactReceiptValue } & {
  version: "1";
  operation_id: string;
  revision: string;
  scope: "observed_local_source_versions";
  global_copy_inventory: "incomplete";
  global_physical_erasure_verified: false;
};

function checkCap(cap: number): void {
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new RangeError("Receipt response cap must be a positive safe integer");
}

/**
 * Decode ORIGINAL deletion-inspection JSON, never an already rounded object.
 * All integer tokens, including version/counts, become decimal strings.
 * Existing SDK query/erasure methods retain their ordinary number semantics.
 * Requires JSON.parse reviver context.source support; otherwise fails closed.
 */
export function decodeDeletionProgress(raw: string | Uint8Array, maxBytes = DEFAULT_MAX_RESPONSE_BYTES): ExactDeletionProgress {
  checkCap(maxBytes);
  if (typeof raw === "string" && raw.length > maxBytes) throw new ResponseTooLargeError(maxBytes);
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  if (bytes.byteLength > maxBytes) throw new ResponseTooLargeError(maxBytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  type ParseWithSource = (text: string, reviver: (this: object, key: string, value: unknown, context?: { source?: string }) => unknown) => unknown;
  const parse = JSON.parse as unknown as ParseWithSource;
  const numericKeys = new WeakMap<object, Set<string>>();
  const decoded = parse(text, function (key, value, context) {
    if (typeof value !== "number") return value;
    const source = context?.source;
    if (!source) throw new Error("Exact receipt decoding requires JSON.parse reviver context.source support");
    if (!/^-?(0|[1-9]\d*)$/.test(source)) throw new Error("Deletion receipt numbers must be integer tokens");
    if (source.length > 21 || BigInt(source) < -(1n << 63n) || BigInt(source) > (1n << 64n) - 1n) {
      throw new Error("Deletion receipt integer exceeds supported i64/u64 range");
    }
    let keys = numericKeys.get(this);
    if (!keys) { keys = new Set<string>(); numericKeys.set(this, keys); }
    keys.add(key);
    return source;
  });
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Expected a deletion progress receipt");
  const receipt = decoded as Record<string, unknown>;
  if (receipt["version"] !== "1" || !numericKeys.get(receipt)?.has("version")
      || !numericKeys.get(receipt)?.has("revision") || typeof receipt["revision"] !== "string" || receipt["revision"].startsWith("-")
      || typeof receipt["operation_id"] !== "string"
      || receipt["scope"] !== "observed_local_source_versions"
      || receipt["global_copy_inventory"] !== "incomplete"
      || receipt["global_physical_erasure_verified"] !== false) {
    throw new Error("Unsupported deletion progress receipt envelope");
  }
  return decoded as ExactDeletionProgress;
}

/** Decode an existing HTTP response with the SDK's shared capped body reader. */
export async function decodeDeletionProgressResponse(response: Response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES): Promise<ExactDeletionProgress> {
  checkCap(maxBytes);
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Expected a successful JSON deletion progress response");
  }
  return decodeDeletionProgress(await readCappedResponseBody(response, maxBytes), maxBytes);
}
