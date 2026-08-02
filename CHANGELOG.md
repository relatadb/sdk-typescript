# Changelog

All notable changes to `@zysec-ai/relata-sdk` (the TypeScript SDK) will be
documented here. The single source of truth for the project version is the
workspace `Cargo.toml`'s `[workspace.package].version`, mirrored into
`package.json` by `scripts/check_versions.py`.

## [Unreleased]

### Changed (behaviour)

- **POST is no longer auto-retried on 502/503/504 (#2489, P0 correctness).**
  The retry loop now only retries **idempotent** verbs (`GET`/`HEAD`/`OPTIONS`)
  on retryable status codes and network errors. `POST`/`PUT`/`PATCH`/`DELETE`
  are never retried — a gateway timeout after commit would otherwise risk
  double-execution of irreversible operations (`erase_subject`,
  `fuse_identities`, `session_commit`). Parity with the Rust SDK
  (`crates/relata-sdk-rust/src/http.rs::post` never retries) and the Go SDK's
  `isIdempotent`. If you were relying on POST retries, set `maxRetries: 0`
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
