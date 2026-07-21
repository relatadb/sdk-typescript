/**
 * audit.ts — audit chain verification and compliance reporting.
 *
 * Demonstrates:
 *   1. Verify the tamper-evident audit hash chain
 *   2. Query the audit log for specific events
 *   3. Produce a point-in-time provenance report for a given query
 *   4. Detect anomalous query patterns (bulk exports, unusual principals)
 *   5. Generate a court-admissible audit summary (typed Report framework)
 *
 * Relata's audit log is a hash-chained, tamper-evident ledger (SPECS §5.16).
 * Every query, ingest, and schema change creates an audit entry. The
 * `chain_valid: false` flag means the chain has been broken — escalate.
 *
 * Exit codes:
 *   0  success, no anomalies
 *   1  anomalies detected (review flagged principals), or SDK error
 *   2  audit chain integrity failure (tamper alert)
 *
 * Run:
 *   node --experimental-strip-types examples/audit.ts
 */

import {
  createClient,
  type AuditCountResponse,
  AuthError,
} from "../src/index.ts";
import {
  banner,
  exitOnRelataError,
  fatal,
  loadEnv,
  ok,
  out,
  softFail,
  step,
} from "./_helpers.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditEntry {
  entry_id: string;
  sequence: number;
  event_type: string;           // "query" | "ingest" | "schema_change" | "acl_change"
  principal_id: string;
  purpose: string | null;
  sql_digest: string | null;    // SHA-256 of the executed SQL (not the SQL itself)
  row_count: number | null;
  cost_units: number | null;
  occurred_at: string;
  chain_hash: string;
  prev_hash: string;
}

interface ProvenanceRow {
  row_id: string;
  object_type: string;
  source_name: string;
  collector: string;
  method: string;
  confidence: number;
  observed_at: string;
  recorded_at: string;
  valid_from: string;
  valid_to: string | null;
}

interface AnomalyFlag {
  principal_id: string;
  event_count: number;
  total_rows: number;
  distinct_purposes: number;
  flagged_reason: string;
}

interface ReportSummary {
  report_id: string;
  report_type: string;
  generated_at: string;
  chain_valid: boolean;
  entry_count: number;
  signing_key_id: string;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const { url, token } = loadEnv();

const relata = createClient(url, {
  bearerToken: token,
  defaultPurpose: "audit",
  timeoutMs: 30_000,
});

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

let auditSummary: AuditCountResponse;
let anomalies: { rowCount: number };

try {
  const health = await relata.health();
  banner("Relata Audit & Compliance Demo");
  out(`Server: ${health.nodeId} (${health.profile}) — ${health.status}`);

  // -------------------------------------------------------------------------
  // Step 1: Basic audit count + chain validity check
  // -------------------------------------------------------------------------

  step("1: Audit chain integrity check");

  try {
    auditSummary = await relata.auditCount();
  } catch (err) {
    if (err instanceof AuthError) {
      fatal("Audit endpoint requires authentication. Set RELATA_TOKEN.");
    }
    throw err;
  }

  out(`  Total audit entries : ${auditSummary.entries.toLocaleString()}`);
  out(
    `  Chain integrity     : ${
      auditSummary.chainValid
        ? "VALID"
        : "BROKEN — TAMPER ALERT — ESCALATE IMMEDIATELY"
    }`,
  );

  if (!auditSummary.chainValid) {
    softFail(
      "CRITICAL SECURITY ALERT: Tamper-evident audit chain is broken.\n" +
        "  Actions required:\n" +
        "    1. Immediately notify the CISO and legal team.\n" +
        "    2. Preserve the raw audit log (do not rotate).\n" +
        "    3. Identify the last known-good sequence number.\n" +
        "    4. Submit an incident report under ADR-038 dual-control.",
    );
    fatal("Audit chain integrity failure — investigate immediately.", 2);
  }

  // -------------------------------------------------------------------------
  // Step 2: Query the audit log — last 50 query events
  // -------------------------------------------------------------------------

  step("2: Recent query events (last 50)");

  const recentEvents = await relata.query<AuditEntry>(
    `SELECT
       entry_id, sequence, event_type, principal_id,
       purpose, sql_digest, row_count, cost_units, occurred_at
     FROM AuditEntry
     WHERE event_type = 'query'
     ORDER BY sequence DESC
     LIMIT 50`,
    { purpose: "audit" },
  );

  out(`  Events retrieved: ${recentEvents.rowCount}  (${recentEvents.elapsedMs}ms)`);

  // Summarise by purpose
  const byPurpose = new Map<string, number>();
  for (const e of recentEvents.rows) {
    const p = e.purpose ?? "(none)";
    byPurpose.set(p, (byPurpose.get(p) ?? 0) + 1);
  }
  out("  Purpose breakdown:");
  for (const [purpose, count] of [...byPurpose].sort((a, b) => b[1] - a[1])) {
    out(`    ${purpose}: ${count}`);
  }

  // -------------------------------------------------------------------------
  // Step 3: Provenance query — WHERE did a specific record come from?
  // -------------------------------------------------------------------------

  step("3: Provenance trace for Person records (sample)");

  const provenanceResult = await relata.query<ProvenanceRow>(
    `SELECT
       row_id,
       object_type,
       source_name,
       collector,
       method,
       confidence,
       observed_at,
       recorded_at,
       valid_from,
       valid_to
     FROM Person
     WITH PROVENANCE
     LIMIT 10`,
    { purpose: "audit" },
  );

  out(`  Provenance rows: ${provenanceResult.rowCount}`);
  for (const p of provenanceResult.rows.slice(0, 3)) {
    out(
      `  [${p.row_id}] source=${p.source_name} ` +
        `collector=${p.collector} ` +
        `confidence=${p.confidence.toFixed(2)} ` +
        `observed_at=${p.observed_at}`,
    );
  }

  // -------------------------------------------------------------------------
  // Step 4: Anomaly detection — detect bulk exports or unusual activity
  // -------------------------------------------------------------------------

  step("4: Anomaly detection — bulk exports / unusual principals");

  const anomaliesResult = await relata.query<AnomalyFlag>(
    `SELECT
       principal_id,
       COUNT(*)             AS event_count,
       SUM(row_count)       AS total_rows,
       COUNT(DISTINCT purpose) AS distinct_purposes,
       CASE
         WHEN SUM(row_count) > 10000 THEN 'bulk_export'
         WHEN COUNT(DISTINCT purpose) > 5 THEN 'purpose_scatter'
         ELSE 'suspicious_volume'
       END AS flagged_reason
     FROM AuditEntry
     WHERE event_type = 'query'
       AND occurred_at > NOW() - INTERVAL '24 hours'
     GROUP BY principal_id
     HAVING SUM(row_count) > 1000
        OR COUNT(*) > 100
     ORDER BY total_rows DESC
     LIMIT 20`,
    { purpose: "audit" },
  );
  anomalies = { rowCount: anomaliesResult.rowCount };

  if (anomaliesResult.rowCount === 0) {
    ok("No anomalous activity detected in the last 24 hours.");
  } else {
    softFail(`Flagged principals: ${anomaliesResult.rowCount}`);
    for (const a of anomaliesResult.rows) {
      softFail(
        `  ${a.principal_id}: ` +
          `${a.event_count} queries, ` +
          `${a.total_rows?.toLocaleString()} rows, ` +
          `reason=${a.flagged_reason}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Bi-temporal audit — what was true on a specific date?
  // -------------------------------------------------------------------------

  step("5: Bi-temporal audit snapshot (AS OF 2024-12-31)");

  const auditSnapshot = await relata.query<AuditEntry>(
    `SELECT entry_id, sequence, event_type, principal_id, occurred_at
     FROM AuditEntry
     AS OF '2024-12-31T23:59:59Z'
     WHERE event_type IN ('schema_change', 'acl_change')
     ORDER BY sequence DESC
     LIMIT 10`,
    { purpose: "audit" },
  );

  out(`  Schema/ACL changes up to 2024-12-31: ${auditSnapshot.rowCount}`);
  for (const e of auditSnapshot.rows) {
    out(`  [${e.sequence}] ${e.event_type} by ${e.principal_id} at ${e.occurred_at}`);
  }

  // -------------------------------------------------------------------------
  // Step 6: Generate a signed compliance report (Report framework)
  //
  // Reports in Relata are HSM-signed, retained, and delivered via typed channels.
  // No ad-hoc query dumps for compliance/court/regulator artifacts (SPECS §17.15).
  // -------------------------------------------------------------------------

  step("6: Generate signed compliance report");

  const reportResult = await relata.query<ReportSummary>(
    `SELECT
       report_id,
       report_type,
       generated_at,
       chain_valid,
       entry_count,
       signing_key_id
     FROM GENERATE_REPORT(
       type       => 'AuditIntegritySummary',
       period     => '2025-01-01T00:00:00Z/2025-12-31T23:59:59Z',
       purpose    => 'audit',
       recipients => ARRAY['ciso@agency.gov.in', 'legal@agency.gov.in']
     )`,
    { purpose: "audit" },
  );

  const report = reportResult.rows[0];
  if (report) {
    out(`  Report ID     : ${report.report_id}`);
    out(`  Type          : ${report.report_type}`);
    out(`  Generated at  : ${report.generated_at}`);
    out(`  Chain valid   : ${report.chain_valid}`);
    out(`  Entry count   : ${report.entry_count}`);
    out(`  Signing key   : ${report.signing_key_id}`);
  } else {
    out("  Report generation not available in this deployment.");
  }

  // -------------------------------------------------------------------------
  // Final summary
  // -------------------------------------------------------------------------

  out("\n=== Audit verification complete ===");
  out(`  Total entries : ${auditSummary.entries.toLocaleString()}`);
  out(`  Chain valid   : ${auditSummary.chainValid ? "YES" : "BROKEN"}`);
  out(`  Anomalies     : ${anomalies.rowCount}`);
} catch (err) {
  exitOnRelataError(err);
}

if (anomalies.rowCount > 0) {
  softFail("ACTION REQUIRED: Review flagged principals above.");
  process.exit(1);
}

process.exit(0);
