/**
 * multi-search.ts — federated multi-query search in one round-trip (#967).
 *
 * `POST /multi-search` lets you query N types (or N query strings) in a single
 * HTTP call. The server runs each query in parallel and returns a combined
 * result envelope with `processingTimeMs` for the whole batch.
 *
 * Run:
 *   RELATA_TOKEN=secret NEEDLE=alice \
 *     node --experimental-strip-types examples/multi-search.ts
 */

import { createClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const needle = process.env.NEEDLE ?? "alice";
const relata = createClient(url, { bearerToken: token, defaultPurpose: "analytics" });

interface SubResult { hits?: unknown[]; estimatedTotalHits?: number; total?: number }

function printMulti(resp: { results?: SubResult[]; processingTimeMs?: number }, label: string): void {
  const results = resp.results ?? [];
  out(`${label}: ${results.length} sub-query result set(s) in ${resp.processingTimeMs ?? 0} ms`);
  results.forEach((sub, i) => {
    const hits = sub.hits?.length ?? 0;
    const total = sub.estimatedTotalHits ?? sub.total ?? 0;
    out(`  [${i}] hits returned=${hits}, estimated total=${total}`);
  });
}

async function main(): Promise<void> {
  banner(`1. Multi-search across 3 types for '${needle}'`);
  printMulti(
    await relata.multiSearch([
      { query: needle, type: "Person", limit: 5 },
      { query: needle, type: "EmailAddress", limit: 5 },
      { query: needle, type: "PhoneCall", limit: 5 },
    ]),
    "federated"
  );

  step("2. Multi-search: same type, different queries");
  printMulti(
    await relata.multiSearch([
      { query: "alice", type: "Person", limit: 3 },
      { query: "bob", type: "Person", limit: 3 },
      { query: "carol", type: "Person", limit: 3 },
    ]),
    "multi-query"
  );

  step("3. With matchingStrategy='all' + typoTolerance");
  printMulti(
    await relata.multiSearch([
      {
        query: needle,
        type: "Person",
        limit: 5,
        matchingStrategy: "all",
      },
    ]),
    "strategy"
  );
}

await main().catch(exitOnRelataError);
