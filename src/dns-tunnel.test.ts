import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDnsTunnelRows, dnsTunnelDetect } from "./dns-tunnel.ts";

const payloads = [
  "z9q4f8k2m7x1c3v6b0n5h2j8l4p7.exfil.bad.",
  "a1s2d3f4g5h6j7k8l9z0x1c2v3b4.exfil.bad",
  "qwe8rty4uio0pas2dfg6hjk1lzx9.exfil.bad",
  "m4n8b2v6c0x5z3a7s1d9f5g2h6j8.exfil.bad",
  "p3o7i1u5y9t2r6e0w4q8z3x7c1v5.exfil.bad",
  "l9k3j7h1g5f9d3s7a1q5w9e3r7t1.exfil.bad",
];

test("DNS recipe preserves fields, thresholds, precedence, and stable order", () => {
  const findings = analyzeDnsTunnelRows([
    ...payloads.map((query_name) => ({ query_name, qname: "ignored.example" })),
    ...Array.from({ length: 20 }, () => ({ query_name: "www.cdn.example" })),
    { query_name: null, qname: "must-not-fall-through.example" },
  ], 3, 5);
  assert.equal(findings.length, 1);
  assert.deepEqual(Object.keys(findings[0]!), ["domain", "query_count", "avg_entropy", "max_label_len", "confidence"]);
  assert.equal(findings[0]?.domain, "exfil.bad");
  assert.equal(findings[0]?.query_count, 6);
  assert.equal(findings[0]?.max_label_len, 28);
});

test("DNS findings break equal-confidence ties by UTF-8 byte order", () => {
  const findings = analyzeDnsTunnelRows(
    [{ query_name: "a_.example" }, { query_name: "a-.example" }],
    0,
    1,
  );
  assert.deepEqual(findings.map((finding) => finding.domain), ["a-.example", "a_.example"]);
});

test("DNS query composition follows cursor and reports a resumable budget stop", async () => {
  const calls: string[] = [];
  const result = await dnsTunnelDetect(
    async (purpose) => ({ purpose, object_types: ["DnsLog", "Person"] }),
    async (sql) => {
      calls.push(sql);
      if (!sql.includes("AFTER")) {
        return {
          rows: [{ query_name: "a.example.com" }, { query_name: "b.example.com" }],
          queryId: "q1", elapsedMs: 0, rowCount: 2, columns: [], nextCursor: "100:row-id",
        };
      }
      return {
        rows: [{ query_name: "c.example.com" }],
        queryId: "q2", elapsedMs: 0, rowCount: 1, columns: [], nextCursor: "200:row-id",
      };
    },
    { minEntropy: 0, minQueries: 1, pageSize: 2, maxRows: 3 },
  );
  assert.equal(result.complete, false);
  assert.equal(result.incomplete_reason, "max_rows_reached");
  assert.equal(result.rows_scanned, 3);
  assert.deepEqual(result.types_scanned, ["DnsLog"]);
  assert.equal(result.continuation["DnsLog"], "200:row-id");
  assert.equal(result.continuation["remaining_types"], "DnsLog");
  assert.match(calls[0]!, /WITH CACHE BYPASS/u);
  assert.match(calls[1]!, /AFTER '100:row-id'/u);
});

test("DNS query composition never reports a server-truncated page complete", async () => {
  const result = await dnsTunnelDetect(
    async () => ({ purpose: "security", object_types: ["DnsLog"] }),
    async () => ({
      rows: [{ query_name: "a.example.com" }],
      queryId: "q1", elapsedMs: 0, rowCount: 1, columns: [], truncated: true,
    }),
    { pageSize: 2, maxRows: 3 },
  );
  assert.equal(result.complete, false);
  assert.equal(result.incomplete_reason, "server_truncated_page_without_safe_resume_cursor");
});

test("DNS query composition never reports a partial shard response complete", async () => {
  const result = await dnsTunnelDetect(
    async () => ({ purpose: "security", object_types: ["DnsLog"] }),
    async () => ({
      rows: [{ query_name: "a.example.com" }],
      queryId: "q1", elapsedMs: 0, rowCount: 1, columns: [], partial: true,
    }),
    { pageSize: 2, maxRows: 3 },
  );
  assert.equal(result.complete, false);
  assert.equal(result.incomplete_reason, "server_returned_partial_shard_result");
});
