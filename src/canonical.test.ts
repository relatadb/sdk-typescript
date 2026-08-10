/**
 * Tests for the canonical validation module (#2248 Tier-1).
 *
 * Consumes a vendored copy of the SHARED test-vectors file (`./canonical-vectors.json`,
 * mirrored from `sdks/shared/canonical-vectors.json`) so all four SDKs
 * (Rust/Python/TypeScript/Go) exercise identical valid + reject cases. Vendored
 * rather than read from `sdks/shared` directly because this package is mirrored
 * to a standalone repo (relatadb/sdk-typescript) via `git subtree split`, which
 * drops everything outside `sdks/typescript`. Keep this file in sync with the
 * shared source.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  CanonicalError,
  normalizeEmail,
  normalizeIban,
  normalizeImei,
  normalizeIpv4,
  normalizeIpv6,
  normalizeMsisdn,
  normalizePhone,
  normalizeVin,
  validateEmail,
  validateIban,
  validateIpv6,
} from "./canonical.ts";

const vectorsPath = fileURLToPath(
  new URL("./canonical-vectors.json", import.meta.url),
);
interface Case { input: string; expected: string; }
interface Kind { valid: Case[]; reject: string[]; }
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as Record<string, Kind>;

const normalizers: Record<string, (v: string) => string> = {
  email: normalizeEmail,
  phone: normalizePhone,
  iban: normalizeIban,
  imei: normalizeImei,
  vin: normalizeVin,
  msisdn: normalizeMsisdn,
  ipv4: normalizeIpv4,
  ipv6: normalizeIpv6,
};

for (const kind of Object.keys(normalizers)) {
  test(`canonical vectors — ${kind}`, () => {
    const norm = normalizers[kind]!;
    const vec = vectors[kind]!;
    for (const c of vec.valid) {
      assert.equal(norm(c.input), c.expected, `${kind}: normalize(${c.input})`);
    }
    for (const bad of vec.reject) {
      assert.throws(() => norm(bad), CanonicalError, `${kind}: expected rejection of ${bad}`);
    }
  });
}

test("validate booleans mirror normalize", () => {
  assert.equal(validateEmail("a@b.co"), true);
  assert.equal(validateEmail("bad"), false);
  assert.equal(validateIban("DE89370400440532013000"), true);
  assert.equal(validateIban("GB82WEST12345698765433"), false);
  assert.equal(validateIpv6("::1"), true);
  assert.equal(validateIpv6("1::2::3"), false);
});
