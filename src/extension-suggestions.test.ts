import { deepEqual, equal, throws } from "node:assert";
import { test } from "node:test";
import { suggestExtensions } from "./extension-suggestions.ts";

test("extension suggestions preserve pack results from the supplied inventory", () => {
  const result = suggestExtensions({ types: [
    { type: "CallRecord", rows: 2 },
    { type: "MsisdnRecord", rows: 0 },
    { type: "Person", rows: 100 },
  ] });
  deepEqual(result.store_types, ["CallRecord", "MsisdnRecord", "Person"]);
  deepEqual(result.extensions[0], {
    pack: "telco",
    relevance: "partial",
    active_types: ["MsisdnRecord", "CallRecord"],
    all_types: ["MsisdnRecord", "CallRecord", "CdrRecord", "ImsiRecord", "TowerDump"],
  });
  equal(result.extensions[1]?.relevance, "no_data");
});

test("extension suggestions validate the list_entity_types response", () => {
  equal(
    suggestExtensions({ types: ["BankAccount", "FinancialTransaction", "CryptoWallet", "AmlAlert", "WireTransferHop"].map((type) => ({ type, rows: 1 })) }).extensions[1]?.relevance,
    "full",
  );
  throws(() => suggestExtensions(null), TypeError);
  throws(() => suggestExtensions({}), TypeError);
  throws(() => suggestExtensions({ types: [{ type: "CallRecord", rows: -1 }] }), TypeError);
});
