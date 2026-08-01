/**
 * graphql.ts — governed `/graphql` door (ADR-020's 2026-08-01 update, #1173).
 *
 * Note: ADR-220 originally named a dedicated GraphQL protocol-door decision;
 * that file was deleted and the number later recycled for an unrelated
 * decision. This shipped `/graphql` door is documented instead by the
 * ADR-020 update (2026-08-01) and issue #1173. See #2101.
 *
 * Demonstrates the four supported query shapes plus error handling:
 *  1. Schema introspection (`{ __schema { types { name } } }`)
 *  2. Simple field selection (`{ Person { _pk name email } }`)
 *  3. Filtered + limited selection with `where` + `limit` args
 *  4. Variables bound server-side
 *  5. Error envelope from an unsupported operation (mutation)
 *
 * The server translates a GraphQL subset to SQL and runs it through the same
 * governed query path (auth, purpose, ACL, audit) as a normal `POST /query`.
 * Mutations, subscriptions, fragments, and unions are not supported — the
 * server returns a non-empty `errors` array and the SDK throws `RelataError`.
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/graphql.ts
 *   deno run --allow-net examples/graphql.ts
 *   bun run examples/graphql.ts
 */

import { createClient } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();
const relata = createClient(url, { bearerToken: token, defaultPurpose: "analytics" });

interface SchemaType { name: string }
interface PersonRow { _pk?: string; name?: string; email?: string }

async function main(): Promise<void> {
  banner("1. GraphQL introspection");
  const schema = await relata.graphql("{ __schema { types { name } } }") as
    | { __schema?: { types?: SchemaType[] } }
    | undefined;
  const types = schema?.__schema?.types ?? [];
  out(`${types.length} registered type(s):`);
  for (const t of types.slice(0, 10)) out(`  - ${t.name}`);

  step("2. Field selection: Person");
  const persons = await relata.graphql("{ Person { _pk name email } }") as PersonRow[] | undefined;
  const rows = persons ?? [];
  out(`${rows.length} row(s):`);
  for (const row of rows.slice(0, 5)) {
    out(`  _pk=${(row._pk ?? "?").padEnd(12)} name=${(row.name ?? "?").padEnd(20)} email=${row.email ?? "?"}`);
  }

  step("3. Filtered selection: limit + where");
  const filtered = await relata.graphql('{ Person(limit: 3, where: { _pk: "p1" }) { _pk name } }');
  out(`Response: ${JSON.stringify(filtered).slice(0, 200)}`);

  step("4. Variables: $limit");
  const withVars = await relata.graphql(
    "query Limited($limit: Int!) { Person(limit: $limit) { _pk name } }",
    { limit: 2 },
    "Limited",
  );
  out(`Response: ${JSON.stringify(withVars).slice(0, 200)}`);

  step("5. Mutation → expected error envelope");
  try {
    await relata.graphql('mutation { createPerson(name: "Bob") { id } }');
    out("  (unexpected success — server may have added mutation support)");
  } catch (err) {
    out(`  Got expected error: ${(err as Error).message}`);
  }
}

await main().catch(exitOnRelataError);
