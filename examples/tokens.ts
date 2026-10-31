/**
 * tokens.ts — tenant self-service API tokens.
 *
 * Flow:
 *   1. `listSelf()`    → the caller's own tokens
 *   2. `selfAudit()`   → audit trail of those tokens
 *   3. `rotateSelf()`  → rotate the caller's token (optional, destructive)
 *   4. `revokeSelf(id)`→ revoke one of the caller's own tokens
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/tokens.ts
 */

import { createClient, TokenClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "admin" });
const tokens = TokenClient.fromClient(relata);

async function main(): Promise<void> {
  banner("1. listSelf()");
  const mine = await tokens.listSelf();
  out(JSON.stringify(mine).slice(0, 200));

  step("2. selfAudit()");
  const audit = await tokens.selfAudit();
  out(JSON.stringify(audit).slice(0, 200));

  // rotateSelf() and revokeSelf(id) invalidate credentials, so they are shown
  // but not run by default:
  //   const rotated = await tokens.rotateSelf();
  //   await tokens.revokeSelf("<token-id>");
  step("3. rotateSelf() / revokeSelf(id) — see comments in this file");
}

await main().catch(exitOnRelataError);
