# Changelog

All notable changes to `@zysec-ai/relata-sdk` (the TypeScript SDK) will be
documented here. The single source of truth for the project version is the
workspace `Cargo.toml`'s `[workspace.package].version`, mirrored into
`package.json` by `scripts/check_versions.py`.

## [Unreleased]

### Added (#5689)

- Every `POST /v1/ingest/bulk` (`IngestClient.bulk` with envelope options,
  `RelataClient.ingestDocument`) carries an automatic `Idempotency-Key` when
  none is given, reused by the client's retries (`maxRetries`) on network
  errors and 502/504; a 503 from Relata is not retried. An explicit
  `idempotencyKey` is never replaced.

### Added — maintenance-pause 503s are resent transparently (#6302)

- `RelataClient` and every typed client resend a `503` whose body names
  `pause_reason` `rollover_begin`, `rollover_commit`, `backup` or `restore` with
  `retryable: true`, for every verb, after its `Retry-After` (at most 5 s per
  wait) and outside `maxRetries`, until the new `pauseRetryBudgetMs` option
  (default `30000`, `0` disables) is spent.

### Changed (breaking, #5960 `/v1` route restructure)

- Every data-plane wrapper now calls its `/v1/...` path (for example
  `/query` -> `/v1/query`, `/memory/*` -> `/v1/memory/*`,
  `/tokens/self*` -> `/v1/auth/tokens/self*`, `/session/{id}` ->
  `/v1/sessions/{id}`, `/notifications/rules` -> `/v1/notification-rules`,
  `/alerts/list|submit|update/{id}` -> `/v1/alerts` + `/v1/alerts/{id}`,
  `/status` -> `/v1/system/status`, `/debug/stats` -> `/v1/system/stats`,
  `/events/append` -> `/v1/ingest/events`, `/object-changes` -> `/v1/changes`).
  Method names are unchanged where the operation survives. `/health`,
  `/version`, `/admin/*`, `/openapi.json` and `POST /mcp` are unchanged.
- `Memory.search`/`searchDetailed` and `RelataClient.recall` now use
  `POST /v1/memory/recall` (the `GET` recall route was removed).
- `VectorClient.embedBatch(texts)` posts `{texts}` to `POST /v1/embed`.
- `TenantAdminClient` now exposes only `me()` (tenant administration is Enterprise-only).
- `TokenClient` now wraps the tenant self-service routes: `listSelf`,
  `selfAudit`, `rotateSelf`, `revokeSelf`.

### Removed (breaking, #5960)

- Removed routes: `RelataClient.listModules`, `registerWebhook` /
  `listWebhooks` / `deleteWebhook` (webhooks are now a channel of notification
  rules: set `webhook_url` / `webhook_headers` on the rule),
  `SystemClient.listPipelines` / `definePipeline`, `AuditClient.entries` /
  `findByRequestId` (use `AuditClient.log`), `LogClient` (transparency log),
  the dedup-token methods (`remember`/`check`/`revoke`/`stats`),
  `VectorClient.embedImage` / `embedFace` / `embedAudio` / `embedVideo`,
  `Namespace.branchFrom` (use the schema-branch wrappers), and the `relata
  nodes` CLI command.
- Enterprise-only, no longer in the public SDK: tenant administration
  (`create`/`get`/`delete`/`setTier`/`suspend`/`reactivate`/`setQuota`/
  `tenantUsage`/sharing/`platformUsage`/`platformLicense`), cluster calls
  (`clusterTopology`/`clusterRebalance`/`clusterDrain`/`clusterNodes`) and the
  `ClusterNode` types. `/platform/*` is no longer routed to `adminBaseUrl`.

### Added

- Version pairing (#6039): SDK 3.0.x targets a 3.0.x server's `/v1` routes;
  2.x SDKs get 404 against 3.0. See the
  [version pairing table](../README-v3-migration.md#server-and-sdk-version-pairing).
  The 3.0 application-builder routes are reachable through
  `ObjectClient.upsert(type, id, fields, {expectedVersion | ifAbsent})`
  (`PUT /v1/objects/{type}/{id}` with `If-Match` / `If-None-Match: *`),
  `ObjectClient.delete(type, id, {expectedVersion})`, `ObjectClient.commit`
  (`POST /v1/commit`), `ObjectClient.changes` / `changePages` /
  `followChanges` (`GET /v1/changes`) and `AppPrimitivesClient`
  (sequences and the durable job queue).

- `MediaWorkClient.requeue`, `FilesClient.head` / `list` / `mediaContent`,
  `Memory.rememberProcedure` / `recallProcedure`,
  `StreamingClient.recallStream`, `GovernanceClient.erase` /
  `deletionStatus` / `verifyReceipt`.

- `IngestControlClient` (checkpoints, data contracts, contract quality,
  quarantine), `MediaWorkClient.qualification()`, `Memory.associateBatch()`,
  `FilesClient.createFolder()` -- wrappers for routes that had no SDK method.

### Fixed

- `GovernanceClient.listWormPolicies()` now returns the server's `policies`
  list (`{object_type, worm, retention: "indefinite", retention_secs: null}`
  per type, #6045). A server that sends only `worm_types` yields
  `{object_type, worm: true}` entries (was `{type_name}`).
- `GovernanceClient.setWormPolicy(objectType, retentionSecs?)`: the
  retention is now optional and the docs no longer claim rows unlock after
  `retentionSecs`. WORM is indefinite; a finite value on a type already under
  WORM is a 409 `worm-retention-cannot-shorten` (`ConflictError`).
- `AppPrimitivesClient.renew()` defaults `leaseMs` to 30 s like `claim()`; the
  server rejects a renew without it.
- `Memory.associate()` sent `source_id`/`target_id` and `Memory.summarise()`
  sent `source_ids`/`summary_content`; the server reads `from_id`/`to_id` and
  `ids`/`contents`, so both calls were rejected or silently ignored.

### Changed (behaviour)

- **`IdentityClient.eraseSubject` omitted `certify` now defaults to the safe
  side — no CERTIFY keyword (IntOps #3268).** `ERASE SUBJECT` is an
  irreversible GDPR Art. 17 crypto-shred, and the engine deliberately
  requires the literal `CERTIFY` keyword, refusing otherwise with
  `CERTIFY keyword required to confirm irreversible erasure`
  (`crates/relata-cli/src/serve/query.rs`). The SDK previously defaulted an
  omitted `certify` to `true`, silently appending `CERTIFY` on behalf of
  callers that never considered the flag — undermining the engine's safety
  rail. Now only an explicit `certify: true` confirms the erasure; omitted or
  `false` omits the keyword and the call fails loudly until the caller opts
  in. **Breaking:** callers that relied on the old silent default must pass
  `certify: true` explicitly — that is the point. (Same fix applied to the
  Python and Go SDKs' `erase_subject`/`EraseSubject`.)

- **POST is no longer auto-retried on 502/503/504 (#2489, P0 correctness).**
  The retry loop now only retries **idempotent** verbs (`GET`/`HEAD`/`OPTIONS`)
  on retryable status codes and network errors. `POST`/`PUT`/`PATCH`/`DELETE`
  are never retried — a gateway timeout after commit would otherwise risk
  double-execution of irreversible operations (`erase_subject`,
  `fuse_identities`, `session_commit`). This matches the Python and Go SDKs'
  idempotent-verb retry policy. If you were relying on POST retries, set `maxRetries: 0`
  (the new effective behaviour for non-idempotent verbs) or issue the request
  through an idempotent door.

- **Default `timeoutMs` is now `30000` (30 s) instead of `0` (#2494).** The
  previous default of `0` meant *no timeout*, which let a hung connection
  block a caller indefinitely. The new default matches the Python and Go
  SDKs. Pass `timeoutMs: 0` explicitly to restore the opt-out (no timeout).

### Added

- **`ClientPool` connection pool (#2756, parity with Rust `RelataClientPool`).**
  New `sdks/typescript/src/pool.ts`, exported from the package root. Mirrors
  the Rust round-robin + health-aware-failover HTTP pool over the data-plane
  read surface (`query`, `search`, `version`, `health`, `stats`): a failed
  endpoint is skipped for a cooldown period, then retried. Schema/ingest/admin
  operations should continue to use a single `RelataClient` pointed at a
  specific node.

- **IR builder (`src/builder.ts`) is now reachable (#2756, audit delta).**
  `package.json` `exports` previously omitted the `./builder` subpath even
  though `src/builder.ts`'s own JSDoc (and the README) advertised
  `import ... from "@zysec-ai/relata-sdk/builder"` — a published install could
  never actually resolve it. Added the subpath to `exports` and to the tsup
  build entry list; existing `src/builder.test.ts` coverage plus a new
  regression test guard the `exports` declaration itself.

- **`Namespace` handle (#2491, T9 flagship retrieval surface).** New
  `relata.namespace(name)` factory bound to one object type, exposing the
  search-developer shape with no SQL on the client side: `query`, `write`
  (schemaless `/ingest/auto` upsert), `get`, `deleteAll` (governed
  bi-temporal tombstone), and `branchFrom`. Mirrors the Python
  `relata.namespace.Namespace` surface.

- **Schema-BRANCH CRUD + edge-type registry (#2497).** New flat methods on
  `RelataClient` mirroring the Rust flat client: `createSchemaBranch`,
  `deleteSchemaBranch`, `listEdgeTypes`, `registerEdgeType`. This is the
  distinct schema-BRANCH surface (git-branched ontology); it does not
  duplicate `schemaAlter` (online column evolution, #2476).

### Documented (no behaviour change)

- **Server-limited stubs now carry `@remarks` (#2756, audit delta).**
  `Memory.close()` (`memory.ts`, always a no-op — native `fetch` has no
  connection pool to close), the LlamaIndex adapter's
  `RelataMemory.getAll()` (`adapters/llamaindex.ts`, always returns `[]` —
  semantic memory has no list-all route), and the LangGraph
  `RelataCheckpointer.deleteThread()` (`adapters/langgraph.ts`, always
  throws — the server has no delete route) already behaved this way; they
  now say so explicitly in JSDoc so consumers aren't surprised.
