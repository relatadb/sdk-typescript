/**
 * document-ingest.ts — submit prepared document rows (#5743).
 *
 * Extraction and chunking happen in an external processor or adapter; the
 * server accepts only governed `DocumentSource`/`DocumentChunk` rows.
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/document-ingest.ts
 */

import { createClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "rag" });

async function main(): Promise<void> {
  banner("Prepared document ingest");
  const receipt = await relata.ingestDocument([
    { _type: "DocumentSource", _pk: "rpt-1", report_id: "rpt-1", source_filename: "paper.pdf", parser: "my-adapter", status: "complete", total_chunks: 2 },
    { _type: "DocumentChunk", _pk: "rpt-1:c0", chunk_id: "rpt-1:c0", report_id: "rpt-1", sequence_index: 0, prev_chunk_id: null, next_chunk_id: "rpt-1:c1", page_start: 1, page_end: 1, section_path: "Abstract", text_body: "First chunk." },
    { _type: "DocumentChunk", _pk: "rpt-1:c1", chunk_id: "rpt-1:c1", report_id: "rpt-1", sequence_index: 1, prev_chunk_id: "rpt-1:c0", next_chunk_id: null, page_start: 2, page_end: 2, section_path: "Methods", text_body: "Second chunk." },
  ]);
  out(`queued ${receipt.rowsQueued}, rejected ${receipt.rowsRejected}`);
  let status = await relata.ingestDocumentStatus(receipt.taskId);
  for (let i = 0; i < 40 && status.status === "pending"; i++) {
    await new Promise((r) => setTimeout(r, 250));
    status = await relata.ingestDocumentStatus(receipt.taskId);
  }
  // Only "complete" means every requested row was written.
  out(`${status.status}: ${status.rowsWritten}/${status.rowsTotal}`);
}

await main().catch(exitOnRelataError);
