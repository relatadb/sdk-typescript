/** Optional application-side DNS tunnel triage over governed query pages. */
import type { QueryResult } from "./types.ts";

export const DNS_TUNNEL_TYPES = ["DnsLog", "DnsQuery", "DnsEvent"] as const;
export const DNS_TUNNEL_COLUMNS = ["domain", "query_count", "avg_entropy", "max_label_len", "confidence"] as const;
export const DNS_TUNNEL_PAGE_SIZE = 1_000;
export const DNS_TUNNEL_MAX_ROWS = 100_000;

export interface DnsTunnelOptions {
  minEntropy?: number;
  minQueries?: number;
  purpose?: string;
  pageSize?: number;
  maxRows?: number;
}

export interface DnsTunnelFinding {
  domain: string;
  query_count: number;
  avg_entropy: number;
  max_label_len: number;
  confidence: number;
}

export interface DnsTunnelResult {
  columns: string[];
  rows: DnsTunnelFinding[];
  /** Candidate DNS types exposed by the caller's `/v1/query/schema` response. */
  types_scanned: string[];
  rows_scanned: number;
  complete: boolean;
  continuation: Record<string, string>;
  incomplete_reason?: string;
}

type QuerySchema = (purpose: string) => Promise<{ object_types: string[] }>;
type Query = (sql: string, options: { purpose: string }) => Promise<QueryResult<Record<string, unknown>>>;

function entropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  let chars = 0;
  for (const char of value) {
    chars += 1;
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let total = 0;
  for (const count of counts.values()) {
    const p = count / chars;
    total -= p * Math.log2(p);
  }
  return total;
}

function queryName(row: Record<string, unknown>): string | undefined {
  for (const field of ["query_name", "qname", "domain", "name"]) {
    if (Object.hasOwn(row, field)) {
      const value = row[field];
      return typeof value === "string" ? value : undefined;
    }
  }
  return undefined;
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

export function analyzeDnsTunnelRows(
  rows: Iterable<Record<string, unknown>>,
  minEntropy = 3,
  minQueries = 5,
): DnsTunnelFinding[] {
  const domains = new Map<string, { entropySum: number; labelCount: number; count: number; maxLen: number }>();
  for (const row of rows) {
    const raw = queryName(row);
    if (raw === undefined) continue;
    const name = raw.replace(/\.+$/u, "").toLowerCase();
    if (!name) continue;
    const labels = name.split(".").filter(Boolean);
    if (!labels.length) continue;
    const domain = labels.length >= 2 ? labels.slice(-2).join(".") : labels[0]!;
    const sublabels = labels.length > 2 ? labels.slice(0, -2) : [];
    const item = domains.get(domain) ?? { entropySum: 0, labelCount: 0, count: 0, maxLen: 0 };
    item.count += 1;
    for (const label of sublabels) {
      item.entropySum += entropy(label);
      item.labelCount += 1;
      item.maxLen = Math.max(item.maxLen, new TextEncoder().encode(label).length);
    }
    domains.set(domain, item);
  }
  const result: DnsTunnelFinding[] = [];
  for (const [domain, item] of domains) {
    if (item.count < minQueries) continue;
    const avg = item.labelCount ? item.entropySum / item.labelCount : 0;
    if (avg < minEntropy) continue;
    const entropyScore = Math.max(0, Math.min(0.6, (avg - minEntropy) * 0.25));
    const lenScore = Math.max(0, Math.min(0.4, (item.maxLen - 20) / 43));
    result.push({
      domain,
      query_count: item.count,
      avg_entropy: avg,
      max_label_len: item.maxLen,
      confidence: Math.max(0, Math.min(1, 0.4 + entropyScore + lenScore)),
    });
  }
  // Match Rust's String ordering by UTF-8 bytes, independent of host locale.
  result.sort((a, b) => b.confidence - a.confidence || compareUtf8(a.domain, b.domain));
  return result;
}

/** Compose the legacy triage outcome from ACL-filtered names and ordinary SQL reads. */
export async function dnsTunnelDetect(
  querySchema: QuerySchema,
  query: Query,
  options: DnsTunnelOptions = {},
): Promise<DnsTunnelResult> {
  const minEntropy = options.minEntropy ?? 3;
  const minQueries = options.minQueries ?? 5;
  const purpose = options.purpose ?? "security";
  const pageSize = Math.min(options.pageSize ?? DNS_TUNNEL_PAGE_SIZE, 10_000);
  const maxRows = options.maxRows ?? DNS_TUNNEL_MAX_ROWS;
  if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(maxRows) || maxRows < 1) {
    throw new RangeError("pageSize and maxRows must be positive integers");
  }
  const schema = await querySchema(purpose);
  if (!schema || !Array.isArray(schema.object_types) || schema.object_types.some((item) => typeof item !== "string")) {
    throw new TypeError("query_schema result must contain an object_types array");
  }
  const types = DNS_TUNNEL_TYPES.filter((name) => schema.object_types.includes(name));
  const rows: Record<string, unknown>[] = [];
  const continuation: Record<string, string> = {};
  let rowsScanned = 0;
  let complete = true;
  let incompleteReason: string | undefined;
  for (let typeIndex = 0; typeIndex < types.length; typeIndex += 1) {
    const objectType = types[typeIndex]!;
    let cursor: string | null = null;
    const seen = new Set<string>();
    while (true) {
      const remaining = maxRows - rowsScanned;
      if (remaining <= 0) {
        complete = false;
        incompleteReason = "max_rows_reached";
        break;
      }
      const limit = Math.min(pageSize, remaining);
      const after = cursor === null ? "" : ` AFTER '${cursor.replaceAll("'", "''")}'`;
      const page = await query(
        `SELECT * FROM ${objectType} LIMIT ${limit}${after} WITH CACHE BYPASS`,
        { purpose },
      );
      rows.push(...page.rows);
      rowsScanned += page.rows.length;
      if (page.partial) {
        complete = false;
        incompleteReason = "server_returned_partial_shard_result";
        break;
      }
      if (page.truncated) {
        complete = false;
        incompleteReason = "server_truncated_page_without_safe_resume_cursor";
        break;
      }
      const nextCursor = page.nextCursor;
      if (typeof nextCursor === "string") {
        if (!nextCursor || nextCursor === cursor || seen.has(nextCursor)) {
          complete = false;
          incompleteReason = "pagination_cursor_did_not_advance";
          continuation[objectType] = nextCursor;
          break;
        }
        seen.add(nextCursor);
      } else if (page.rows.length === limit && nextCursor === undefined) {
        complete = false;
        incompleteReason = "server_did_not_return_pagination_metadata";
        break;
      }
      if (nextCursor == null) break;
      if (rowsScanned >= maxRows) {
        complete = false;
        incompleteReason = "max_rows_reached";
        continuation[objectType] = nextCursor;
        break;
      }
      cursor = nextCursor;
    }
    if (!complete) {
      continuation["remaining_types"] = types.slice(typeIndex).join(",");
      break;
    }
  }
  return {
    columns: [...DNS_TUNNEL_COLUMNS],
    rows: analyzeDnsTunnelRows(rows, minEntropy, minQueries),
    types_scanned: [...types],
    rows_scanned: rowsScanned,
    complete,
    continuation,
    ...(incompleteReason ? { incomplete_reason: incompleteReason } : {}),
  };
}
