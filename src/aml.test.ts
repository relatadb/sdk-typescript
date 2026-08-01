/**
 * Tests for the AML typed-decoder module (#2255).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  decodeBeneficialOwners,
  decodeCryptoTrace,
  decodeHawalaPairs,
  decodePathHops,
  decodeResolvedIdentities,
  decodeSanctionsHits,
  decodeWireHops,
} from "./aml.ts";

test("decode sanctions hits", () => {
  const rows = [
    { list_name: "OFAC", entry_id: "e1", matched_field: "name", match_score: 0.95 },
    { list_name: "EU", entry_id: "e2", matched_field: "aliases", match_score: "0.8" },
  ];
  const hits = decodeSanctionsHits(rows);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.list_name, "OFAC");
  assert.ok(Math.abs(hits[1]!.match_score - 0.8) < 1e-9);
});

test("decode sanctions skips rows missing required fields", () => {
  assert.deepEqual(decodeSanctionsHits([{ list_name: "OFAC" }]), []);
});

test("decode beneficial owners", () => {
  const rows = [{ depth: 1, parent_id: "p", child_id: "c", link_type: "owns", ownership_pct: 51.0 }];
  const bos = decodeBeneficialOwners(rows);
  assert.equal(bos.length, 1);
  assert.equal(bos[0]!.ownership_pct, 51.0);
});

test("decode beneficial owners with null pct", () => {
  const rows = [{ depth: 1, parent_id: "p", child_id: "c", link_type: "owns", ownership_pct: null }];
  const bos = decodeBeneficialOwners(rows);
  assert.equal(bos[0]!.ownership_pct, undefined);
});

test("decode crypto trace", () => {
  const rows = [{ hop: 1, from_wallet: "w1", to_wallet: "w2", amount: 0.5, asset: "BTC", chain: "bitcoin" }];
  assert.equal(decodeCryptoTrace(rows)[0]!.to_wallet, "w2");
});

test("decode wire hops", () => {
  const rows = [{ step: 0, from_bank: "b1", to_bank: "b2", amount: 100, currency: "USD", reference: "r1" }];
  assert.equal(decodeWireHops(rows)[0]!.currency, "USD");
});

test("decode hawala pairs", () => {
  const rows = [{ sender: "s", receiver: "r", amount: 200, sender_country: "AE", receiver_country: "IN", ts: "2024-01-01" }];
  assert.equal(decodeHawalaPairs(rows)[0]!.receiver_country, "IN");
});

test("decode resolved identities", () => {
  const rows = [{ _type: "Canonical", _id: "x", identity_value: "x", source: "relata-detect", observed_at: 123, confidence: 1.0 }];
  const ids = decodeResolvedIdentities(rows);
  assert.equal(ids[0]!.id, "x");
  assert.equal(ids[0]!.kind, "Canonical");
});

test("decode path hops", () => {
  const rows = [{ position: 1, node: "a", cost: 0.0 }, { position: 2, node: "b" }];
  const hops = decodePathHops(rows);
  assert.equal(hops.length, 2);
  assert.equal(hops[0]!.cost, 0.0);
  assert.equal(hops[1]!.cost, undefined);
});
