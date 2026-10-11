import { deepEqual, equal, throws } from "node:assert";
import { test } from "node:test";
import { summarizeDomain } from "./domain-summary.ts";

test("domain summary composes the tenant-visible type inventory locally", () => {
  const result = summarizeDomain("financial", {
    types: [
      { type: "FinancialTransaction", rows: 7 },
      { type: "BankAccount", rows: 2 },
      { type: "Person", rows: 1000 },
    ],
  });
  equal(result.domain, "financial");
  deepEqual(result.summaries[0]!.types.slice(0, 2), [
    { type: "BankAccount", rows: 2 },
    { type: "FinancialTransaction", rows: 7 },
  ]);
  equal(result.summaries[0]!.total_rows, 9);
  equal(result.summaries[0]!.suggested_queries.length, 3);
});

test("domain summary supports all profiles and rejects invalid inventory", () => {
  equal(summarizeDomain("all", { types: [] }).summaries.length, 9);
  throws(() => summarizeDomain("other", { types: [] }), RangeError);
  throws(() => summarizeDomain("telco", { types: [{ type: "CallRecord", rows: -1 }] }), TypeError);
});
