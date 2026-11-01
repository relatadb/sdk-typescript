/**
 * cdr-ingest.ts — telecom CDR rows through the SDK adapter (#5744).
 *
 * The server has no telecom parser: `ingestCdr` maps aliases to canonical
 * `CdrRecord` rows and posts them to generic `POST /v1/ingest`. Register the
 * type once with the `telco-cdr` schema package.
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/cdr-ingest.ts
 */

import { createClient, IngestClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "investigation" });
const ingest = IngestClient.fromClient(relata);

async function main(): Promise<void> {
  banner("CDR adapter ingest");
  const receipt = await ingest.ingestCdr([
    { a_number: "+971 50 123 4567", b_number: "971507654321", timestamp: "2026-01-01T00:00:00Z", duration: 60, cell_id: "CELL-042", type: "voice" },
    { caller: "971501111111", callee: "971502222222", start: 1735689700, site: "CELL-007", record_type: "sms" },
    { caller: "not-a-number" },
  ]);
  out(`row errors: ${JSON.stringify(receipt["errors"])}`);
  const taskId = receipt["task_id"];
  if (typeof taskId === "string") {
    // Acceptance is not durability: poll the generic task for the outcome.
    let status = await relata.ingestDocumentStatus(taskId);
    for (let i = 0; i < 20 && status.status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      status = await relata.ingestDocumentStatus(taskId);
    }
    out(`${status.status}: ${status.rowsWritten} written, ${status.rowsDropped} dropped`);
  }
}

await main().catch(exitOnRelataError);
