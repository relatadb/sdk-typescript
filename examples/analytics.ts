/**
 * analytics.ts — full governed analytics workflow example.
 *
 * Demonstrates a realistic enterprise knowledge workflow:
 *   1. Look up a person by phone number using IdentityIndex
 *   2. Pull their associated case records
 *   3. Find financial transactions over a threshold
 *   4. Expand their known network (NETWORK_EXPAND)
 *   5. Traverse paths between two entities
 *   6. Verify the audit trail is intact
 *
 * Run:
 *   node --experimental-strip-types examples/analytics.ts
 */

import {
  createClient,
  type QueryResult,
  AuthError,
  PurposeError,
  QuotaError,
  ForbiddenError,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Types for this workflow
// ---------------------------------------------------------------------------

interface Person {
  id: string;
  name: string;
  msisdn?: string;         // Mobile number (canonical Msisdn type)
  aadhaar?: string;        // Aadhaar UID (canonical Aadhaar type)
  nationality?: string;
  dob?: string;
  classification?: string;
}

interface CaseRecord {
  case_id: string;
  person_id: string;
  case_type: string;
  owner_team: string;
  filed_at: string;
  status: "open" | "closed" | "chargesheet";
}

interface Transaction {
  txn_id: string;
  from_account: string;
  to_account: string;
  amount_inr: number;
  occurred_at: string;
  hawala_flag?: boolean;
}

interface NetworkEdge {
  from_id: string;
  to_id: string;
  link_type: string;
  confidence: number;
}

interface PathHop {
  from_id: string;
  to_id: string;
  link_type: string;
  hops: number;
}

// ---------------------------------------------------------------------------
// Client setup
// ---------------------------------------------------------------------------

const RELATA_URL = process.env["RELATA_URL"] ?? "http://localhost:9090";
const RELATA_TOKEN = process.env["RELATA_TOKEN"];

const relata = createClient(RELATA_URL, {
  bearerToken: RELATA_TOKEN,
  defaultPurpose: "analytics",
  timeoutMs: 30_000,
});

// ---------------------------------------------------------------------------
// Helper: safe query with error context
// ---------------------------------------------------------------------------

async function safeQuery<T>(
  label: string,
  fn: () => Promise<QueryResult<T>>,
): Promise<QueryResult<T> | null> {
  try {
    const result = await fn();
    console.log(`  ✓ ${label}: ${result.rowCount} row(s) in ${result.elapsedMs}ms`);
    return result;
  } catch (err) {
    if (err instanceof ForbiddenError) {
      console.warn(`  ⚠ ${label}: access denied (Cedar ACL) — ${err.serverMessage}`);
    } else if (err instanceof PurposeError) {
      console.error(`  ✗ ${label}: purpose rejected — ${err.message}`);
    } else if (err instanceof QuotaError) {
      console.error(`  ✗ ${label}: quota exhausted — ${err.message}`);
    } else if (err instanceof AuthError) {
      console.error(`  ✗ ${label}: authentication failed`);
    } else {
      throw err;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 0: Verify connectivity
// ---------------------------------------------------------------------------

console.log("=== Relata Analytics Workflow ===\n");

const health = await relata.health();
console.log(`Node: ${health.nodeId}  Profile: ${health.profile}  Status: ${health.status}`);

const status = await relata.status();
console.log(`Role: ${status.role}  Quota: ${status.queryQuota} cost units\n`);

// ---------------------------------------------------------------------------
// Step 1: Identity lookup — resolve person by MSISDN
// ---------------------------------------------------------------------------

const TARGET_MSISDN = "+919876543210";

console.log(`Step 1: Identity lookup for MSISDN ${TARGET_MSISDN}`);

const identityResult = await safeQuery<Person>(
  "LOOKUP_IDENTITY",
  () =>
    relata.query<Person>(
      `SELECT id, name, msisdn, aadhaar, nationality, dob
       FROM Person
       WHERE LOOKUP_IDENTITY(msisdn, '${TARGET_MSISDN}')
       LIMIT 5`,
    ),
);

const personId = identityResult?.rows[0]?.id;
const personName = identityResult?.rows[0]?.name ?? "Unknown";

console.log(`  Resolved to: ${personName} (id: ${personId ?? "not found"})\n`);

// ---------------------------------------------------------------------------
// Step 2: Case cross-reference — pull case records for the person
// ---------------------------------------------------------------------------

console.log("Step 2: Case cross-reference");

if (personId) {
  const caseResult = await safeQuery<CaseRecord>(
    "Case records",
    () =>
      relata.query<CaseRecord>(
        `SELECT case_id, case_type, owner_team, filed_at, status
         FROM CaseRecord
         WHERE person_id = '${personId}'
           AND status != 'closed'
         ORDER BY filed_at DESC
         LIMIT 50`,
      ),
  );

  if (caseResult && caseResult.rowCount > 0) {
    console.log("  Open cases:");
    for (const rec of caseResult.rows) {
      console.log(`    [${rec.case_id}] ${rec.case_type} @ ${rec.owner_team} — ${rec.status}`);
    }
  }
} else {
  console.log("  Skipped (no person ID)");
}

console.log();

// ---------------------------------------------------------------------------
// Step 3: Financial intelligence — transactions > ₹10L
// ---------------------------------------------------------------------------

console.log("Step 3: Financial transactions > ₹10,00,000");

const txnResult = await safeQuery<Transaction>(
  "Transactions",
  () =>
    relata.query<Transaction>(
      `SELECT txn_id, from_account, to_account, amount_inr, occurred_at, hawala_flag
       FROM Transaction
       WHERE (from_account IN (
                SELECT account_id FROM BankAccount WHERE person_id = '${personId ?? "unknown"}'
              )
           OR to_account IN (
                SELECT account_id FROM BankAccount WHERE person_id = '${personId ?? "unknown"}'
              ))
         AND amount_inr > 1000000
         AND occurred_at BETWEEN '2024-01-01T00:00:00Z' AND '2025-01-01T00:00:00Z'
       ORDER BY amount_inr DESC
       LIMIT 100`,
      { purpose: "analytics" },
    ),
);

if (txnResult && txnResult.rowCount > 0) {
  const total = txnResult.rows.reduce((s, t) => s + t.amount_inr, 0);
  const hawala = txnResult.rows.filter((t) => t.hawala_flag).length;
  console.log(`  Total flow: ₹${total.toLocaleString("en-IN")}`);
  console.log(`  Hawala-flagged: ${hawala}/${txnResult.rowCount}`);
}

console.log();

// ---------------------------------------------------------------------------
// Step 4: Network expansion using NETWORK_EXPAND
// ---------------------------------------------------------------------------

console.log("Step 4: Network expansion (3 hops)");

if (personId) {
  const networkResult = await safeQuery<NetworkEdge>(
    "NETWORK_EXPAND",
    () =>
      relata.query<NetworkEdge>(
        `SELECT from_id, to_id, link_type, confidence
         FROM NETWORK_EXPAND(
           seed_id => '${personId}',
           hops    => 3
         )
         WHERE confidence > 0.6
         ORDER BY confidence DESC
         LIMIT 200`,
      ),
  );

  if (networkResult && networkResult.rowCount > 0) {
    const byType = new Map<string, number>();
    for (const edge of networkResult.rows) {
      byType.set(edge.link_type, (byType.get(edge.link_type) ?? 0) + 1);
    }
    console.log("  Link type breakdown:");
    for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${type}: ${count}`);
    }
  }
}

console.log();

// ---------------------------------------------------------------------------
// Step 5: Graph path traversal between two entities
// ---------------------------------------------------------------------------

const ENTITY_A = personId ?? "person-001";
const ENTITY_B = "person-042";

console.log(`Step 5: PATHS_BETWEEN ${ENTITY_A} ↔ ${ENTITY_B}`);

// Using the fluent builder's pathsBetween helper
const pathsResult = await safeQuery<PathHop>(
  "PATHS_BETWEEN",
  () =>
    relata
      .select("Person")
      .pathsBetween(ENTITY_A, ENTITY_B, { maxHops: 4 })
      .purpose("analytics")
      .withProvenance()
      .limit(10)
      .execute<PathHop>(),
);

if (pathsResult && pathsResult.rowCount > 0) {
  console.log(`  Found ${pathsResult.rowCount} path(s). Shortest hops: ` +
    Math.min(...pathsResult.rows.map((r) => r.hops)));
  for (const hop of pathsResult.rows.slice(0, 3)) {
    console.log(`  ${hop.from_id} --[${hop.link_type}]--> ${hop.to_id}`);
  }
}

console.log();

// ---------------------------------------------------------------------------
// Step 6: Bi-temporal snapshot — where was the data on 2024-06-01?
// ---------------------------------------------------------------------------

console.log("Step 6: Bi-temporal snapshot (AS OF 2024-06-01)");

const snapshotResult = await safeQuery<Person>(
  "AS OF snapshot",
  () =>
    relata
      .select("Person")
      .columns("id", "name", "classification")
      .asOf("2024-06-01T00:00:00Z")
      .where(`id = '${personId ?? "person-001"}'`)
      .withProvenance()
      .execute<Person>(),
);

if (snapshotResult?.rows[0]) {
  const row = snapshotResult.rows[0];
  console.log(`  ${row.name} — classification at that time: ${row.classification ?? "n/a"}`);
}

console.log();

// ---------------------------------------------------------------------------
// Step 7: Audit verification
// ---------------------------------------------------------------------------

console.log("Step 7: Audit chain verification");

const audit = await relata.auditCount();
console.log(`  Audit entries: ${audit.entries}`);
console.log(`  Chain valid  : ${audit.chainValid ? "YES" : "NO — TAMPER ALERT"}`);

if (!audit.chainValid) {
  console.error("\n  CRITICAL: Audit chain integrity failure. Escalate immediately.");
  process.exit(2);
}

console.log("\n=== Investigation workflow complete ===");
