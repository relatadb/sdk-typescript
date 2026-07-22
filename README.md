# @zysec-ai/relata-sdk — TypeScript SDK

TypeScript client for the [Relata](../../README.md) data engine — ontology-driven,
enterprise-grade workloads. Zero runtime dependencies (native `fetch` only), typed
responses, fluent query builder, a Mem0-style governed memory client, and 12+ typed
v1.1 clients that mirror the server's REST surface — all with full transport
hardening (RFC 7807 problem+json, `X-Request-ID`, retry, multi-tenant headers).

Compatible with Node.js 18+, Deno, Bun, and browser environments.

- **Source:** [`sdks/typescript/src/`](./src/)
- **Package:** `@zysec-ai/relata-sdk`
- **Runtime:** Node.js 18+, Deno, Bun, browsers (anywhere with native `fetch`)
- **Runtime deps:** **zero** — uses native `fetch`, native `crypto.randomUUID()`, native `AbortController`
- **Parity:** tracks the Python reference SDK (`../python/relata/`) method-for-method

TypeScript is **async-native**, so every SDK method returns a `Promise`. There are no
separate `Async*` classes — that is the idiomatic parity with the Python SDK's sync/async
split.

## Install

```bash
npm install @zysec-ai/relata-sdk
# or
yarn add @zysec-ai/relata-sdk
# or
bun add @zysec-ai/relata-sdk
```

## Quick start

```typescript
import { createClient } from "@zysec-ai/relata-sdk";

const relata = createClient("http://localhost:9090", {
  bearerToken: process.env.RELATA_TOKEN,   // required when server sets RELATA_BEARER_TOKEN
  defaultPurpose: "analytics",              // required — every query must declare a purpose
  tenant: "org-acme",                       // X-Relata-Tenant-Id (multi-tenant)
  timeoutMs: 15_000,
  maxRetries: 3,                            // retry on 502/503/504 + network errors
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

## Cypher

RelataDB auto-detects Cypher: any query starting with `MATCH` is translated to SQL
before execution. The SDK is language-agnostic — send the string as you would SQL:

```typescript
const result = await relata.query("MATCH (n:Person {id: 'p1'}) RETURN *");
// → SELECT * FROM Person WHERE id = 'p1'
```

Supported: `MATCH` / `OPTIONAL MATCH`, `WHERE`, `RETURN`, `UNION` / `UNION ALL`
(#378), and `CALL traverse.*` / `CALL gds.*` procedures (#377). `CREATE` / `MERGE`
writes route through the governed write door. See the
[SQL reference](https://www.relatadb.dev/docs/reference/sql).

## Agent memory in three lines

`Memory` is a Mem0-style surface over the governed `/memory/*` verbs — purpose + ACL
stay on by default.

```typescript
import { Memory } from "@zysec-ai/relata-sdk";

const m = new Memory("http://localhost:9090", {
  purpose: "agent-notes",
  bearerToken: process.env.RELATA_TOKEN,
});
const memId = await m.add("Alice prefers dark mode");          // store
const hits  = await m.search("ui preferences", { topK: 5 });   // recall (confidence × recency × relevance)
await m.forget(memId);                                          // governed retract, not a hard delete
await m.close();                                                // no-op on native fetch (API symmetry)
```

## `createClient(baseUrl, options?)`

Factory function. Returns a `RelataClient`.

```typescript
const relata = createClient("http://localhost:9090", {
  bearerToken: "...",
  defaultPurpose: "analytics",
  timeoutMs: 30_000,
  tenant: "org-acme",         // X-Relata-Tenant-Id
  actingAs: "user-bob",       // X-Acting-As (delegation)
  delegatedBy: "user-alice",  // X-Delegated-By
  maxRetries: 3,              // retry 502/503/504 + network errors
  retryBackoffMs: 500,        // exponential base (default 500ms)
  headers: {                  // arbitrary caller headers, win over SDK defaults
    "X-Verified-Principal": "proxy-client",
  },
  fetch: customFetch,         // override for testing / observability
});
```

### `RelataClient` — the main client

| Method | Returns | Description |
|---|---|---|
| `.query<T>(sql, options?)` | `Promise<QueryResult<T>>` | Execute raw SQL. Wire shape normalised (see below). |
| `.select(type)` | `QueryBuilder` | Begin a fluent query |
| `.health()` | `Promise<HealthResponse>` | `GET /health` — liveness |
| `.status()` | `Promise<StatusResponse>` | `GET /status` — profile, role, quota |
| `.stats()` | `Promise<Stats>` | `GET /debug/stats` — engine counts |
| `.version()` | `Promise<VersionInfo>` | `GET /version` — build info |
| `.ready()` | `Promise<ReadyReport>` | `GET /health/ready` — 9-condition readiness |
| `.auditCount()` | `Promise<AuditCountResponse>` | `GET /audit/count` — entry count + `chainValid` |
| `.clusterNodes()` | `Promise<ClusterNode[]>` | `GET /cluster/nodes` — list cluster members |
| `.ingestDocument(chunksJsonl, manifestJson)` | `Promise<IngestDocumentResponse>` | `POST /ingest/document` — datagrep-extractor envelope (returns `taskId` for polling) |
| `.ingestDocumentStatus(taskId)` | `Promise<IngestDocumentTaskStatus>` | `GET /ingest/document/:task_id` — poll an async ingest to completion (#1001) |

Every method is async (TS is async-native). The `X-Request-ID` header is auto-generated
per request via `crypto.randomUUID()` — pin your own by setting
`headers: { "X-Request-ID": "..." }`.

### Purpose (mandatory)

Every query **must** declare a `purpose` registered in the tenant's `PurposeRegistry`
(SPECS §5.22.4). The server rejects purposeless queries with HTTP 400 (`PurposeError`).

```typescript
// Client-level default
const relata = createClient(url, { defaultPurpose: "analytics" });

// Per-query override
await relata.query("SELECT ...", { purpose: "audit" });

// Via builder
relata.select("Person").purpose("audit").execute();
```

Common values: `"analytics"`, `"operations"`, `"security_incident"`,
`"compliance_review"`, `"audit"`.

### Multi-tenant + delegation headers

```typescript
const relata = createClient(url, {
  bearerToken: token,
  tenant: "org-acme",           // X-Relata-Tenant-Id
  actingAs: "user-bob",         // X-Acting-As
  delegatedBy: "user-alice",    // X-Delegated-By
});
```

Without a token the SDK runs as the built-in `api-user` principal — fine for local dev,
not for production multi-tenant.

### Retry behaviour

`maxRetries` (default `0` = off) retries on HTTP `{502, 503, 504}` and on raw network
errors (DNS, connection refused). Backoff is exponential: `retryBackoffMs * 2^attempt`.
Timeouts are never retried (operations may have side-effects).

```typescript
const relata = createClient(url, {
  defaultPurpose: "analytics",
  maxRetries: 3,
  retryBackoffMs: 500,
});
```

### Logging (silent by default)

The SDK **never** writes to `console` on its own — pass an explicit `logger`
to get visibility into retry attempts, future deprecation warnings, etc. Two
ready-to-use implementations ship in the box:

```typescript
import { createClient, ConsoleLogger, NoOpLogger, type Logger } from "@zysec-ai/relata-sdk";

// 1. Use the bundled console logger (CLIs / scripts).
const relata = createClient(url, {
  logger: new ConsoleLogger("my-app"),  // → "relata:my-app WARN retrying ..."
  maxRetries: 3,
});

// 2. Stay silent (default — equivalent to omitting `logger`).
const quiet = createClient(url, { logger: new NoOpLogger() });

// 3. Wire your own observability backend.
const custom: Logger = {
  debug: (msg, ctx) => myOtel.span(msg, ctx),
  info:  (msg, ctx) => myOtel.span(msg, ctx),
  warn:  (msg, ctx) => myOtel.warn(msg, ctx),
  error: (msg, ctx) => myOtel.error(msg, ctx),
};
```

`ConsoleLogger` writes `warn`/`error` to **stderr** and `info`/`debug` to
**stdout**, so JSON-piping callers never see diagnostics on the data stream.
Each line is shaped `<prefix> <LEVEL> <message>` followed by an optional
JSON-encoded context object — stable enough for `grep` but not a substitute
for a real structured logger in production.

### `QueryResult` wire-shape normalisation

The server replies with one of two shapes:

| Wire shape | Meaning |
|---|---|
| `{"data": [...rows...], "query_id": "...", "elapsed_ms": N}` | Rich (row data in `data`) |
| `{"rows": <int count>, "query_id": "...", "elapsed_ms": N}` | Legacy (row count in `rows`) |

The SDK normalises both so callers always see `result.rows` as an array, matching the
Python `_normalise_wire_shape` validator:

```typescript
const result = await relata.query("SELECT * FROM Person LIMIT 5");
result.rows;        // Record<string, unknown>[] — always an array
result.rowCount;    // number — always rows.length
result.columns;     // string[] — column names when the server sends them
result.queryId;     // string
result.elapsedMs;   // number
```

## `Memory` — agent memory

Mem0-style governed agent memory over `/memory/*` (ADR-144). Construct with a mandatory
`purpose`.

```typescript
import { Memory } from "@zysec-ai/relata-sdk";

const m = new Memory("http://localhost:9090", {
  purpose: "agent-notes",
  bearerToken: process.env.RELATA_TOKEN,
  sessionId: "sess-1",         // optional default session
});

const id1 = await m.add("Alice prefers dark mode");
const id2 = await m.add("Bob likes light mode", { memoryClass: "episodic", confidence: 0.8 });
const ids = await m.addBatch(["first", "second", { content: "third", confidence: 0.5 }]);

const hits = await m.search("ui preferences", { topK: 5, asOf: "2025-01-01" });
const mem  = await m.get(id1);          // Record<string, unknown> | null
const newId = await m.update(id1, "Alice prefers dark mode (revised)");
const decision = await m.forget(id1);   // governed retention-policy retract

// The five cognitive verbs (#77):
await m.associate(id1, id2, "contradicts", { confidence: 0.9 });
const eps = await m.episodes({ sessionId: "sess-1" });
const chain = await m.justify(id1);
const resolved = await m.resolve(id1, { policy: "highest_confidence" });
const summary = await m.summarise([id1, id2], { summaryContent: "both prefer different modes" });
```

| Method | HTTP | Description |
|---|---|---|
| `.add(content, opts?)` | `POST /memory/remember` | Store a memory; returns its id |
| `.addBatch(items, opts?)` | `POST /memory/remember/batch` | Bulk store; returns index-aligned ids |
| `.search(query, opts?)` | `GET /memory/recall` | Recall ranked by confidence × recency × relevance |
| `.get(memoryId)` | `GET /memory/recognize/:id` | Fetch one memory or `null` |
| `.update(memoryId, content)` | `POST /memory/consolidate` | Governed supersede; returns new id |
| `.forget(memoryId)` | `DELETE /memory/forget/:id` | Governed retention-policy retract |
| `.associate(src, tgt, relation, opts?)` | `POST /memory/associate` | Link two memories |
| `.episodes(opts?)` | `GET /memory/episodes` | List episodes |
| `.justify(memoryId)` | `GET /memory/justify/:id` | PROV-O assertion chain |
| `.resolve(memoryId, opts?)` | `POST /memory/resolve/:id` | Resolve a contradiction |
| `.summarise(sourceIds, opts?)` | `POST /memory/summarise` | Summary belief from sources |

The MCP envelope (`{"content": [{"type":"text","text":"<json>"}]}`) is unwrapped
transparently.

## `QueryBuilder` — fluent SQL

Fluent builder returned by `relata.select(type)`.

```typescript
const result = await relata
  .select("Person")
  .purpose("analytics")
  .where("name LIKE 'Ahmed%'")
  .asOf("2025-01-01T00:00:00Z")
  .withProvenance()
  .orderBy("name")
  .limit(20)
  .execute<{ id: string; name: string }>();
```

| Method | Description |
|---|---|
| `.columns(...cols)` | Columns to select (`*` by default) |
| `.purpose(p)` | Override purpose for this query |
| `.where(condition)` | Append `AND` condition |
| `.asOf(timestamp)` | Bi-temporal `AS OF` clause |
| `.withProvenance()` | Attach PROV-O metadata |
| `.orderBy(col, dir?)` | Add `ORDER BY` clause (`ASC` or `DESC`) |
| `.limit(n)` | Set `LIMIT` (positive integer) |
| `.offset(n)` | Set `OFFSET` (non-negative integer) |
| `.pathsBetween(a, b, opts?)` | Switch to `PATHS_BETWEEN` sub-builder |
| `.toSQL()` | Return SQL string without executing |
| `.execute<T>()` | Execute and return `QueryResult<T>` |

### `PathsQueryBuilder`

Returned by `.pathsBetween(a, b, opts?)`. Same
`.purpose / .limit / .withProvenance / .asOf / .execute<T>()` surface.

## Typed v1.1 clients — `fromClient(client)`

Each typed client inherits the parent client's auth, tenant, and header context, so
governance stays consistent across the surface. TypeScript is async-native, so every
method returns a `Promise` (no `Async*` classes).

```typescript
import { createClient, GovernanceClient, McpClient, AuditClient } from "@zysec-ai/relata-sdk";

const relata = createClient(url, { bearerToken: token, defaultPurpose: "compliance", tenant: "acme" });
const gov    = GovernanceClient.fromClient(relata);
const mcp    = McpClient.fromClient(relata);
const audit  = AuditClient.fromClient(relata);

const rule   = await gov.createRule({ name: "big-xfer", object_type: "Transaction", condition: "amount_usd > 1000000", action: "alert" });
const tools  = await mcp.listTools();
const entries = await audit.entries({ purpose: "compliance", limit: 50 });
```

| Module | Class | Surface |
|---|---|---|
| `governance.ts` | `GovernanceClient` | Rules, retention (holds + WORM), breakglass, alerts, DSAR |
| `mcp.ts` | `McpClient` | 22+ typed MCP tool wrappers + generic `callTool` |
| `a2a.ts` | `A2AClient` | A2A tasks + LangGraph checkpoints + agent card |
| `audit.ts` | `AuditClient` | Audit entries (filtered/paginated) + signed receipts + PDF export |
| `identity.ts` | `IdentityClient` | Identity label/uncertainty + lookup tables + `ERASE SUBJECT` |
| `objects.ts` | `ObjectClient` | Typed upsert + batch via `/ingest?object_type=` |
| `ingest.ts` | `IngestClient` | Bulk NDJSON + CSV + media status |
| `vectors.ts` | `VectorClient` | KNN + hybrid search + similar-to (SQL-backed) |
| `s3.ts` | `S3Client` | Native-fetch wrapper for the S3 protocol door (no boto3) |
| `system.ts` | `SystemClient` | LLM config + test + jobs status |
| `streaming.ts` | `StreamingClient` | NDJSON row streams + SSE consumers (watch/alerts) + Arrow IPC |
| `tenants.ts` | `TenantAdminClient` | Tenant CRUD + quota + sharing agreements + platform admin |
| `backup.ts` | `BackupClient` | Backup / restore / PITR (admin) |
| `tokens.ts` | `TokenClient` | Dedup / uniqueness tokens (test-and-set) |
| `log.ts` | `LogClient` | Ordered integrity log (append / head / load leaves) |

### Streaming — async iterables

`StreamingClient` exposes every streaming surface as an `AsyncIterable<T>`:

```typescript
import { StreamingClient } from "@zysec-ai/relata-sdk";

const streaming = StreamingClient.fromClient(relata);

// NDJSON row stream
for await (const row of streaming.queryRows("SELECT * FROM Person", { purpose: "analytics" })) {
  console.log(row);
}

// SSE watch
for await (const ev of streaming.watch("SELECT * FROM Person", "analytics")) {
  console.log(ev); // { event: "RowsAppended", ... }
}

// SSE alerts
for await (const alert of streaming.alerts()) {
  console.log(alert);
}

// Raw Arrow IPC byte stream
for await (const chunk of streaming.queryArrowRaw("SELECT * FROM Person", { purpose: "analytics" })) {
  // chunk: Uint8Array — feed to a columnar reader
}
```

SSE consumers reconnect with exponential backoff until you break out of the
`for await` loop.

### S3 door — native fetch only

The Python SDK ships `boto3` / `aiobotocore` / `httpx` flavours; this TypeScript port
ships **only** the native-fetch equivalent (`S3Client.http(method, path, opts)`) because
boto3 is Python-only and the TS SDK has zero runtime dependencies. Convenience wrappers
(`listBuckets`, `createBucket`, `putObject`, `getObject`, `deleteObject`) are included.

```typescript
import { S3Client } from "@zysec-ai/relata-sdk";
const s3 = S3Client.fromClient(relata);
await s3.createBucket("acme-intel");
await s3.putObject("acme-intel", "report.pdf", pdfBytes, { contentType: "application/pdf" });
const obj = await s3.getObject("acme-intel", "report.pdf");
console.log(obj.body); // Uint8Array
```

## Response models

| Model | Fields |
|---|---|
| `QueryResult<T>` | `rows`, `queryId`, `elapsedMs`, `rowCount`, `columns` |
| `HealthResponse` | `status`, `profile`, `nodeId` |
| `StatusResponse` | `profile`, `role`, `queryQuota` |
| `AuditCountResponse` | `entries`, `chainValid` |
| `ClusterNode` | `nodeId`, `role`, `url` |
| `IngestDocumentResponse` | `reportId`, `taskId`, `chunksIngested`, `warnings`, `schemaVersion`, `queueDepth` |
| `VersionInfo` | `version`, `commit`, `profile`, `schemaVersion`, `features` |
| `Stats` | `records`, `states`, `snapshotRows`, `logLeaves`, `tokens`, `raw` |
| `ReadyReport` | `isReady`, `status`, `reason`, `detail` |

## Error handling

All errors extend `RelataError`. Import and catch by type:

```typescript
import {
  PurposeError, AuthError, QuotaError, RateLimitedError, ForbiddenError,
  NotFoundError, ConflictError, ValidationError,
  BadRequestError, ServerError, NetworkError, TimeoutError,
} from "@zysec-ai/relata-sdk";

try {
  const r = await relata.query("SELECT * FROM Person LIMIT 10");
} catch (err) {
  if (err instanceof PurposeError) {
    console.error("Fix:", err.message);
  } else if (err instanceof RateLimitedError) {
    console.error(`Rate limited. Retry after: ${err.retryAfterSeconds}s`);
  } else if (err instanceof NotFoundError) {
    console.error(`Not found. Code: ${err.code}, requestId: ${err.requestId}`);
  } else if (err instanceof TimeoutError) {
    console.error(`Timed out after ${err.timeoutMs}ms`);
  } else if (err instanceof NetworkError) {
    console.error("Cannot reach server:", err.cause);
  } else {
    throw err;
  }
}
```

Every error carries the RFC 7807 problem+json fields (`code`, `typeUrl`, `retryable`,
`requestId`) when the server emits them. `RateLimitedError` extends `QuotaError` so
existing `catch (e instanceof QuotaError)` callers keep working.

| Error class | HTTP | Cause |
|---|---|---|
| `PurposeError` | 400 | Purpose missing or not in registry |
| `BadRequestError` | 400 | SQL syntax error or bad parameter |
| `AuthError` | 401 | Bearer token missing or invalid |
| `ForbiddenError` | 403 | Cedar ACL denies access |
| `NotFoundError` | 404 | Resource does not exist |
| `ConflictError` | 409 | Version or uniqueness conflict |
| `ValidationError` | 422 | Request body failed validation |
| `RateLimitedError` | 429 | Per-principal cost quota or rate limit (extends `QuotaError`) |
| `QuotaError` | 429 | Back-compat alias for `RateLimitedError` |
| `ServerError` | 5xx | Server-side error |
| `NetworkError` | 0 | Network failure (DNS, connection refused) |
| `TimeoutError` | 0 | Request exceeded `timeoutMs` |

## Async

TypeScript is async-native — every method returns a `Promise`. There are no separate
`Async*` classes. Use `async`/`await` directly:

```typescript
const relata = createClient("http://localhost:9090", { defaultPurpose: "analytics" });
const result = await relata.query("SELECT * FROM Person LIMIT 5");
for (const row of result.rows) console.log(row);
```

## CLI helper

```bash
npx relata health --url http://localhost:9090
npx relata status
npx relata audit
npx relata nodes
npx relata query "SELECT * FROM Person LIMIT 5" --purpose analytics
```

Options: `--url`, `--token`, `--purpose`, `--timeout`, `--json`.

Exit codes: `0` success · `1` usage / SDK error · `2` audit-chain integrity failure.

## Extended SQL dialect

Relata extends ANSI SQL with enterprise operators — usable from raw `relata.query(sql)`
or via the builder:

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
| `SIMILAR TO <Type> WHERE id = '...'` | Multi-vector similarity |
| `ERASE SUBJECT '<id>' REASON '<r>' [CERTIFY]` | GDPR Art. 17 crypto-shred |

See the [SQL reference](https://www.relatadb.dev/docs/reference/sql) for full syntax.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `RELATA_TOKEN` | — | Bearer token for authentication |
| `RELATA_PURPOSE` | — | Default purpose (CLI helper) |
| `RELATA_URL` | `http://localhost:9090` | Server URL (examples / CLI) |
| `PROBE_IMAGE` | — | Path to probe JPEG for face-search example |

## Examples

See [`examples/`](./examples/) for runnable workflows:

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

## Deployment profiles

> `lite` is kept as a silent legacy alias for `free` (ADR-204).

| Profile | Use case | Start command |
|---|---|---|
| `free` | Embedded / single-process / dev | `RELATA_PROFILE=free relata serve` |
| `server` | Single-node production | `RELATA_PROFILE=server relata serve` |
| `cluster` | Multi-node distributed (alpha) | `RELATA_PROFILE=cluster relata serve` |

The SDK works identically across all three.

## Testing with an ephemeral server

`src/_ephemeral.ts` exports `spawnEphemeral()` — starts a `relata serve` process
on a random port, waits for readiness, and returns `{ port, token, baseUrl, stop }`.

```ts
import { spawnEphemeral } from './_ephemeral';

describe('integration', () => {
  let server: Awaited<ReturnType<typeof spawnEphemeral>>;
  beforeAll(async () => { server = await spawnEphemeral(); });
  afterAll(() => server.stop());

  it('health', async () => {
    const r = await fetch(`${server.baseUrl}/health`);
    expect(r.ok).toBe(true);
  });
});
```

Set `RELATA_BIN` to the binary path and `RELATA_TEST_TOKEN` to override the
bearer token (defaults: `relata` / `relata-test`).

## License

AGPL-3.0-only — see the root `LICENSE` file.
