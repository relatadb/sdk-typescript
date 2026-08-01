/**
 * Typed decoders for AML / financial-intelligence result shapes (#2255).
 *
 * The server's AML operators (`SANCTIONS_SCREEN`,
 * `BENEFICIAL_OWNERSHIP_CHAIN`, `CRYPTO_TRACE`, `WIRE_RECONSTRUCTION`,
 * `HAWALA_TRACE`, `RESOLVE_IDENTITY`, and the shortest-path / Dijkstra path
 * operators) return generic query-result rows (objects of column → JSON
 * value). This module declares typed interfaces for each result shape and
 * provides a decoder that maps the generic rows into those typed objects, so
 * callers can work with strongly-typed objects instead of untyped records.
 *
 * Field names mirror the exact column names emitted by the server operators
 * (see `crates/relata-query/src/finint_operators.rs` and
 * `investigation_ops.rs`).
 *
 * Scope
 * -----
 * Only the AML / financial-intelligence result shapes are typed here. All
 * other packs (police, evidence, supply-chain, health, cyber, …) continue to
 * return generic `Record<string, unknown>` results — typing them is the
 * remaining scope of #2255.
 */

/** A generic result row: column name → JSON value. */
type Row = Record<string, unknown>;

const getStr = (row: Row, key: string): string | undefined => {
  const v = row[key];
  if (v === null || v === undefined) return undefined;
  return typeof v === "string" ? v : String(v);
};

const getNum = (row: Row, key: string): number | undefined => {
  const v = row[key];
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const getInt = (row: Row, key: string): number | undefined => {
  const n = getNum(row, key);
  return n === undefined ? undefined : Math.trunc(n);
};

// ── SanctionsHit ─────────────────────────────────────────────────────────────

/** A single sanctions-list match from `SANCTIONS_SCREEN`. */
export interface SanctionsHit {
  /** Sanctions list that produced the hit (e.g. `"OFAC"`, `"EU"`). */
  list_name: string;
  /** Server-side entry identifier. */
  entry_id: string;
  /** Field on the entry that matched (`"name"`, `"aliases"`, …). */
  matched_field: string;
  /** Fuzzy match score in `[0.0, 1.0]`. */
  match_score: number;
}

/** Decode generic query rows into typed {@link SanctionsHit} objects. */
export function decodeSanctionsHits(rows: Row[]): SanctionsHit[] {
  const out: SanctionsHit[] = [];
  for (const r of rows) {
    const list_name = getStr(r, "list_name");
    const entry_id = getStr(r, "entry_id");
    const matched_field = getStr(r, "matched_field");
    if (list_name === undefined || entry_id === undefined || matched_field === undefined) {
      continue;
    }
    out.push({
      list_name,
      entry_id,
      matched_field,
      match_score: getNum(r, "match_score") ?? 0,
    });
  }
  return out;
}

// ── BeneficialOwner ──────────────────────────────────────────────────────────

/** One hop in a beneficial-ownership chain from `BENEFICIAL_OWNERSHIP_CHAIN`. */
export interface BeneficialOwner {
  /** BFS depth from the seed entity (1-based). */
  depth: number;
  /** Owning entity id. */
  parent_id: string;
  /** Owned entity id. */
  child_id: string;
  /** Edge type (`"owns"`, `"subsidiary_of"`, …). */
  link_type: string;
  /** Ownership percentage 0–100 when known. */
  ownership_pct?: number;
}

/** Decode generic query rows into typed {@link BeneficialOwner} hops. */
export function decodeBeneficialOwners(rows: Row[]): BeneficialOwner[] {
  const out: BeneficialOwner[] = [];
  for (const r of rows) {
    const depth = getInt(r, "depth");
    const parent_id = getStr(r, "parent_id");
    const child_id = getStr(r, "child_id");
    const link_type = getStr(r, "link_type");
    if (
      depth === undefined ||
      parent_id === undefined ||
      child_id === undefined ||
      link_type === undefined
    ) {
      continue;
    }
    const pct = getNum(r, "ownership_pct");
    const hop: BeneficialOwner = {
      depth,
      parent_id,
      child_id,
      link_type,
    };
    if (pct !== undefined) hop.ownership_pct = pct;
    out.push(hop);
  }
  return out;
}

// ── CryptoTraceHop ───────────────────────────────────────────────────────────

/** One hop in a cryptocurrency fund-flow trace from `CRYPTO_TRACE`. */
export interface CryptoTraceHop {
  /** 1-based hop index (the server emits `-1` for the terminal summary row). */
  hop: number;
  /** Source wallet address. */
  from_wallet: string;
  /** Destination wallet address. */
  to_wallet: string;
  /** Transfer amount in the asset's native units. */
  amount: number;
  /** Asset ticker (`"BTC"`, `"ETH"`, …). */
  asset: string;
  /** Blockchain (`"bitcoin"`, `"ethereum"`, …). */
  chain: string;
}

/** Decode generic query rows into typed {@link CryptoTraceHop} objects. */
export function decodeCryptoTrace(rows: Row[]): CryptoTraceHop[] {
  const out: CryptoTraceHop[] = [];
  for (const r of rows) {
    const hop = getInt(r, "hop");
    if (hop === undefined) continue;
    out.push({
      hop,
      from_wallet: getStr(r, "from_wallet") ?? "",
      to_wallet: getStr(r, "to_wallet") ?? "",
      amount: getNum(r, "amount") ?? 0,
      asset: getStr(r, "asset") ?? "",
      chain: getStr(r, "chain") ?? "",
    });
  }
  return out;
}

// ── WireHop ──────────────────────────────────────────────────────────────────

/** One leg of a reconstructed wire-transfer chain from `WIRE_RECONSTRUCTION`. */
export interface WireHop {
  /** 0-based step index (the server emits `-1` for the chain summary row). */
  step: number;
  /** Sending bank / account. */
  from_bank: string;
  /** Receiving bank / account. */
  to_bank: string;
  /** Transfer amount. */
  amount: number;
  /** ISO 4217 currency code (`"USD"`, …). */
  currency: string;
  /** Wire reference / reference text. */
  reference: string;
}

/** Decode generic query rows into typed {@link WireHop} objects. */
export function decodeWireHops(rows: Row[]): WireHop[] {
  const out: WireHop[] = [];
  for (const r of rows) {
    const step = getInt(r, "step");
    if (step === undefined) continue;
    out.push({
      step,
      from_bank: getStr(r, "from_bank") ?? "",
      to_bank: getStr(r, "to_bank") ?? "",
      amount: getNum(r, "amount") ?? 0,
      currency: getStr(r, "currency") ?? "",
      reference: getStr(r, "reference") ?? "",
    });
  }
  return out;
}

// ── HawalaPair ───────────────────────────────────────────────────────────────

/** A matched informal-value-transfer pair from `HAWALA_TRACE`. */
export interface HawalaPair {
  /** Sender identifier. */
  sender: string;
  /** Receiver identifier. */
  receiver: string;
  /** Transferred amount. */
  amount: number;
  /** ISO 3166 sender country code. */
  sender_country: string;
  /** ISO 3166 receiver country code. */
  receiver_country: string;
  /** Transaction timestamp (server-defined textual form). */
  ts: string;
}

/** Decode generic query rows into typed {@link HawalaPair} objects. */
export function decodeHawalaPairs(rows: Row[]): HawalaPair[] {
  const out: HawalaPair[] = [];
  for (const r of rows) {
    const sender = getStr(r, "sender");
    if (sender === undefined) continue;
    out.push({
      sender,
      receiver: getStr(r, "receiver") ?? "",
      amount: getNum(r, "amount") ?? 0,
      sender_country: getStr(r, "sender_country") ?? "",
      receiver_country: getStr(r, "receiver_country") ?? "",
      ts: getStr(r, "ts") ?? "",
    });
  }
  return out;
}

// ── ResolvedIdentity ─────────────────────────────────────────────────────────

/** A resolved identity member from `RESOLVE_IDENTITY`. */
export interface ResolvedIdentity {
  /** Row kind (`"Canonical"`, `"Cluster"`, …). */
  kind: string;
  /** Canonical identifier. */
  id: string;
  /** Raw identity value. */
  identity_value: string;
  /** Detection source (`"relata-detect"`, …). */
  source: string;
  /** Observation timestamp (i64 ns UTC). */
  observed_at: number;
  /** Link confidence in `[0.0, 1.0]`. */
  confidence: number;
}

/** Decode generic query rows into typed {@link ResolvedIdentity} objects. */
export function decodeResolvedIdentities(rows: Row[]): ResolvedIdentity[] {
  const out: ResolvedIdentity[] = [];
  for (const r of rows) {
    const id = getStr(r, "_id");
    if (id === undefined) continue;
    out.push({
      id,
      kind: getStr(r, "_type") ?? "",
      identity_value: getStr(r, "identity_value") ?? "",
      source: getStr(r, "source") ?? "",
      observed_at: getInt(r, "observed_at") ?? 0,
      confidence: getNum(r, "confidence") ?? 0,
    });
  }
  return out;
}

// ── PathHop ──────────────────────────────────────────────────────────────────

/** One node on a graph path from `SHORTEST_PATH` / `DIJKSTRA` / `K_SHORTEST`. */
export interface PathHop {
  /** 1-based position along the path. */
  position: number;
  /** Node identifier. */
  node: string;
  /** Accumulated cost / distance when the operator emits one (else `undefined`). */
  cost?: number;
}

/** Decode generic query rows into typed {@link PathHop} objects. */
export function decodePathHops(rows: Row[]): PathHop[] {
  const out: PathHop[] = [];
  for (const r of rows) {
    const position = getInt(r, "position");
    const node = getStr(r, "node");
    if (position === undefined || node === undefined) continue;
    const hop: PathHop = { position, node };
    const cost = getNum(r, "cost");
    if (cost !== undefined) hop.cost = cost;
    out.push(hop);
  }
  return out;
}
