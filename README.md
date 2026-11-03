# @zysec-ai/relata-sdk — TypeScript SDK

TypeScript client for the [Relata DB](https://relatadb.dev) data engine — ontology-driven,
governed workloads. Zero runtime dependencies (native `fetch` only), typed
responses, fluent query builder, a Mem0-style governed memory client, and 12+ typed
v1.1 clients that mirror the server's REST surface — all with full transport
hardening (RFC 7807 problem+json, `X-Request-ID`, retry, multi-tenant headers).

Compatible with Node.js 18+, Deno, Bun, and browser environments.

- **Repo:** [github.com/relatadb/sdk-typescript](https://github.com/relatadb/sdk-typescript)
- **Package:** `@zysec-ai/relata-sdk`
- **Docs:** [relatadb.dev](https://relatadb.dev) · [Issues](https://github.com/relatadb/sdk-typescript/issues)
- **Runtime:** Node.js 18+, Deno, Bun, browsers (anywhere with native `fetch`)
- **Runtime deps:** **zero** — uses native `fetch`, native `crypto.randomUUID()`, native `AbortController`
- **By:** [ZySec AI](https://zysec.ai) — Frontier Sovereign Intelligence · hello@zysec.ai

For the v3.0 platform boundary and SDK migration plan, see the
[SDK migration guide](../README-v3-migration.md).
TypeScript is one of the three supported consumer SDKs (Python, TypeScript,
Go). Other languages use the HTTP API and its OpenAPI reference at
`GET /openapi.json`.

The v3 SDK accepts prepared detection rules through `GovernanceClient.createRule`
or MCP `createRule`. Raw Sigma YAML parsing/import is no longer an SDK or MCP
server method. Convert YAML in OpenETL (the former `relata-connectors import-sigma`
was removed), or convert externally and submit the prepared
`name`, `condition_sql`, and `target_type` JSON fields through `/v1/rules`
(`POST /v1/rules/sigma` answers `410 sigma-import-removed`; see the [Sigma target contract](../../docs/src/openetl-handoff/sigma-target-contract.md)).

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

## Hybrid search — `VectorClient.hybridSearch()`

`VectorClient` wraps the server's `HYBRID_SEARCH` operator (ADR-175): supply
`queryText` (BM25 leg), `queryEmbedding` + `embeddingSlot` (vector leg), or
both — when both are present the server fuses the two rankings via
reciprocal rank fusion. This is Relata's genuine edge over a plain vector DB
or a plain full-text engine.

```typescript
import { createClient, VectorClient } from "@zysec-ai/relata-sdk";

const relata = createClient("http://localhost:9090", { defaultPurpose: "rag" });
const vectors = VectorClient.fromClient(relata);

const { embedding } = await vectors.embed("graph retrieval");

const hits = await vectors.hybridSearch("Document", {
  queryText: "graph retrieval",
  queryEmbedding: embedding,
  embeddingSlot: "_emb_text",
  k: 10,
});
for (const row of hits) console.log(row["title"], row["_score"]);
```

See `examples/hybrid-search.ts` for a full runnable walkthrough (embed →
ingest → BM25-only vs. vector-only vs. fused search).

## Agent memory in three lines

`Memory` is a Mem0-style surface over the governed `/v1/memory/*` verbs — purpose + ACL
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
| `.status()` | `Promise<StatusResponse>` | `GET /v1/system/status` — profile, role, quota |
| `.stats()` | `Promise<Stats>` | `GET /v1/system/stats` — engine counts |
| `.version()` | `Promise<VersionInfo>` | `GET /version` — build info |
| `.ready()` | `Promise<ReadyReport>` | `GET /health/ready` — 9-condition readiness |
| `.auditCount()` | `Promise<AuditCountResponse>` | `GET /v1/audit/count` — entry count + `chainValid` |
| `.ingestDocument(objects, purpose?)` | `Promise<IngestDocumentResponse>` | Queues prepared mixed-type rows through `POST /v1/ingest/bulk` (`queued: true`) and returns one process-local task receipt |
| `.ingestDocumentStatus(taskId)` | `Promise<IngestDocumentTaskStatus>` | `GET /v1/ingest/tasks/:task_id` — observe pending/complete/partial/failed/uncertain/incomplete state plus confirmed written/dropped row counts |

`ingestDocument` accepts application-prepared governed rows (for example a
`DocumentSource`, linked `DocumentChunk` rows, and optional evidence rows with
`_type` and stable `_pk` fields). It does not parse raw documents or datagrep
extractor files. Parse and chunk extractor output in OpenETL (the former
`relata-connectors prepare-document` adapter was removed) to produce an `objects`
array, then pass that array to this method. Queue admission returns a process-local receipt;
it is not crash-durable, so poll `ingestDocumentStatus` and use its
`status` and row counts to distinguish complete, partial, failed, uncertain, and incomplete outcomes. `code: "derived-write-incomplete"` and `derivedError` can appear while `status` is still `pending`; once all primary batches are accounted for, the status becomes `incomplete`. If the primary outcome is uncertain, `uncertain` takes precedence as the status. A recorded derived-write failure has `retryable: false` and no completion watermark. An uncertain outcome is unresolved and must not be blindly retried (`outcomeUncertain: true`, `retryable: false`). A receipt is queue admission, not durable/indexed completion. The distinct
MCP `ingest_document(source, text, ...)` tool remains a source/text application
workflow and is not this queued prepared-row contract.

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

### Transport security — redirects are never followed

Every `fetch()` call the SDK makes (the main client, the typed v1.1 clients,
`Memory` and the streaming/SSE helpers) passes an
explicit `redirect: "manual"` policy, and a 3xx response is treated as a
hard `NetworkError` instead of being silently followed. This is a
code-level guarantee that the `Authorization: Bearer <token>` header is
never resent to a redirect target — independent of whatever the bound or
caller-injected `fetch` implementation (`RelataClientOptions.fetch`) would
otherwise default to. This enforces the redirect policy required to prevent
credentials from being forwarded to another origin (#1416, #2364).

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

Mem0-style governed agent memory over `/v1/memory/*` (ADR-144). Construct with a mandatory
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

// ADR-145 retrieval-quality operators (#2674): bound recall by token budget
// and confidence so one call can't blow an agent's context window.
const detailed = await m.searchDetailed("ui preferences", {
  minConfidence: 0.5,
  budgetTokens: 200,
});
console.log(detailed["recall_cost_tokens"], detailed["cancelled"]);

const mem  = await m.get(id1);          // Record<string, unknown> | null
const newId = await m.update(id1, "Alice prefers dark mode (revised)");
const decision = await m.forget(id1);   // governed retention-policy retract

// The five cognitive verbs (#77):
await m.associate(id1, id2, "contradicts", { confidence: 0.9 });
const eps = await m.episodes({ sessionId: "sess-1" });
const chain = await m.justify(id1);
const resolved = await m.resolve(id1);
const summary = await m.summarise([id1, id2], { summaryContent: "both prefer different modes" });
```

| Method | HTTP | Description |
|---|---|---|
| `.add(content, opts?)` | `POST /v1/memory/remember` | Store a memory; returns its id |
| `.addBatch(items, opts?)` | `POST /v1/memory/remember/batch` | Bulk store; returns index-aligned ids |
| `.search(query, opts?)` | `POST /v1/memory/recall` | Recall ranked by confidence × recency × relevance |
| `.searchDetailed(query, opts?)` | `POST /v1/memory/recall` | Like `.search` but returns the full envelope, incl. read-only `recall_cost_tokens`/`cancelled`. `opts` also takes the ADR-145 knobs: `minConfidence`, `recencyHalfLifeSecs`, `budgetTokens`, `stabilityDays`, `cancelThreshold` |
| `.rememberProcedure(agentId, name, instructionText)` | `POST /v1/memory/remember-procedure` | Store a versioned agent procedure |
| `.recallProcedure(agentId, opts?)` | `GET /v1/memory/recall-procedure` | Read back stored procedures (latest version per name unless `allVersions`) |
| `.get(memoryId)` | `GET /v1/memory/recognize/:id` | Fetch one memory or `null` |
| `.update(memoryId, content)` | `POST /v1/memory/consolidate` | Governed supersede; returns new id |
| `.forget(memoryId)` | `DELETE /v1/memory/forget/:id` | Governed retention-policy retract |
| `.associate(src, tgt, relation, opts?)` | `POST /v1/memory/associate` | Link two memories |
| `.episodes(opts?)` | `GET /v1/memory/episodes` | List episodes |
| `.justify(memoryId)` | `GET /v1/memory/justify/:id` | PROV-O assertion chain |
| `.resolve(memoryId)` | `GET /v1/memory/resolve/:id` | Resolve a supersession chain to its canonical head |
| `.summarise(sourceIds, opts?)` | `POST /v1/memory/summarise` | Summary belief from sources |

The MCP envelope (`{"content": [{"type":"text","text":"<json>"}]}`) is unwrapped
transparently.

## Agent-framework adapters (#2312)

Governed memory/checkpointing adapters for LangChain.js, LlamaIndex.TS, and langgraphjs,
mirroring `sdks/python/relata_adapters` / `relata_langgraph`. Each is a **separate entry
point** — not re-exported from the package root — so importing the core SDK never pulls
in an agent-framework dependency:

```typescript
// LangChain.js BaseMemory shape — duck-typed, no `langchain` import required.
import { RelataMemory } from "@zysec-ai/relata-sdk/adapters/langchain";
const memory = new RelataMemory({ baseUrl: "http://localhost:9090", purpose: "agent" });

// LlamaIndex.TS BaseMemoryBlock shape — duck-typed, no `llamaindex` import required.
import { RelataMemory as RelataLlamaIndexMemory } from "@zysec-ai/relata-sdk/adapters/llamaindex";

// langgraphjs BaseCheckpointSaver — a *real* subclass (LangGraph does `instanceof`
// checks), so this one genuinely needs `@langchain/langgraph-checkpoint` + `@langchain/core`
// installed (both are optional peer dependencies of this package):
import { RelataCheckpointer } from "@zysec-ai/relata-sdk/adapters/langgraph";
const checkpointer = new RelataCheckpointer({
  endpoint: process.env.RELATA_ENDPOINT!,
  token: process.env.RELATA_BEARER_TOKEN,
});
const app = workflow.compile({ checkpointer });
```

See each module's docstring for the full API (`src/adapters/langchain.ts`,
`src/adapters/llamaindex.ts`, `src/adapters/langgraph.ts`) and `sdks/COVERAGE.md` §19 for
the cross-SDK coverage matrix.

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

Each typed client inherits the parent client's auth, tenant, header, timeout, and retry
context (`timeoutMs`/`maxRetries`/`retryBackoffMs`, #2731), so governance and resilience
stay consistent across the surface — a call through `GovernanceClient`/`McpClient`/... fails
within the same bounded timeout, retries idempotent verbs on `{502,503,504}`/network errors
the same way, and throws the same typed error hierarchy (`AuthError`, `ForbiddenError`,
`NotFoundError`, `ConflictError`, `ValidationError`, `RateLimitedError`, `ServerError`) as the
untyped `RelataClient`. TypeScript is async-native, so every method returns a `Promise` (no
`Async*` classes).

```typescript
import { createClient, GovernanceClient, McpClient, AuditClient } from "@zysec-ai/relata-sdk";

const relata = createClient(url, { bearerToken: token, defaultPurpose: "compliance", tenant: "acme" });
const gov    = GovernanceClient.fromClient(relata);
const mcp    = McpClient.fromClient(relata);
const audit  = AuditClient.fromClient(relata);

const rule   = await gov.createRule({ name: "big-xfer", condition_sql: "amount_usd > 1000000", target_type: "Transaction", severity: "high" });
const tools  = await mcp.listTools();
const entries = await audit.log({ limit: 50 });
```

| Module | Class | Surface |
|---|---|---|
| `governance.ts` | `GovernanceClient` | Rules, retention (holds + WORM), breakglass, alerts, DSAR |
| `mcp.ts` | `McpClient` | 22+ typed MCP tool wrappers + generic `callTool` |
| `a2a.ts` | `A2AClient` | A2A tasks + LangGraph checkpoints + agent card |
| `audit.ts` | `AuditClient` | Audit count + filtered audit log |
| `identity.ts` | `IdentityClient` | Identity label/uncertainty + lookup tables + `ERASE SUBJECT` |
| `objects.ts` | `ObjectClient` | Typed upsert + batch via `/v1/ingest?object_type=` |
| `ingest.ts` | `IngestClient` | Bulk NDJSON + CSV + media task status; it does not upload raw media bytes |
| `files.ts` | `FilesClient` | Governed Files `put`/`get`/`head`/`list`/`delete`, resumable uploads, and media row content |
| `vectors.ts` | `VectorClient` | KNN + hybrid search + similar-to (SQL-backed) |
| `system.ts` | `SystemClient` | Generic jobs and operator surfaces; no feed broker routing |
| `feed-broker.ts` | `FeedBrokerClient` | Optional RIFN broker health, channels, signed-entry publishing at an explicit broker URL |
| `streaming.ts` | `StreamingClient` | NDJSON row streams + SSE consumers (watch/alerts) + Arrow IPC |
| `tenants.ts` | `TenantAdminClient` | The caller's own tenant (`me`) |
| `backup.ts` | `BackupClient` | Backup / restore / PITR (admin) |
| `tokens.ts` | `TokenClient` | Tenant self-service tokens (list / audit / rotate / revoke) |

The former `get_domain_summary` MCP route is not a core tool in v3.0. To build
the same application-facing inventory, call generic, tenant-scoped
`mcp.listEntityTypes()` and pass the result to `summarizeDomain("financial", inventory)`.
That helper supplies local profile metadata; it performs no extra query or
authorization check.

```ts
import { createClient, McpClient, summarizeDomain } from "@zysec-ai/relata-sdk";

const db = createClient("http://localhost:9090", { defaultPurpose: "analytics" });
const mcp = McpClient.fromClient(db);
const inventory = await mcp.listEntityTypes();
console.log(summarizeDomain("financial", inventory));
```

RIFN is an optional broker service with its own URL, separate from the Relata
database listener. Construct `FeedBrokerClient` with that explicit broker URL
and its own options. Its `publish(publisherDid, entry)` sends a complete,
caller-signed feed entry plus the required `X-Publisher-Did`; the SDK does not
create or sign entries, and `SystemClient.fromClient()` does not configure a
broker client.

**Admin-listener reachability (`adminBaseUrl`, #2321):** on a hardened
deployment, `/admin/*` is mounted only
on the loopbound admin control-plane listener (`RELATA_ADMIN_BIND`, default
`127.0.0.1:9091` — ADR-0261), never the main data-plane `baseUrl`. Pass
`adminBaseUrl` to `RelataClient` (inherited automatically by
`BackupClient.fromClient(...)`) or directly to a typed
client's constructor options to reach those routes. Leave it unset (the
default) on the free profile, where the admin listener isn't split from the
data plane. A bare 404 from an admin-only route with no error
detail is rewritten into a hint pointing at this option instead of a
confusing plain 404.

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

### HTTP Arrow IPC

The supported columnar query path is `POST /v1/query/arrow`. `StreamingClient`
exposes its response as raw byte chunks so an application can pass them to
its own Arrow IPC reader. This SDK does not include a typed `apache-arrow`
table helper.

```typescript
import { StreamingClient } from "@zysec-ai/relata-sdk";

const streaming = StreamingClient.fromClient(relata);
let totalBytes = 0;
for await (const chunk of streaming.queryArrowRaw(
  "SELECT * FROM Person LIMIT 1000",
  { purpose: "analytics" },
)) {
  totalBytes += chunk.byteLength;
}
console.log(`Received ${totalBytes} Arrow IPC bytes`);
```

`POST /v1/ingest/media` was removed (#5942), together with
`IngestClient.mediaStatus()` and `McpClient.ingestMedia()`; poll OpenETL work
items with `MediaWorkClient.get()`.

### Governed Files client — v3.0 candidate, SDK 3.0.0

For the v3.0 candidate (engine source `57e11676c`), version-aligned SDK source
`8924d6ce8` (TypeScript test-only fixture correction `5212045`) builds cleanly
and the TypeScript suite passes 515/515. The five-lane Files fixture passes in
10.020s; the prepared-document matrix passes in 37.110s across raw HTTP and
official TypeScript, Python sync/async, and Go queries. It checks synthetic
DataGrep and Unstructured JSON citation anchors, bounded ingest receipts,
auth/tenant behavior and a persistent single-node restart. Citation comparison
waits for stable index visibility: TypeScript and Python required two
before/after stabilization attempts for DataGrep, so this does not promise
immediate parity. See the [Files result](../../scripts/qualification/followup_pr5786_sdk_files_common_live.json)
and [prepared result](../../scripts/qualification/followup_pr5786_sdk_files_prepared_live.json).
This candidate-source evidence does not claim package publication, PDF/OCR or
provider extraction, replicas, throughput, interrupted-task resumption, or
server-side cancellation. Prepared receipts describe historical local task
outcomes; volatile profiles remain process-local.

`FilesClient.fromClient(client)` borrows the parent's authentication, tenant,
timeout and response cap. `put(key, bytes, { bucket, contentType })` returns
current-file metadata; `get(key, { bucket })` returns buffered `Uint8Array`
bytes plus ETag, content type and size; `delete(key, { bucket })` acknowledges
an exact-key deletion. An omitted bucket uses the authenticated tenant's
default. The server upload ceiling is 128 MiB; GET is subject to the inherited
response cap (64 MiB by default). PUT and DELETE are not automatically retried,
so reconcile uncertain outcomes before retrying. The client does not expose
immutable versions, conditional writes, range requests, physical/global-copy
deletion guarantees, or media processing.
The inherited request timeout bounds the client request, and abort/stream
cleanup applies to the client request; neither promises that server work
already accepted by the engine is aborted or rolled back. See
the [HTTP Files contract](../../docs/src/specs/files-api.md) for server
behavior.

## Response models

| Model | Fields |
|---|---|
| `QueryResult<T>` | `rows`, `queryId`, `elapsedMs`, `rowCount`, `columns` |
| `HealthResponse` | `status`, `profile`, `nodeId` |
| `StatusResponse` | `profile`, `role`, `queryQuota` |
| `AuditCountResponse` | `entries`, `chainValid` |
| `IngestDocumentResponse` | `taskId`, `rowsQueued`, `rowsRejected`, `errors`, `queueDepth` |
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
| `LOOKUP_IDENTITY(column, value)` | IdentityIndex universal lookup |
| `HYBRID_SCORE(...)` | Combined BM25 + vector similarity |
| `PREGEL_BFS(seed_id => ..., max_rounds => 4)` | Iterative graph BFS |
| `GENERATE_REPORT(type => ..., period => ...)` | Signed compliance report |
| `SIMILAR TO <Type> WHERE id = '...'` | Multi-vector similarity |
| `ERASE SUBJECT '<id>' REASON '<r>' [CERTIFY]` | GDPR Art. 17 crypto-shred |

See the [SQL reference](https://www.relatadb.dev/docs/reference/sql) for full syntax.

## Typed query IR builder

A standalone, dependency-free builder for the JSON query IR (`relata_query_ir: "v1"`),
importable from its own subpath so it never bloats the core client bundle:

```typescript
import { query, pathsBetween, graph } from "@zysec-ai/relata-sdk/builder";

const ir = query()
  .purpose("analytics")
  .from("Person")
  .select("id", "name")
  .where("age", ">", 30)
  .limit(10)
  .build();

const paths = graph("investigation").from("alice@acme.com").to("bob@acme.com").maxHops(3).build();
```

Serialises to the JSON documented in `docs/api/query-ir.md`.

## Connection pool (client-side failover)

This is client-side endpoint rotation only. It does not make a deployment highly available; the open
Relata DB 3.0 edition is a single node, so a pool is useful only against separately operated endpoints.

`ClientPool` provides round-robin load balancing across N HTTP endpoints with
health-aware failover (a failed endpoint is skipped for a cooldown period, then
retried). Covers the data-plane read surface only — `query`,
`search`, `version`, `health`, `stats`. For schema/ingest/admin operations, use a single
`RelataClient` pointed at a specific node.

```typescript
import { ClientPool } from "@zysec-ai/relata-sdk";

const pool = new ClientPool(process.env.RELATA_TOKEN)
  .withEndpoint("http://node-1:9090")
  .withEndpoint("http://node-2:9090")
  .withEndpoint("http://node-3:9090");

const result = await pool.query("SELECT * FROM Person LIMIT 5", "analytics");
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `RELATA_TOKEN` | — | Bearer token for authentication |
| `RELATA_PURPOSE` | — | Default purpose (CLI helper) |
| `RELATA_URL` | `http://localhost:9090` | Server URL (examples / CLI) |

## Examples

See [`examples/`](./examples/) for runnable workflows:

| File | What it shows |
|---|---|
| `basic-query.ts` | Health check, raw SQL, typed query, fluent builder |
| `analytics.ts` | Full analytics workflow (identity, cases, financials, graph) |
| `hybrid-search.ts` | `VectorClient.hybridSearch()` — embed, ingest, BM25-only vs. vector-only vs. fused (RRF) search |
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

## Deployment

`RELATA_PROFILE` accepts only `free` (the default); `server`, `cluster` and `lite` are rejected at startup (#5809). Posture follows configuration, and the SDK works identically in each:

| Use case | Start command |
|---|---|
| Local / single process / dev | `relata serve` (loopback) |
| Single-node production | `RELATA_HTTP_BIND=0.0.0.0:9090 RELATA_BEARER_TOKEN=<secret> RELATA_ADMIN_TOKEN=<secret> relata serve` |

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

`StreamingClient.queryRows()` uses `/v1/query/stream` NDJSON and yields data rows,
not the reserved leading/terminal metadata frames. Treat the answer as complete
only after the iterator finishes normally: missing, malformed, truncated or
inconsistent terminal metadata raises `IncompleteQueryStreamError`, carrying
`queryId` and `rowsReceived`. Rows already yielded are a partial answer on failure;
the SDK does not automatically retry them. Breaking out of iteration cancels the
underlying reader and does not establish completion. A scalar `_meta` result
column remains ordinary row data. HTTP failures retain `StreamingHttpError`,
including status, raw body, parsed problem fields and retry guidance.
For `queryRows`, the existing `maxResponseBytes` option (default 64 MiB) bounds
**each NDJSON frame**, measured as UTF-8 bytes before parsing; it does not cap the
whole long-running stream. Oversized frames raise `ResponseTooLargeError` and
cancel the reader. Streaming HTTP error bodies use the same capped buffered
reader before parsing error details; no new size option is required.
Buffered and specialized HTTP errors preserve typed `RelataError` metadata:
`statusCode`, `queryId`, `requestId`, `code`, `typeUrl`, `retryable`, and
`retryAfterSeconds` when supplied. A valid `Retry-After` delta or HTTP date takes
precedence over a finite nonnegative `retry_after` problem extension. This is
server guidance, not permission to replay a write; the SDK does not automatically
retry POST/PUT/PATCH/DELETE requests after an uncertain response.
