/**
 * tokens.ts — dedup-token primitive (replay defence, #84).
 *
 * Flow:
 *   1. `remember(tokenId)` → true on first insert, false on duplicate
 *   2. `check(tokenId)`    → presence probe without mutation
 *   3. `stats()`           → dedup-set size, oldest entry, eviction policy
 *   4. `revoke(tokenId)`   → explicit removal (admin only)
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
  const tokenId = "replay-defence-7QT3";

  banner(`1. remember('${tokenId}')`);
  const first = await tokens.remember(tokenId, { ttlSecs: 3600 });
  out(`first call:  newly_inserted=${first}  (expected true)`);
  const second = await tokens.remember(tokenId, { ttlSecs: 3600 });
  out(`second call: newly_inserted=${second}  (expected false — duplicate)`);

  step(`2. check('${tokenId}')`);
  const info = await tokens.check(tokenId);
  out(`present=${info.present}  inserted_at_ns=${info.inserted_at_ns}  ttl=${info.ttl_secs}`);

  step("3. stats()");
  const s = await tokens.stats();
  out(`TokenStats(count=${s.count}, oldest_ns=${s.oldest_ns}, eviction_policy=${s.eviction_policy})`);

  step(`4. revoke('${tokenId}')`);
  try {
    const revoked = await tokens.revoke(tokenId);
    out(`revoked=${revoked}`);
  } catch (err) {
    out(`(revoke requires admin — ${(err as Error).message})`);
  }
}

await main().catch(exitOnRelataError);
