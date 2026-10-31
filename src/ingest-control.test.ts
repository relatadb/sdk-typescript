import test from "node:test";
import assert from "node:assert/strict";
import { FilesClient, IngestControlClient, Memory, RelataClient } from "./index.ts";

type Seen = [string | undefined, string, string, unknown];

function recorder(status = 200, body: unknown = {}) {
  const seen: Seen[] = [];
  const f: typeof globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    seen.push([init?.method, u.pathname, u.search, init?.body ? JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as ArrayBuffer)) : null]);
    return status === 204 ? new Response(null, { status: 204 }) : Response.json(body, { status });
  };
  const client = new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "s", fetch: f });
  return { seen, f, client };
}

test("ingest control routes and bodies", async () => {
  const { seen, client } = recorder();
  const c = IngestControlClient.fromClient(client);
  await c.checkpoint("kafka/orders 1");
  await c.listContracts();
  await c.getContract("orders");
  await c.putContract("orders", { version: 2, fields: [] });
  await c.contractQuality("orders");
  await c.listQuarantine({ dataset: "orders", afterId: 5, limit: 50 });
  await c.listQuarantine();
  assert.deepEqual(seen, [
    ["GET", "/ingest/checkpoints/kafka%2Forders%201", "", null],
    ["GET", "/ingest/contracts", "", null],
    ["GET", "/ingest/contracts/orders", "", null],
    ["PUT", "/ingest/contracts/orders", "", { version: 2, fields: [] }],
    ["GET", "/ingest/contracts/orders/quality", "", null],
    ["GET", "/ingest/quarantine", "?dataset=orders&after_id=5&limit=50", null],
    ["GET", "/ingest/quarantine", "", null],
  ]);
});

test("quarantine delete expects 204 and surfaces 404", async () => {
  const ok = recorder(204);
  await IngestControlClient.fromClient(ok.client).deleteQuarantine(9);
  assert.deepEqual(ok.seen, [["DELETE", "/ingest/quarantine/9", "", null]]);
  const missing = recorder(404, { title: "nf", status: 404 });
  await assert.rejects(() => IngestControlClient.fromClient(missing.client).deleteQuarantine(1));
});

test("memory associateBatch fills purpose and validates ids", async () => {
  const { seen, f } = recorder(200, { stored: 2 });
  const m = new Memory("http://example.invalid", { purpose: "notes", fetch: f });
  const out = await m.associateBatch([
    { from_id: "a", to_id: "b", relation: "causes" },
    { from_id: "c", to_id: "d", purpose: "x" },
  ]);
  assert.deepEqual(out, { stored: 2 });
  assert.deepEqual(seen, [
    [
      "POST",
      "/memory/associate/batch",
      "",
      {
        items: [
          { purpose: "notes", from_id: "a", to_id: "b", relation: "causes" },
          { purpose: "x", from_id: "c", to_id: "d" },
        ],
      },
    ],
  ]);
  await assert.rejects(() => m.associateBatch([{ from_id: "a" }]));
});

test("files createFolder posts key and bucket", async () => {
  const folder = {
    bucket: "t", key: "a/", row_id: null, size: 0, etag: '"e"', content_type: "application/x-directory",
    modified_ns: 1, is_folder: true, download_url: "/files/content?key=a%2F",
  };
  const { seen, client } = recorder(201, folder);
  const meta = await FilesClient.fromClient(client).createFolder("a", { bucket: "t" });
  assert.equal(meta.is_folder, true);
  assert.deepEqual(seen, [["POST", "/files/folders", "", { key: "a", bucket: "t" }]]);
});
