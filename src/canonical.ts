/**
 * Client-side canonical validation — Tier-1 set (#2248).
 *
 * Pure, dependency-free validators + normalisers for the eight Tier-1
 * canonical identifier kinds, ported from `crates/relata-canonical/src/`
 * (`email`, `phone`, `iban`, `imei`, `vin`, `msisdn`, `ipv4`, `ipv6`).
 *
 * These run **client-side** with no server round-trip — deterministic
 * checksum/format checks that let callers reject obviously bad input before it
 * hits the wire. The server's `relata-canonical` crate remains the authority;
 * this module mirrors its logic so both sides agree.
 *
 * Two functions per kind:
 * - `validate<Kind>(value): boolean`
 * - `normalize<Kind>(value): string`  (throws {@link CanonicalError} on reject)
 *
 * Test vectors are shared across all four SDKs from
 * `sdks/shared/canonical-vectors.json`.
 *
 * Scope: Tier-1 only (8 of ~76 canonical kinds). The remaining 65 kinds stay
 * server-side; typing them client-side is the remaining scope of #2248.
 */

/** A canonical-validation failure. Carries a machine-friendly `kind` tag. */
export class CanonicalError extends Error {
  /** Machine-friendly tag (`"empty"`, `"structure"`, `"checksum"`, …). */
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(`${kind}: ${message}`);
    this.name = "CanonicalError";
    this.kind = kind;
  }
}

const fail = (kind: string, message: string): never => {
  throw new CanonicalError(kind, message);
};

// ── Email ────────────────────────────────────────────────────────────────────

const MAX_LOCAL = 64;
const MAX_DOMAIN = 255;
const MAX_LABEL = 63;

/** Return `true` when `value` is a valid email address. */
export function validateEmail(value: string): boolean {
  try {
    normalizeEmail(value);
    return true;
  } catch {
    return false;
  }
}

/** Return the canonical lowercase-domain form of `value`. */
export function normalizeEmail(value: string): string {
  if (!value) fail("empty", "empty input");
  if (count(value, "@") !== 1) fail("structure", "must contain exactly one '@'");
  const at = value.indexOf("@");
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);

  if (!local) fail("structure", "empty local part");
  if (local.length > MAX_LOCAL) fail("length", `local part > ${MAX_LOCAL} chars`);
  if (local.startsWith(".") || local.endsWith(".")) {
    fail("structure", "local part cannot start or end with '.'");
  }
  let prevDot = false;
  for (const ch of local) {
    const ok = /^[A-Za-z0-9._+-]$/.test(ch);
    if (!ok) fail("invalid_char", `bad char ${JSON.stringify(ch)} in local part`);
    if (ch === ".") {
      if (prevDot) fail("structure", "consecutive '.' in local part");
      prevDot = true;
    } else {
      prevDot = false;
    }
  }

  if (!domain) fail("structure", "empty domain");
  if (domain.length > MAX_DOMAIN) fail("length", `domain > ${MAX_DOMAIN} chars`);
  const labels = domain.split(".");
  if (labels.length < 2) fail("structure", "domain must have at least two labels");
  for (const label of labels) {
    if (!label) fail("structure", "empty label");
    if (label.length > MAX_LABEL) fail("structure", "label > 63 chars");
    if (label.startsWith("-") || label.endsWith("-")) {
      fail("structure", "label cannot start or end with '-'");
    }
    if (!/^[A-Za-z0-9-]+$/.test(label)) fail("invalid_char", "bad char in domain label");
  }
  const tld = labels[labels.length - 1]!;
  if (tld.length < 2) fail("structure", "TLD < 2 chars");
  if (/^\d+$/.test(tld)) fail("structure", "all-numeric TLD");

  return `${local}@${domain.toLowerCase()}`;
}

// ── Phone (E.164) ────────────────────────────────────────────────────────────

/** Return `true` when `value` is a valid E.164 phone number. */
export function validatePhone(value: string): boolean {
  try {
    normalizePhone(value);
    return true;
  } catch {
    return false;
  }
}

/** Return the canonical `+<digits>` E.164 form of `value`. */
export function normalizePhone(value: string): string {
  if (!value) fail("empty", "empty input");
  if (!value.startsWith("+")) fail("structure", "missing '+' prefix");
  const rest = value.slice(1);
  if (!rest) fail("structure", "no digits after '+'");
  if (rest.startsWith("0")) fail("structure", "leading zero (country code starts at 1)");
  if (!/^\d+$/.test(rest)) fail("invalid_char", "non-digit in phone number");
  if (rest.length > 15) fail("structure", "more than 15 digits");
  return `+${rest}`;
}

// ── IBAN (mod-97) ────────────────────────────────────────────────────────────

/** Return `true` when `value` is a valid IBAN (mod-97 checksum). */
export function validateIban(value: string): boolean {
  try {
    normalizeIban(value);
    return true;
  } catch {
    return false;
  }
}

/** Return the canonical contiguous uppercased form of `value`. */
export function normalizeIban(value: string): string {
  if (!value) fail("empty", "empty input");
  const normalised = value.replace(/\s/g, "").toUpperCase();
  if (normalised.length < 15 || normalised.length > 34) {
    fail("length", "expected 15–34 chars");
  }
  if (!/^[A-Z]/.test(normalised[0]!) || !/^[A-Z]/.test(normalised[1]!)) {
    fail("structure", "country code must be letters");
  }
  if (!/^\d$/.test(normalised[2]!) || !/^\d$/.test(normalised[3]!)) {
    fail("structure", "check digits must be numeric");
  }
  for (const ch of normalised.slice(4)) {
    if (!/^[A-Za-z0-9]$/.test(ch)) fail("invalid_char", `non-alphanumeric char ${JSON.stringify(ch)}`);
  }
  if (!mod97Valid(normalised)) fail("checksum", "mod-97 check failed");
  return normalised;
}

/** Pure mod-97 check on an uppercased, contiguous IBAN string. */
export function mod97Valid(normalised: string): boolean {
  if (normalised.length < 5) return false;
  const rotated = normalised.slice(4) + normalised.slice(0, 4);
  let remainder = 0;
  for (const ch of rotated) {
    let val: number;
    if (ch >= "0" && ch <= "9") {
      val = ch.charCodeAt(0) - "0".charCodeAt(0);
    } else if (ch >= "A" && ch <= "Z") {
      val = ch.charCodeAt(0) - "A".charCodeAt(0) + 10;
    } else {
      return false;
    }
    if (val >= 10) {
      remainder = (remainder * 100 + val) % 97;
    } else {
      remainder = (remainder * 10 + val) % 97;
    }
  }
  return remainder === 1;
}

// ── IMEI (Luhn) ──────────────────────────────────────────────────────────────

/** Return `true` when `value` is a valid IMEI (Luhn checksum). */
export function validateImei(value: string): boolean {
  try {
    normalizeImei(value);
    return true;
  } catch {
    return false;
  }
}

/** Return the canonical 15-digit form of `value` (whitespace trimmed). */
export function normalizeImei(value: string): string {
  const s = value.trim();
  if (s.length !== 15) fail("length", `expected 15 digits, got ${s.length}`);
  if (!/^\d+$/.test(s)) fail("structure", "non-digit in IMEI");
  const digits = [...s].map((c) => Number(c));
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const posFromRight = 14 - i;
    const d = digits[i]!;
    if (posFromRight % 2 === 1) {
      const doubled = d * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += d;
    }
  }
  if (sum % 10 !== 0) fail("checksum", "Luhn check failed");
  return s;
}

// ── VIN (ISO 3779) ───────────────────────────────────────────────────────────

const VIN_TRANSLIT: Record<string, number> = {
  A: 1, J: 1, B: 2, K: 2, S: 2, C: 3, L: 3, T: 3,
  D: 4, M: 4, U: 4, E: 5, N: 5, V: 5, F: 6, W: 6,
  G: 7, P: 7, X: 7, H: 8, Y: 8, R: 9, Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** Return `true` when `value` is a valid VIN (ISO 3779 check digit). */
export function validateVin(value: string): boolean {
  try {
    normalizeVin(value);
    return true;
  } catch {
    return false;
  }
}

/** Return the canonical 17-char uppercase form of `value`. */
export function normalizeVin(value: string): string {
  const s = value.trim().toUpperCase();
  if (s.length !== 17) fail("length", `expected 17 chars, got ${s.length}`);
  const values: number[] = [];
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") {
      values.push(Number(ch));
    } else if (ch in VIN_TRANSLIT) {
      values.push(VIN_TRANSLIT[ch]!);
    } else {
      fail("structure", `invalid VIN character ${JSON.stringify(ch)}`);
    }
  }
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += values[i]! * VIN_WEIGHTS[i]!;
  const check = sum % 11;
  const expected = check === 10 ? "X" : String(check);
  if (s[8] !== expected) fail("checksum", "check-digit mismatch");
  return s;
}

// ── MSISDN ───────────────────────────────────────────────────────────────────

/** Return `true` when `value` is a valid MSISDN (7–15 digits). */
export function validateMsisdn(value: string): boolean {
  try {
    normalizeMsisdn(value);
    return true;
  } catch {
    return false;
  }
}

/** Return the canonical bare-digit form of `value` (leading `+` stripped). */
export function normalizeMsisdn(value: string): string {
  const stripped = value.trim().replace(/^\++/, "");
  if (!stripped) fail("empty", "empty input");
  if (!/^\d+$/.test(stripped)) fail("structure", "non-digit character in MSISDN");
  if (stripped.length < 7 || stripped.length > 15) {
    fail("length", `expected 7–15 digits, got ${stripped.length}`);
  }
  if (stripped[0] === "0") fail("structure", "E.164 MSISDN must not start with 0");
  return stripped;
}

// ── IPv4 ─────────────────────────────────────────────────────────────────────

/** Return `true` when `value` is a valid dotted-quad IPv4 address. */
export function validateIpv4(value: string): boolean {
  try {
    normalizeIpv4(value);
    return true;
  } catch {
    return false;
  }
}

/** Return the canonical `a.b.c.d` form of `value` (no leading zeros). */
export function normalizeIpv4(value: string): string {
  if (!value) fail("empty", "empty input");
  const octets: number[] = [];
  let digitCount = 0;
  let current = 0;
  let hadLeadingZero = false;
  for (const ch of value) {
    if (ch === ".") {
      if (digitCount === 0) fail("structure", "empty octet");
      if (octets.length >= 3) fail("structure", "too many octets");
      octets.push(current);
      current = 0;
      digitCount = 0;
      hadLeadingZero = false;
      continue;
    }
    if (!/^\d$/.test(ch)) fail("invalid_char", `non-digit ${JSON.stringify(ch)}`);
    const d = ch.charCodeAt(0) - "0".charCodeAt(0);
    if (digitCount === 0 && d === 0) {
      hadLeadingZero = true;
    } else if (hadLeadingZero) {
      fail("structure", "leading zero in octet");
    }
    current = current * 10 + d;
    digitCount++;
    if (current > 255) fail("structure", "octet > 255");
    if (digitCount > 3) fail("structure", "octet has too many digits");
  }
  if (digitCount === 0) fail("structure", "trailing dot");
  if (octets.length !== 3) fail("structure", "wrong number of octets");
  octets.push(current);
  return octets.join(".");
}

// ── IPv6 ─────────────────────────────────────────────────────────────────────

/** Return `true` when `value` is a valid IPv6 address (RFC 4291). */
export function validateIpv6(value: string): boolean {
  try {
    normalizeIpv6(value);
    return true;
  } catch {
    return false;
  }
}

/** Parse an IPv6 address into 16 canonical big-endian bytes. */
export function parseIpv6(value: string): Uint8Array {
  if (!value) fail("empty", "empty input");
  const dc = count(value, "::");
  if (dc > 1) fail("structure", "multiple '::' compressions");

  const parseGroups = (s: string): number[] => {
    const out: number[] = [];
    for (const part of s.split(":")) {
      if (!part) fail("structure", "empty group");
      if (part.length > 4) fail("structure", "group has > 4 hex digits");
      const g = Number.parseInt(part, 16);
      if (!Number.isInteger(g)) fail("invalid_char", `non-hex in group ${JSON.stringify(part)}`);
      out.push(g);
    }
    return out;
  };

  let groups: number[];
  if (value.includes("::")) {
    const [left, right] = value.split("::");
    const lg = left ? parseGroups(left) : [];
    const rg = right ? parseGroups(right) : [];
    const zeros = 8 - lg.length - rg.length;
    if (zeros < 0) fail("structure", "too many groups around '::'");
    if (zeros === 0) fail("structure", "'::' must compress at least one group");
    groups = [...lg, ...Array.from({ length: zeros }, () => 0), ...rg];
  } else {
    groups = parseGroups(value);
    if (groups.length !== 8) fail("structure", "expected 8 groups");
  }

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (groups[i]! >> 8) & 0xff;
    out[i * 2 + 1] = groups[i]! & 0xff;
  }
  return out;
}

/** Format 16 canonical bytes as RFC 5952 lowercase-compressed text. */
export function displayIpv6(addr: Uint8Array): string {
  const groups = Array.from({ length: 8 }, (_, i) =>
    (addr[i * 2]! << 8) | addr[i * 2 + 1]!,
  );
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curLen === 0) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curLen = 0;
    }
  }
  const compress = bestLen >= 2;

  let out = "";
  let i = 0;
  while (i < 8) {
    if (compress && i === bestStart) {
      out += "::";
      i += bestLen;
      continue;
    }
    if (out && !out.endsWith(":")) out += ":";
    out += groups[i]!.toString(16);
    i++;
  }
  return out;
}

/** Return the canonical RFC 5952 lowercase-compressed form of `value`. */
export function normalizeIpv6(value: string): string {
  return displayIpv6(parseIpv6(value));
}

// ── shared helpers ───────────────────────────────────────────────────────────

function count(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}
