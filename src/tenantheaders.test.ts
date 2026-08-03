/**
 * #3213 — Flight + S3 tenant/delegation header threading (TypeScript mirror).
 *
 * With tenant/actingAs/delegatedBy set, both queryFlight and S3Client must send
 * X-Relata-Tenant-Id / X-Acting-As / X-Delegated-By (or gRPC-metadata
 * equivalents) plus a per-request X-Request-ID, so the doors resolve the
 * caller's tenant instead of falling back to the default tenant.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RelataClient } from "./client.ts";
import { S3Client } from "./s3.ts";

test("queryFlight: threads tenant/acting-as/delegated-by/request-id to the transport", async () => {
  const relata = new RelataClient({
    baseUrl: "http://localhost:9090",
    bearerToken: "tok",
    tenant: "org-acme",
    actingAs: "alice",
    delegatedBy: "root-admin",
  });
  let captured: Record<string, string> | undefined;
  await relata.queryFlight("SELECT 1", {
    purpose: "analytics",
    transport: async (_endpoint, _ticket, _bearer, headers) => {
      captured = headers;
      return null;
    },
  });
  assert.equal(captured?.["x-relata-tenant-id"], "org-acme");
  assert.equal(captured?.["x-acting-as"], "alice");
  assert.equal(captured?.["x-delegated-by"], "root-admin");
  assert.ok(captured?.["x-request-id"], "expected a per-request X-Request-ID");
});

test("queryFlight: request-id is per-request (distinct across calls)", async () => {
  const relata = new RelataClient({ baseUrl: "http://localhost:9090", tenant: "t" });
  const ids: string[] = [];
  const transport = async (_e: string, _t: string, _b: string | undefined, h?: Record<string, string>) => {
    if (h?.["x-request-id"]) ids.push(h["x-request-id"]);
    return null;
  };
  await relata.queryFlight("SELECT 1", { transport });
  await relata.queryFlight("SELECT 2", { transport });
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test("S3Client: http() sends tenant/acting-as/delegated-by + request-id", async () => {
  const calls: Array<{ headers: Record<string, string> }> = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({ headers });
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;

  const s3 = new S3Client("http://localhost:9090", {
    bearerToken: "tok",
    tenant: "org-acme",
    actingAs: "alice",
    delegatedBy: "root-admin",
    fetch,
  });
  await s3.putObject("bucket", "key", "data");

  const h = calls[0]?.headers ?? {};
  assert.equal(h["authorization"], "Bearer tok");
  assert.equal(h["x-relata-tenant-id"], "org-acme");
  assert.equal(h["x-acting-as"], "alice");
  assert.equal(h["x-delegated-by"], "root-admin");
  assert.ok(h["x-request-id"], "expected a per-request X-Request-ID");
});

test("S3Client: fromClient inherits the parent delegation scope", async () => {
  const calls: Array<{ headers: Record<string, string> }> = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({ headers });
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;

  const relata = new RelataClient({
    baseUrl: "http://localhost:9090",
    bearerToken: "tok",
    tenant: "org-acme",
    actingAs: "alice",
    delegatedBy: "root-admin",
    fetch,
  });
  const s3 = S3Client.fromClient(relata);
  await s3.getObject("bucket", "key");

  const h = calls[0]?.headers ?? {};
  assert.equal(h["x-relata-tenant-id"], "org-acme");
  assert.equal(h["x-acting-as"], "alice");
  assert.equal(h["x-delegated-by"], "root-admin");
  assert.ok(h["x-request-id"], "expected a per-request X-Request-ID");
});
