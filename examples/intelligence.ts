/**
 * intelligence.ts — chained KYC / sanctions sweep (#967).
 *
 * Demonstrates the typed intelligence operators on the TS client:
 *   - sanctionsScreen             — fuzzy-match a party against sanction lists
 *   - beneficialOwnershipChain    — trace to ultimate beneficial owner (UBO)
 *   - cryptoTrace                 — follow cryptocurrency fund flow
 *   - convoyDetect                — find entities travelling together
 *   - dnsTunnelDetect             — exfiltration over DNS
 *
 * Each maps to an intelligence TVF documented in
 * `docs/src/end-users/sql-grammar.md` (ADRs 109–115). Each call goes through
 * the governed query path — purpose is audited and ACLs apply.
 *
 * Run:
 *   RELATA_TOKEN=secret TARGET_PARTY="Acme Holdings Ltd" \
 *     node --experimental-strip-types examples/intelligence.ts
 */

import { createClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const target = process.env.TARGET_PARTY ?? "Acme Holdings Ltd";
const relata = createClient(url, {
  bearerToken: token,
  defaultPurpose: "investigation",
});

interface Row { [k: string]: unknown }

async function main(): Promise<void> {
  banner(`1. SANCTIONS_SCREEN: ${target} (threshold=0.85)`);
  const hits = (await relata.sanctionsScreen(target, { threshold: 0.85, purpose: "investigation" })) as
    | { rows?: Row[] }
    | undefined;
  const hitRows = hits?.rows ?? [];
  out(`${hitRows.length} potential hit(s)`);
  for (const row of hitRows.slice(0, 5)) {
    out(`  list=${String(row.list ?? "?").padEnd(20)} score=${row.score}  match=${row.matched_name ?? "?"}`);
  }

  step(`2. BENEFICIAL_OWNERSHIP_CHAIN: ${target} (max_depth=5)`);
  const chain = (await relata.beneficialOwnershipChain(target, { maxDepth: 5, purpose: "investigation" })) as
    | { rows?: Row[]; layers?: Row[] }
    | undefined;
  const layers = chain?.rows ?? chain?.layers ?? [];
  out(`${layers.length} layer(s) to UBO:`);
  layers.forEach((layer, i) => {
    const share = typeof layer.share === "number" ? layer.share * 100 : 0;
    out(
      `  ${i + 1}. ${String(layer.entity ?? "?").padEnd(30)} owns ${share.toFixed(2)}%  via ${layer.instrument ?? "?"}`,
    );
  });

  step(`3. CRYPTO_TRACE: ${target}`);
  const trace = (await relata.cryptoTrace(target, "investigation")) as { rows?: Row[] } | undefined;
  const hops = trace?.rows ?? [];
  out(`${hops.length} hop(s) in fund-flow graph`);
  hops.slice(0, 10).forEach((hop, i) => {
    out(`  ${String(i + 1).padStart(2)}. ${hop.from ?? "?"} → ${hop.to ?? "?"}  amount=${hop.amount}`);
  });

  step("4. CONVOY_DETECT: radius=200m, time_tol=300s, min_points=2");
  const convoys = (await relata.convoyDetect({
    radiusM: 200,
    timeTolSecs: 300,
    minPoints: 2,
    purpose: "investigation",
  })) as { rows?: Row[] } | undefined;
  const cRows = convoys?.rows ?? [];
  out(`${cRows.length} convoy(s) detected`);
  for (const row of cRows.slice(0, 5)) {
    out(`  convoy_id=${row.convoy_id ?? "?"}  members=${row.members}  first_seen=${row.first_seen}`);
  }

  step(`5. DNS_TUNNEL_DETECT: ${target}`);
  const dns = (await relata.dnsTunnelDetect(target, "investigation")) as { rows?: Row[] } | undefined;
  const dRows = dns?.rows ?? [];
  out(`${dRows.length} anomalous DNS pattern(s)`);
  for (const row of dRows.slice(0, 5)) {
    out(
      `  domain=${String(row.domain ?? "?").padEnd(30)} entropy=${row.entropy} bytes=${row.bytes_exchanged}`,
    );
  }
}

await main().catch(exitOnRelataError);
