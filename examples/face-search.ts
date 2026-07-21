/**
 * face-search.ts — MATCH_FACE operator example.
 *
 * Demonstrates how to use the Relata MATCH_FACE operator to search CCTV
 * footage stills and mugshot databases for matches against a probe image.
 *
 * MATCH_FACE is a vector-similarity operator backed by the DiskANN index
 * (SPECS §5.23 / ADR-048). Results include a `face_score` (0–1) and the
 * associated object-type identity cross-referenced with the IdentityIndex.
 *
 * NOTE: The image is supplied as a base64-encoded JPEG/PNG string in the
 * SQL literal. For large images use the object-store ingest path instead.
 *
 * Run:
 *   node --experimental-strip-types examples/face-search.ts
 */

import { createClient, type QueryResult, ForbiddenError } from "../src/index.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FaceMatch {
  match_id: string;
  person_id: string | null;
  name: string | null;
  face_score: number;          // 0.0–1.0, higher = more confident
  source_type: string;         // "CctvFootage" | "MugshotImage" | "IdPhoto"
  source_ref: string;          // Reference to the originating record
  captured_at: string;
  location?: string;
}

interface PersonDetail {
  id: string;
  name: string;
  msisdn?: string;
  warrants?: string;           // JSON array of active warrant refs
  risk_score?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a JPEG/PNG file to a base64 string for embedding in SQL. */
async function imageToBase64(filePath: string): Promise<string> {
  const absolute = resolve(filePath);
  const buf = await readFile(absolute);
  return buf.toString("base64");
}

/** Load a probe image (or fall back to a placeholder for the demo). */
async function loadProbeImage(): Promise<string> {
  const probePath = process.env["PROBE_IMAGE"] ?? "./probe.jpg";
  try {
    return await imageToBase64(probePath);
  } catch {
    // Demo mode: return a tiny placeholder base64 JPEG (1×1 pixel)
    console.warn(`  [demo] PROBE_IMAGE not set; using 1×1 placeholder`);
    return "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=";
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const RELATA_URL = process.env["RELATA_URL"] ?? "http://localhost:9090";

const relata = createClient(RELATA_URL, {
  bearerToken: process.env["RELATA_TOKEN"],
  defaultPurpose: "analytics",
  timeoutMs: 60_000,  // face search can take longer
});

console.log("=== Relata MATCH_FACE Demo ===\n");

// Verify health
const health = await relata.health();
console.log(`Server: ${health.nodeId} (${health.profile})\n`);

// Load probe image
console.log("Loading probe image...");
const probeB64 = await loadProbeImage();
console.log(`  Probe size: ${probeB64.length} base64 chars\n`);

// ---------------------------------------------------------------------------
// 1. Search mugshot + CCTV databases for face matches
// ---------------------------------------------------------------------------

console.log("Step 1: MATCH_FACE across all visual records (threshold 0.70)");

let faceMatches: QueryResult<FaceMatch> | null = null;

try {
  faceMatches = await relata.query<FaceMatch>(
    `SELECT
       match_id,
       person_id,
       name,
       face_score,
       source_type,
       source_ref,
       captured_at,
       location
     FROM MATCH_FACE(
       image_bytes    => '${probeB64}',
       threshold      => 0.70,
       source_types   => ARRAY['MugshotImage', 'CctvFootage', 'IdPhoto'],
       max_results    => 50
     )
     ORDER BY face_score DESC
     LIMIT 50`,
    { purpose: "analytics" },
  );

  console.log(`  Matches found: ${faceMatches.rowCount} (in ${faceMatches.elapsedMs}ms)`);
} catch (err) {
  if (err instanceof ForbiddenError) {
    console.warn("  Access denied to MATCH_FACE operator (Cedar ACL). Check your permissions.");
    process.exit(0);
  }
  throw err;
}

if (!faceMatches || faceMatches.rowCount === 0) {
  console.log("  No matches above threshold.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Print match summary
// ---------------------------------------------------------------------------

console.log("\nTop matches:");
for (const m of faceMatches.rows.slice(0, 5)) {
  const pct = (m.face_score * 100).toFixed(1);
  console.log(
    `  [${pct}%] ${m.name ?? "Unknown"} — ${m.source_type} @ ${m.captured_at}` +
    (m.location ? ` (${m.location})` : ""),
  );
}

// ---------------------------------------------------------------------------
// 3. Resolve person details for top match
// ---------------------------------------------------------------------------

const topMatch = faceMatches.rows[0];
if (!topMatch || !topMatch.person_id) {
  console.log("\nTop match has no associated person record (unregistered individual).");
  process.exit(0);
}

console.log(`\nStep 2: Resolve person detail for match ${topMatch.person_id}`);

const personResult = await relata.query<PersonDetail>(
  `SELECT id, name, msisdn, warrants, risk_score
   FROM Person
   WHERE id = '${topMatch.person_id}'`,
  { purpose: "analytics" },
);

const person = personResult.rows[0];
if (person) {
  console.log(`  Name       : ${person.name}`);
  console.log(`  MSISDN     : ${person.msisdn ?? "not on file"}`);
  console.log(`  Risk score : ${person.risk_score ?? "n/a"}`);
  console.log(`  Warrants   : ${person.warrants ?? "none"}`);
}

// ---------------------------------------------------------------------------
// 4. Check CCTV co-occurrence — who appeared near the matched person?
// ---------------------------------------------------------------------------

console.log("\nStep 3: CCTV co-occurrence (same frame ±30s of top match)");

interface CoOccurrence {
  other_person_id: string | null;
  other_name: string | null;
  face_score: number;
  captured_at: string;
  location: string;
  delta_seconds: number;
}

const coOccurrence = await relata.query<CoOccurrence>(
  `SELECT
     other_person_id,
     other_name,
     face_score,
     captured_at,
     location,
     delta_seconds
   FROM MATCH_FACE_CO_OCCURRENCE(
     reference_match_id => '${topMatch.match_id}',
     window_seconds     => 30,
     threshold          => 0.65
   )
   ORDER BY delta_seconds ASC
   LIMIT 20`,
  { purpose: "analytics" },
);

if (coOccurrence.rowCount > 0) {
  console.log(`  Co-present individuals: ${coOccurrence.rowCount}`);
  for (const co of coOccurrence.rows) {
    const pct = (co.face_score * 100).toFixed(1);
    console.log(
      `    [${pct}%] ${co.other_name ?? "Unknown"} — Δ${co.delta_seconds}s @ ${co.location}`,
    );
  }
} else {
  console.log("  No co-occurrences within window.");
}

// ---------------------------------------------------------------------------
// 5. Bi-temporal: check if person was flagged before the capture date
// ---------------------------------------------------------------------------

if (topMatch.captured_at) {
  const captureDate = topMatch.captured_at;
  console.log(`\nStep 4: Was person already classified as of ${captureDate}?`);

  const historicalClassification = await relata.query<{ classification: string }>(
    `SELECT classification
     FROM Person
     AS OF '${captureDate}'
     WHERE id = '${topMatch.person_id}'`,
    { purpose: "analytics" },
  );

  const classification = historicalClassification.rows[0]?.classification;
  console.log(`  Classification at capture time: ${classification ?? "none"}`);
}

console.log("\n=== Face search complete ===");
