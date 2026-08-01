/**
 * Tests for #2321 (ADR-0261): the admin control-plane listener split.
 *
 * /admin/* and /platform/* are mounted ONLY on the loopbound admin listener
 * (RELATA_ADMIN_BIND, default 127.0.0.1:9091) on a hardened server/cluster
 * deployment -- never the main data-plane listener. These tests pin two
 * things:
 *
 * 1. `adminBaseUrl`, when configured (on `RelataClient` or directly on a
 *    typed client's constructor options), routes admin/platform-only
 *    requests to the admin listener instead of `baseUrl` -- spot-checked
 *    through the real `BackupClient`/`TenantAdminClient` typed clients.
 * 2. A bare, detail-free 404 against an admin/platform-only path -- the
 *    shape the server's own RFC 7807 normalisation leaves behind for a
 *    request that matched no route on the listener that answered --
 *    surfaces a "you're probably pointed at the wrong port" hint instead of
 *    an uninformative bare 404.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { adminListenerHint, isAdminOnlyPath, responseDetailIsBlank } from "./_typed-http.ts";
import { BackupClient, RelataClient, TenantAdminClient } from "./index.ts";

// ---------------------------------------------------------------------------
// Pure helper unit tests
// ---------------------------------------------------------------------------

test("isAdminOnlyPath matches /admin/* and /platform/* only", () => {
  assert.ok(isAdminOnlyPath("/admin/backup"));
  assert.ok(isAdminOnlyPath("/platform/tenants"));
  assert.ok(!isAdminOnlyPath("/query"));
  assert.ok(!isAdminOnlyPath("/tenants/me"));
  assert.ok(!isAdminOnlyPath("/administer")); // no trailing slash after "admin"
});

test("responseDetailIsBlank: true for the bare normalized-404 shape", () => {
  assert.ok(
    responseDetailIsBlank(true, { type: "about:blank", status: 404, title: "Not Found", detail: "" }),
  );
});

test("responseDetailIsBlank: true for a genuinely empty/whitespace body", () => {
  assert.ok(responseDetailIsBlank(false, ""));
  assert.ok(responseDetailIsBlank(false, "   "));
  assert.ok(responseDetailIsBlank(true, {}));
});

test("responseDetailIsBlank: false for a real business 404", () => {
  assert.ok(
    !responseDetailIsBlank(true, {
      type: "about:blank",
      status: 404,
      title: "Not Found",
      detail: "tenant 'acme' not found",
    }),
  );
  assert.ok(!responseDetailIsBlank(false, "restore job not found"));
});

test("adminListenerHint names the path and env var", () => {
  const hint = adminListenerHint("/admin/backup");
  assert.ok(hint.includes("/admin/backup"));
  assert.ok(hint.includes("RELATA_ADMIN_BIND"));
  assert.ok(hint.includes("adminBaseUrl"));
});

// ---------------------------------------------------------------------------
// adminBaseUrl routing (through the real typed clients)
// ---------------------------------------------------------------------------

function mockFetchByHost(
  handler: (url: URL) => { status?: number; headers?: Record<string, string>; body?: unknown },
): typeof globalThis.fetch {
  return (async (url: string | URL | Request): Promise<Response> => {
    const u = new URL(typeof url === "string" ? url : url.toString());
    const r = handler(u);
    const headerMap = new Headers();
    for (const [k, v] of Object.entries(r.headers ?? {})) headerMap.set(k, v);
    headerMap.set("content-type", headerMap.get("content-type") ?? "application/json");
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: headerMap,
    });
  }) as typeof globalThis.fetch;
}

test("BackupClient falls back to baseUrl when adminBaseUrl is unset", async () => {
  const hostsHit: string[] = [];
  const fetch = mockFetchByHost((u) => {
    hostsHit.push(u.host);
    return { body: { backups: [] } };
  });
  const backup = new BackupClient({ baseUrl: "http://data-plane.example", fetch });
  await backup.list();
  assert.deepEqual(hostsHit, ["data-plane.example"]);
});

test("BackupClient routes to adminBaseUrl when configured", async () => {
  const hostsHit: string[] = [];
  const fetch = mockFetchByHost((u) => {
    hostsHit.push(u.host);
    assert.equal(u.pathname, "/admin/backups");
    return { body: { backups: [] } };
  });
  const backup = new BackupClient({
    baseUrl: "http://data-plane.example",
    adminBaseUrl: "http://admin-plane.example",
    fetch,
  });
  await backup.list();
  assert.deepEqual(hostsHit, ["admin-plane.example"]);
});

test("TenantAdminClient splits /tenants/* and /platform/* across planes", async () => {
  const seenHosts: Record<string, string> = {};
  const fetch = mockFetchByHost((u) => {
    seenHosts[u.pathname] = u.host;
    return { body: { usage: {} } };
  });
  const tenants = new TenantAdminClient({
    baseUrl: "http://data-plane.example",
    adminBaseUrl: "http://admin-plane.example",
    fetch,
  });
  await tenants.usage(); // /tenants/usage -- ordinary data-plane route
  await tenants.platformUsage(); // /platform/usage -- admin-listener-only route

  assert.equal(seenHosts["/tenants/usage"], "data-plane.example");
  assert.equal(seenHosts["/platform/usage"], "admin-plane.example");
});

test("BackupClient.fromClient inherits adminBaseUrl from the parent RelataClient", async () => {
  const hostsHit: string[] = [];
  const fetch = mockFetchByHost((u) => {
    hostsHit.push(u.host);
    return { body: { backups: [] } };
  });
  const relata = new RelataClient({
    baseUrl: "http://data-plane.example",
    adminBaseUrl: "http://admin-plane.example",
    fetch,
  });
  assert.equal(relata.adminBaseUrl, "http://admin-plane.example");
  const backup = BackupClient.fromClient(relata);
  await backup.list();
  assert.deepEqual(hostsHit, ["admin-plane.example"]);
});

// ---------------------------------------------------------------------------
// "You're probably pointed at the wrong port" hint
// ---------------------------------------------------------------------------

function mockFetchFixed(status: number, body: unknown): typeof globalThis.fetch {
  return (async (): Promise<Response> => {
    const headerMap = new Headers({ "content-type": "application/problem+json" });
    return new Response(JSON.stringify(body), { status, headers: headerMap });
  }) as typeof globalThis.fetch;
}

test("bare 404 against an admin-only path surfaces the wrong-port hint", async () => {
  // The shape normalize_error_body (crates/relata-cli/src/serve.rs) leaves
  // behind for a request that matched no route on the listener that
  // answered.
  const fetch = mockFetchFixed(404, {
    type: "about:blank",
    status: 404,
    title: "Not Found",
    detail: "",
  });
  const backup = new BackupClient({ baseUrl: "http://x", fetch }); // adminBaseUrl unset
  await assert.rejects(
    () => backup.list(),
    (err: Error) => {
      assert.ok(err.message.includes("RELATA_ADMIN_BIND"), err.message);
      assert.ok(err.message.includes("/admin/backups"), err.message);
      return true;
    },
  );
});

test("real business 404 on a /platform/* route does not get the hint", async () => {
  const fetch = mockFetchFixed(404, {
    type: "about:blank",
    status: 404,
    title: "Not Found",
    detail: "tenant 'acme' not found",
  });
  const tenants = new TenantAdminClient({ baseUrl: "http://x", fetch });
  await assert.rejects(
    () => tenants.get("acme"),
    (err: Error) => {
      assert.ok(!err.message.includes("RELATA_ADMIN_BIND"), err.message);
      assert.ok(err.message.includes("tenant 'acme' not found"), err.message);
      return true;
    },
  );
});

test("bare 404 on a data-plane path does not get the hint", async () => {
  const fetch = mockFetchFixed(404, {
    type: "about:blank",
    status: 404,
    title: "Not Found",
    detail: "",
  });
  const tenants = new TenantAdminClient({ baseUrl: "http://x", fetch });
  await assert.rejects(
    () => tenants.tenantUsage("acme"), // /tenants/:id/usage -- not admin/platform-only
    (err: Error) => {
      assert.ok(!err.message.includes("RELATA_ADMIN_BIND"), err.message);
      return true;
    },
  );
});
