# @relata/sdk — TypeScript SDK

TypeScript client for the [Relata](../../README.md) data engine — ontology-driven,
enterprise-grade workloads. Zero runtime dependencies; uses native `fetch`.

Compatible with Node.js 18+, Deno, Bun, and browser environments.

## Install

```bash
npm install @relata/sdk
# or
yarn add @relata/sdk
# or
bun add @relata/sdk
```

## Quick start

```typescript
import { createClient } from "@relata/sdk";

const relata = createClient("http://localhost:9090", {
  bearerToken: process.env.RELATA_TOKEN,
  defaultPurpose: "analytics",   // required — every query must declare a purpose
  timeoutMs: 15_000,
});

// Raw SQL query
const result = await relata.query("SELECT * FROM Person LIMIT 10");
console.log(result.rows);

// Typed query
interface Person { id: string; name: string; dob?: string }
const persons = await relata.query<Person>(
  "SELECT id, name, dob FROM Person LIMIT 5",
);
persons.rows[0]?.name; // typed: string | undefined

// Fluent builder
const recent = await relata
  .select("Person")
  .where("name LIKE 'Ahmed%'")
  .asOf("2025-01-01T00:00:00Z")
  .withProvenance()
  .orderBy("name")
  .limit(20)
  .execute<Person>();
```

## Key concepts

### Purpose (mandatory)

Every Relata query **must** declare a `purpose` string registered in the tenant's
`PurposeRegistry` (SPECS §5.22.4). The server rejects any purposeless query with
HTTP 400 (`PurposeError`).

Set a default purpose on the client, or pass it per-query:

```typescript
// Client-level default
const relata = createClient(url, { defaultPurpose: "analytics" });

// Per-query override
await relata.query("SELECT ...", { purpose: "audit" });

// Via builder
relata.select("Person").purpose("audit").execute();
```

Common values: `"analytics"`, `"operations"`, `"security_incident"`, `"compliance_review"`, `"audit"`.

### Authentication

When the server is started with `RELATA_BEARER_TOKEN` set, all requests require
an `Authorization: Bearer <token>` header:

```typescript
const relata = createClient(url, {
  bearerToken: process.env.RELATA_TOKEN,
});
```

Requests without a token (or with an invalid token) receive HTTP 401 (`AuthError`).

### Extended SQL dialect

Relata extends ANSI SQL with enterprise-grade operators:

| Operator | Description |
|---|---|
| `AS OF 'timestamp'` | Bi-temporal snapshot query |
| `WITH PROVENANCE` | Attach PROV-O provenance to rows |
| `PATHS_BETWEEN(a, b, max_hops => 4)` | Shortest graph paths |
| `NETWORK_EXPAND(seed_id => ..., hops => 3)` | Network expansion |
| `MATCH_FACE(image_bytes => ..., threshold => 0.70)` | Face recognition |
| `LOOKUP_IDENTITY(column, value)` | IdentityIndex universal lookup |
| `HYBRID_SCORE(...)` | Combined BM25 + vector similarity |
| `PREGEL_BFS(seed_id => ..., max_rounds => 4)` | Iterative graph BFS |
| `GENERATE_REPORT(type => ..., period => ...)` | Signed compliance report |

## API reference

### `createClient(baseUrl, options?)`

Factory function. Returns a `RelataClient`.

```typescript
const relata = createClient("http://localhost:9090", {
  bearerToken: "...",
  defaultPurpose: "analytics",
  timeoutMs: 30_000,
  fetch: customFetch,   // override for testing
});
```

### `RelataClient`

#### `.query<T>(sql, options?): Promise<QueryResult<T>>`

Execute raw SQL. Returns `{ rows, queryId, elapsedMs, rowCount }`.

#### `.select(type): QueryBuilder`

Begin a fluent query builder.

#### `.health(): Promise<HealthResponse>`

`GET /health` — server liveness check.

#### `.status(): Promise<StatusResponse>`

`GET /status` — profile, role, quota.

#### `.auditCount(): Promise<AuditCountResponse>`

`GET /audit/count` — entry count + `chainValid` flag.

#### `.clusterNodes(): Promise<ClusterNode[]>`

`GET /cluster/nodes` — list cluster members.

### `QueryBuilder`

Fluent builder returned by `relata.select(type)`.

| Method | Description |
|---|---|
| `.columns(...cols)` | Columns to select (`*` by default) |
| `.purpose(p)` | Override purpose for this query |
| `.where(condition)` | Append `AND` condition |
| `.asOf(timestamp)` | Bi-temporal `AS OF` clause |
| `.withProvenance()` | Attach PROV-O metadata |
| `.orderBy(col, dir?)` | Add `ORDER BY` clause |
| `.limit(n)` | Set `LIMIT` |
| `.offset(n)` | Set `OFFSET` |
| `.pathsBetween(a, b, opts?)` | Switch to `PATHS_BETWEEN` sub-builder |
| `.toSQL()` | Return SQL string without executing |
| `.execute<T>()` | Execute and return `QueryResult<T>` |

### Error handling

All errors extend `RelataError`. Import and catch by type:

```typescript
import {
  PurposeError,
  AuthError,
  QuotaError,
  ForbiddenError,
  BadRequestError,
  ServerError,
  NetworkError,
  TimeoutError,
} from "@relata/sdk";

try {
  const r = await relata.query("SELECT * FROM Person LIMIT 10");
} catch (err) {
  if (err instanceof PurposeError) {
    // No purpose declared or purpose not in PurposeRegistry
    console.error("Fix:", err.message);
  } else if (err instanceof QuotaError) {
    // Per-principal cost quota exhausted
    console.error(`Quota hit. Retry after: ${err.retryAfterSeconds}s`);
  } else if (err instanceof AuthError) {
    console.error("Set RELATA_TOKEN environment variable.");
  } else if (err instanceof TimeoutError) {
    console.error(`Timed out after ${err.timeoutMs}ms`);
  } else if (err instanceof NetworkError) {
    console.error("Cannot reach server:", err.cause);
  } else {
    throw err;
  }
}
```

| Error class | HTTP | Cause |
|---|---|---|
| `PurposeError` | 400 | Purpose missing or not in registry |
| `BadRequestError` | 400 | SQL syntax error or bad parameter |
| `AuthError` | 401 | Bearer token missing or invalid |
| `ForbiddenError` | 403 | Cedar ACL denies access |
| `QuotaError` | 429 | Per-principal cost quota exhausted |
| `ServerError` | 5xx | Server-side error |
| `NetworkError` | 0 | Network failure (DNS, connection refused) |
| `TimeoutError` | 0 | Request exceeded `timeoutMs` |

## CLI helper

```bash
npx relata health --url http://localhost:9090
npx relata status
npx relata audit
npx relata nodes
npx relata query "SELECT * FROM Person LIMIT 5" --purpose analytics
```

Options: `--url`, `--token`, `--purpose`, `--timeout`, `--json`.

Environment variables: `RELATA_TOKEN`, `RELATA_PURPOSE`, `RELATA_URL`.

## Examples

See [`examples/`](examples/) for complete runnable examples:

| File | What it shows |
|---|---|
| `basic-query.ts` | Health check, raw SQL, typed query, fluent builder |
| `analytics.ts` | Full analytics workflow (identity, cases, financials, graph) |
| `face-search.ts` | `MATCH_FACE` operator with co-occurrence detection |
| `graph-traversal.ts` | `PATHS_BETWEEN`, `NETWORK_EXPAND`, `MATCH`, Pregel BFS |
| `audit.ts` | Audit chain verification, anomaly detection, compliance report |

Run any example:
```bash
RELATA_TOKEN=secret node --experimental-strip-types examples/basic-query.ts
# or
deno run --allow-net examples/basic-query.ts
# or
bun run examples/basic-query.ts
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `RELATA_TOKEN` | — | Bearer token for authentication |
| `RELATA_PURPOSE` | — | Default purpose (CLI helper) |
| `RELATA_URL` | `http://localhost:9090` | Server URL (examples / CLI) |
| `PROBE_IMAGE` | — | Path to probe JPEG for face-search example |

## License

AGPL-3.0-only — see [LICENSE](../../LICENSE).
