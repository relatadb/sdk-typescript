/**
 * lookups.ts — CSV enrichment at query time via `/lookup/*` (#967 / #79).
 *
 * Lookup tables are small, read-only dictionaries the server joins into queries
 * at plan time. Classic use case: enriching a country code or currency code
 * into a human-readable label without denormalising it into every row.
 *
 * Flow:
 *   1. `registerLookup`  — upload name + CSV (keyColumn + valueColumns)
 *   2. `listLookups`     — confirm it landed
 *   3. `invokeLookup`    — read back one value by key
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/lookups.ts
 */

import { createClient, IdentityClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "analytics" });
const identity = IdentityClient.fromClient(relata);

const COUNTRY_CSV = `alpha2,alpha3,name
PK,PAK,Pakistan
IN,IND,India
AE,ARE,United Arab Emirates
SA,SAU,Saudi Arabia
`;

interface LookupMeta { name?: string; size?: number; entries?: number }

async function main(): Promise<void> {
  banner("1. registerLookup: country_alpha3");
  const registered = await identity.registerLookup("country_alpha3", COUNTRY_CSV, {
    keyColumn: "alpha2",
    valueColumns: ["alpha3", "name"],
  });
  out(`Registered: ${JSON.stringify(registered)}`);

  step("2. listLookups");
  const lookups = (await identity.listLookups()) as LookupMeta[];
  out(`${lookups.length} lookup(s) registered:`);
  for (const l of lookups.slice(0, 10)) {
    out(`  - ${l.name} (size=${l.size ?? l.entries ?? "?"})`);
  }

  step("3. invokeLookup: country_alpha3['PK']");
  const val = await identity.invokeLookup("country_alpha3", "PK");
  out(`PK → ${JSON.stringify(val)}`);

  step("4. invokeLookup: missing key 'ZZ'");
  try {
    const zz = await identity.invokeLookup("country_alpha3", "ZZ");
    out(`ZZ → ${JSON.stringify(zz)}`);
  } catch (err) {
    out(`Got expected error: ${(err as Error).message}`);
  }

  step("5. SQL JOIN via LOOKUP() function");
  const joined = await relata.query(
    "SELECT _pk, passport_country, LOOKUP('country_alpha3', passport_country) AS iso3 FROM Person LIMIT 5",
  );
  for (const row of joined.rows ?? []) out(`  ${JSON.stringify(row)}`);
}

await main().catch(exitOnRelataError);
