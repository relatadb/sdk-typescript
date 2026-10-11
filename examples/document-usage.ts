import { createClient, recordUsage } from "../src/index.ts";

// Install packages/ontology/v1/document-usage.json and grant this tenant
// permission to append DocumentUsageEvent before running the example.
const bearerToken = process.env["RELATA_BEARER_TOKEN"];
const tenant = process.env["RELATA_TENANT"];
if (!tenant) throw new Error("Set RELATA_TENANT to the destination tenant ID");
const client = createClient(process.env["RELATA_URL"] ?? "http://localhost:9090", {
  ...(bearerToken ? { bearerToken } : {}),
  tenant,
});

const receipt = await recordUsage(client, {
  // Keep this key stable if the request is retried after a lost response.
  idempotencyKey: "answer-42:citation-1",
  target: { object_type: "DocumentSource", key: "report_id", value: "report-42" },
  purpose: "rag-usage",
  cited: true,
  retrieved: true,
});
console.log(receipt);
await client.close();
