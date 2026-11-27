/**
 * #6778 — exportData decodes /v1/export by the response Content-Type: csv comes
 * back as text under `content` instead of `{error: "<csv>"}` or `{}`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RelataClient } from "./client.ts";
import { decodeResponseBody } from "./_body.ts";
import { RelataError } from "./errors.ts";

const BASE = "http://localhost:9090";
const CSV = "_pk,name,email\np1,Ada,ada@example.com\np2,Bob,bob@example.com\n";

function client(status: number, body: string, contentType: string): RelataClient {
  const fetch = (async () =>
    new Response(status === 204 ? null : body, {
      status,
      headers: { "content-type": contentType },
    })) as typeof globalThis.fetch;
  return new RelataClient({ baseUrl: BASE, bearerToken: "t", fetch, maxRetries: 0 });
}

test("exportData csv with rows returns the text under content", async () => {
  const out = await client(200, CSV, "text/csv").exportData("Person", "csv");
  assert.deepEqual(out, { type: "Person", format: "csv", content: CSV });
});

test("exportData csv for an empty type returns empty content, not {}", async () => {
  const out = await client(200, "", "text/csv").exportData("Empty", "csv");
  assert.deepEqual(out, { type: "Empty", format: "csv", content: "" });
});

test("exportData json is still parsed", async () => {
  const body = JSON.stringify({ type: "Person", format: "json", rows: 1, data: [{ _pk: "p1" }] });
  const out = await client(200, body, "application/json").exportData("Person");
  assert.deepEqual(out, { type: "Person", format: "json", rows: 1, data: [{ _pk: "p1" }] });
});

test("exportData stix (application/stix+json) is parsed as JSON", async () => {
  const body = JSON.stringify({ type: "bundle", objects: [] });
  const out = await client(200, body, "application/stix+json").exportData("P", "stix");
  assert.deepEqual(out, { type: "bundle", objects: [] });
});

test("exportData jsonl returns the text under content", async () => {
  const body = '{"_pk":"p1"}\n';
  const out = await client(200, body, "application/x-ndjson").exportData("Person", "jsonl");
  assert.equal(out["content"], body);
});

test("exportData error still raises a RelataError", async () => {
  const body = JSON.stringify({ title: "Bad Request", status: 400, detail: "unknown type" });
  await assert.rejects(
    client(400, body, "application/problem+json").exportData("Nope", "csv"),
    RelataError,
  );
});

test("decodeResponseBody picks JSON, text or bytes by media type", () => {
  const enc = new TextEncoder();
  assert.deepEqual(decodeResponseBody("application/json", enc.encode('{"a":1}')), { a: 1 });
  assert.deepEqual(decodeResponseBody("", new Uint8Array()), {});
  assert.equal(decodeResponseBody("text/csv; charset=utf-8", enc.encode("a,b\n")), "a,b\n");
  const raw = new Uint8Array([0, 1]);
  assert.equal(decodeResponseBody("application/octet-stream", raw), raw);
});
