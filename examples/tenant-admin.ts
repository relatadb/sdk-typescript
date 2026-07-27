/**
 * tenant-admin.ts — multi-tenant lifecycle (#967).
 *
 * Demonstrates the typed `TenantAdminClient`: whoami + usage, CRUD on tenants,
 * tier management, suspend / reactivate, per-tenant quota, sharing agreements,
 * platform-wide usage / license.
 *
 * Requires an admin-scoped bearer token. Run against a server started with
 * `RELATA_TENANCY_MODE=multi` and an admin token.
 *
 * Run:
 *   RELATA_TOKEN=<admin-token> node --experimental-strip-types examples/tenant-admin.ts
 */

import { createClient, TenantAdminClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "admin" });
const admin = TenantAdminClient.fromClient(relata);

function randomId(): string {
  return `tenant-${Math.random().toString(16).slice(2, 10)}`;
}

async function main(): Promise<void> {
  banner("1. me() + usage()");
  try {
    const me = (await admin.me()) as { tenant_id?: string; tier?: string };
    out(`tenant_id=${me.tenant_id}  tier=${me.tier}`);
    const usage = await admin.usage();
    out(`usage: ${JSON.stringify(usage).slice(0, 200)}`);
  } catch (err) {
    out(`admin endpoints require admin token — ${(err as Error).message}`);
    return;
  }

  const newId = randomId();
  step(`2. create('${newId}')`);
  try {
    const created = await admin.create(newId, { tier: "free" });
    out(`created: ${JSON.stringify(created).slice(0, 200)}`);
  } catch (err) {
    out(`create failed — ${(err as Error).message}`);
    return;
  }

  step(`3. setTier('${newId}', 'server') + setQuota(1_000_000)`);
  try {
    out(`setTier: ${JSON.stringify(await admin.setTier(newId, "server"))}`);
    out(`setQuota: ${JSON.stringify(await admin.setQuota(newId, 1_000_000))}`);
  } catch (err) {
    out(`failed — ${(err as Error).message}`);
  }

  step(`4. suspend('${newId}') → reactivate('${newId}')`);
  try {
    out(`suspend: ${JSON.stringify(await admin.suspend(newId))}`);
    out(`reactivate: ${JSON.stringify(await admin.reactivate(newId))}`);
  } catch (err) {
    out(`failed — ${(err as Error).message}`);
  }

  step(`5. tenantUsage('${newId}') + listSharing`);
  try {
    out(`tenantUsage: ${JSON.stringify(await admin.tenantUsage(newId))}`);
    const sharing = await admin.listSharing(newId);
    out(`sharing: ${Array.isArray(sharing) ? sharing.length : 0} agreement(s)`);
  } catch (err) {
    out(`failed — ${(err as Error).message}`);
  }

  step("6. platformUsage()");
  try {
    out(`platform usage: ${JSON.stringify(await admin.platformUsage()).slice(0, 200)}`);
  } catch (err) {
    out(`failed — ${(err as Error).message}`);
  }
}

await main().catch(exitOnRelataError);
