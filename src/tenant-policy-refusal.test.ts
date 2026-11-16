// #5696: the SDK surfaces an ACL denial and a tenant refusal, never an empty success.
// Wire bodies are the shared fixtures `forbidden_403_acl_denied` and
// `forbidden_403_org_not_entitled`, replayed against the live binary by the Rust test
// http_e2e::contract_matrix::problem_fixtures_match_live_server. Each high-level call on the
// probed surfaces (query, alerts, audit log, lookups, quarantine) must reject with
// ForbiddenError carrying the server's code; resolving to an empty list or page would hide the
// refusal from the application.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RelataClient } from "./index.ts";
import { AuditClient } from "./audit.ts";
import { GovernanceClient } from "./governance.ts";
import { IdentityClient } from "./identity.ts";
import { IngestControlClient } from "./ingest-control.ts";
import * as errors from "./errors.ts";

interface Case {
  name: string;
  wire: { status: number; headers: Record<string, string>; body: unknown };
  expect: { code: string | null };
}

const cases = new Map(
  (
    JSON.parse(
      readFileSync(new URL("../tests/fixtures/problem-details-fixtures.json", import.meta.url), "utf8"),
    ) as { cases: Case[] }
  ).cases.map((c) => [c.name, c]),
);

for (const [name, tenant] of [
  ["forbidden_403_acl_denied", undefined],
  ["forbidden_403_org_not_entitled", "tenant-b"],
] as const) {
  test(`${name}: every probed call rejects with ForbiddenError`, async () => {
    const c = cases.get(name);
    assert.ok(c, `fixture ${name} missing`);
    const sentTenants: (string | null)[] = [];
    const f: typeof globalThis.fetch = async (input, init) => {
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      sentTenants.push(headers.get("X-Relata-Tenant-Id"));
      return new Response(JSON.stringify(c.wire.body), {
        status: c.wire.status,
        headers: c.wire.headers,
      });
    };
    const client = new RelataClient({
      baseUrl: "http://relata.invalid",
      bearerToken: "t",
      defaultPurpose: "investigation",
      maxRetries: 0,
      fetch: f,
      ...(tenant === undefined ? {} : { tenant }),
    });
    const gov = GovernanceClient.fromClient(client);
    const audit = AuditClient.fromClient(client);
    const identity = IdentityClient.fromClient(client);
    const ingest = IngestControlClient.fromClient(client);
    const calls: Record<string, () => Promise<unknown>> = {
      query: () => client.query("SELECT * FROM ProbeEvt"),
      listAlerts: () => gov.listAlerts(),
      auditLog: () => audit.log(),
      auditCount: () => audit.count(),
      listLookups: () => identity.listLookups(),
      invokeLookup: () => identity.invokeLookup("hosts", "10.0.0.1"),
      listQuarantine: () => ingest.listQuarantine(),
    };
    for (const [call, run] of Object.entries(calls)) {
      let caught: unknown;
      let result: unknown;
      try {
        result = await run();
      } catch (e) {
        caught = e;
      }
      assert.ok(
        caught instanceof errors.ForbiddenError,
        `${call} resolved to ${JSON.stringify(result)} or threw ${String(caught)}`,
      );
      assert.equal(caught.statusCode, 403, call);
      assert.equal(caught.code ?? null, c.expect.code, call);
      assert.equal(caught.retryable, false, call);
    }
    // The tenant the application named is what the server refused: it went on every call.
    assert.equal(sentTenants.length, Object.keys(calls).length);
    for (const t of sentTenants) assert.equal(t, tenant ?? null);
  });
}
