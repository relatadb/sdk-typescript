/**
 * investigation.ts — from ingested events to an archived alert record (#5702).
 *
 * The SDK version of the curl walk-through in
 * docs/src/guides/siem-detection-and-investigation.md ("Worked example: from
 * ingest to export") and docs/src/guides/investigation-archive-workflow.md:
 *
 *   1. ingest a few fixed AuthEvent and Session rows
 *   2. create a window rule and wait for its alert
 *   3. fetch the alert evidence and reproduce the alert from its query
 *   4. read the ordered timeline
 *   5. pivot on the alert's user into the other readable records
 *   6. keep the reproduction query as a saved search and run it
 *   7. archive the evidence export as a file and check its SHA-256
 *
 * The token needs read+write on AuthEvent, Session, Alert, SavedSearch and
 * S3Object. The rule fires on the next evaluation tick
 * (RELATA_RULE_EVAL_INTERVAL_SECS, default 30), so the script waits up to 90 s.
 *
 * Run (from sdks/typescript):
 *   RELATA_URL=http://localhost:9090 RELATA_TOKEN=<data-plane token> \
 *     node --experimental-strip-types examples/investigation.ts
 */

import { createHash } from "node:crypto";
import {
  createClient,
  FilesClient,
  GovernanceClient,
  IngestClient,
  InvestigationClient,
} from "../src/index.ts";
import { exitOnRelataError, fatal, loadEnv, out, step } from "./_helpers.ts";

type Row = { id: string };
interface Evidence {
  evidence: { reproduce: { sql: string } };
  events: Row[];
  completeness: { status: string };
  export: { events_sha256: string };
}
interface Timeline {
  entries: { at_ns: number; kind: string; id?: string; to?: string }[];
  entities: { field: string; value: unknown; event_count: number }[];
}
interface Pivot {
  results: { object_type: string; rows: Row[]; truncated: boolean }[];
  completeness: { status: string };
}
interface Saved {
  id: string;
  name: string;
  version: number;
}
/** The investigation methods return plain JSON documents; name the fields this example reads. */
const shape = <T>(doc: Record<string, unknown>): T => doc as unknown as T;

const PURPOSE = "audit";
const MIN = 60_000_000_000;
const T0 = 1_760_000_100_000_000_000; // fixed event time on a 5-minute boundary (exact in a double)

const AUTH_EVENTS = [
  { _pk: "a1", ts: T0 + 1 * MIN, kind: "login_failed", user: "alice" },
  { _pk: "a2", ts: T0 + 2 * MIN, kind: "login_failed", user: "alice" },
  { _pk: "a3", ts: T0 + 3 * MIN, kind: "login_failed", user: "alice" },
  { _pk: "b1", ts: T0 + 2 * MIN, kind: "login_failed", user: "bob" },
];
const SESSIONS = [
  { _pk: "s1", ts: T0 + 4 * MIN, user: "alice", host: "srv-9" },
  { _pk: "s2", ts: T0 + 4 * MIN, user: "bob", host: "srv-1" },
];
const RULE = {
  name: "brute force (sdk example)",
  target_type: "AuthEvent",
  severity: "high",
  window: {
    kind: "threshold", event_type: "login_failed", min_count: 3,
    window_ns: 5 * MIN, allowed_lateness_ns: 0, version: 1,
    time_field: "ts", group_field: "user", event_type_field: "kind",
  },
};
const SEARCH_NAME = "alice failed logins (sdk example)";

const { url, token } = loadEnv();
const relata = createClient(url, {
  ...(token !== undefined ? { bearerToken: token } : {}),
  defaultPurpose: PURPOSE,
  timeoutMs: 60_000,
});
const ingest = IngestClient.fromClient(relata);
const gov = GovernanceClient.fromClient(relata);
const inv = InvestigationClient.fromClient(relata);
const files = FilesClient.fromClient(relata);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function waitForAlert(ruleId: string, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alerts = await gov.listAlerts({ newestFirst: true, limit: 1000 });
    const hit = alerts.find((a) => a["rule_id"] === ruleId);
    if (hit) return String(hit["alert_id"]);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return fatal(`rule ${ruleId} raised no alert within ${timeoutMs / 1000}s`);
}

async function main(): Promise<void> {
  step("1. Ingest fixed events (idempotent on _pk)");
  await ingest.bulk("AuthEvent", AUTH_EVENTS, { onConflict: "upsert", durability: "sync" });
  await ingest.bulk("Session", SESSIONS, { onConflict: "upsert", durability: "sync" });
  out(`   ${AUTH_EVENTS.length} AuthEvent, ${SESSIONS.length} Session`);

  step("2. Window rule and its alert");
  const ruleId = String((await gov.createRule(RULE))["rule_id"]);
  const alertId = await waitForAlert(ruleId);
  out(`   rule ${ruleId} -> alert ${alertId}`);
  await gov.updateAlert(alertId, { status: "acknowledged", note: "sdk example triage" });

  step("3. Evidence, and the alert reproduced from its query");
  const evidence = shape<Evidence>(await inv.alertEvidence(alertId, { maxEvents: 1000, deadlineMs: 5000 }));
  const sql = evidence.evidence.reproduce.sql;
  out(`   completeness=${evidence.completeness.status} events=${evidence.events.map((e) => e.id)}`);
  const reproduced = await relata.query(sql);
  out(`   ${sql}\n   -> ${reproduced.rows.length} rows`);

  step("4. Timeline");
  const timeline = shape<Timeline>(await inv.alertTimeline(alertId));
  for (const entry of timeline.entries) {
    out(`   ${entry.at_ns}  ${entry.kind.padEnd(13)} ${entry.id ?? entry.to ?? ""}`);
  }
  out(`   pivot entities: ${JSON.stringify(timeline.entities)}`);

  step("5. Authorized pivot on the alert's user");
  const pivot = shape<Pivot>(await inv.pivot(alertId, { targetTypes: ["Session", "AuthEvent"], limit: 50 }));
  for (const result of pivot.results) {
    out(`   ${result.object_type}: ${result.rows.map((r) => r.id)} (truncated=${result.truncated})`);
  }
  out(`   completeness=${pivot.completeness.status}`);

  step("6. Saved search");
  const listed = shape<{ items: Saved[] }>(await inv.listSavedSearches({ q: SEARCH_NAME }));
  const existing = listed.items.find((s) => s.name === SEARCH_NAME);
  const def = { name: SEARCH_NAME, sql, purpose: PURPOSE };
  const saved = shape<Saved>(
    existing ? await inv.updateSavedSearch(existing.id, def) : await inv.createSavedSearch(def),
  );
  const run = shape<{ data?: unknown[] }>(await inv.runSavedSearch(saved.id));
  out(`   ${saved.id} v${saved.version} -> ${(run.data ?? []).length} rows`);

  step("7. Archive the evidence export and check its SHA-256");
  const record = new TextEncoder().encode(JSON.stringify(evidence));
  const digest = sha256(record);
  const key = `cases/${alertId}/evidence.json`;
  await files.put(key, record, { contentType: "application/json" });
  const stored = await files.get(key);
  if (sha256(stored.data) !== digest) fatal(`archived ${key} does not match its SHA-256`, 2);
  out(`   ${key} sha256=${digest} (verified on read-back)`);
  out(`   events_sha256=${evidence.export.events_sha256}`);
}

await main().catch(exitOnRelataError);
