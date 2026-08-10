/**
 * @zysec-ai/relata-sdk — TypeScript SDK for the Relata data engine.
 *
 * Relata is a Rust data engine for ontology-driven, enterprise-grade workloads.
 * This SDK provides a typed HTTP client, a fluent query builder, an
 * agent-memory client, 12+ typed v1.1 clients that mirror the server's REST
 * surface, and full TypeScript types for all API responses.
 *
 * **Quick start**
 *
 * ```typescript
 * import { createClient } from "@zysec-ai/relata-sdk";
 *
 * const relata = createClient("http://localhost:9090", {
 *   bearerToken: process.env.RELATA_TOKEN,
 *   defaultPurpose: "analytics",
 *   tenant: "acme",        // X-Relata-Tenant-Id
 *   maxRetries: 3,         // retry on 502/503/504 + network errors
 * });
 *
 * // Raw SQL
 * const result = await relata.query("SELECT * FROM Person LIMIT 10");
 * console.log(result.rows);
 *
 * // Fluent builder
 * const persons = await relata
 *   .select("Person")
 *   .where("name LIKE 'Ahmed%'")
 *   .asOf("2025-01-01T00:00:00Z")
 *   .withProvenance()
 *   .limit(20)
 *   .execute<{ id: string; name: string }>();
 *
 * // Memory (Mem0-style governed agent memory)
 * import { Memory } from "@zysec-ai/relata-sdk";
 * const m = new Memory("http://localhost:9090", { purpose: "agent-notes" });
 * const id = await m.add("Alice prefers dark mode");
 * const hits = await m.search("ui preferences");
 *
 * // Typed clients (inherit auth + tenant via fromClient)
 * import { GovernanceClient, McpClient } from "@zysec-ai/relata-sdk";
 * const gov = GovernanceClient.fromClient(relata);
 * await gov.importSigma(open("rules.yml").read());
 * ```
 *
 * **Key concepts**
 * - Every query must declare a `purpose` (e.g. `"analytics"`, `"audit"`).
 * - SQL is extended with `AS OF`, `WITH PROVENANCE`, `PATHS_BETWEEN`, `MATCH_FACE`,
 *   `LOOKUP_IDENTITY`, `HYBRID_SCORE`, `NETWORK_EXPAND`.
 * - Bearer token auth via `Authorization: Bearer <token>`.
 * - Multi-tenant: pass `tenant` (X-Relata-Tenant-Id), `actingAs` (X-Acting-As),
 *   `delegatedBy` (X-Delegated-By) to `createClient`.
 * - RFC 7807 problem+json error mapping with `X-Request-ID` propagation.
 * - Zero runtime dependencies — uses native `fetch` (Node 18+, Deno, Bun, browser).
 * - TypeScript is async-native: every method returns a `Promise`; there are no
 *   separate `Async*` classes.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Core client
// ---------------------------------------------------------------------------

export { RelataClient } from "./client.ts";
export type { RelataClientOptions } from "./types.ts";

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

export { QueryBuilder, PathsQueryBuilder } from "./query.ts";
export type { SortDirection } from "./query.ts";

// ---------------------------------------------------------------------------
// Types — response models
// ---------------------------------------------------------------------------

export type {
  AuditCountResponse,
  ClusterNode,
  ClusterNodesResponse,
  DocumentUsageResponse,
  HealthResponse,
  IngestDocumentResponse,
  IngestDocumentTaskStatus,
  IngestResponse,
  Matcher,
  QueryOptions,
  QueryResult,
  ReadyReport,
  RecallItem,
  RecallOptions,
  RecallResponse,
  RememberOptions,
  RememberResponse,
  Stats,
  StatusResponse,
  VersionInfo,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export {
  AuthError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NetworkError,
  NotFoundError,
  PurposeError,
  QuotaError,
  RateLimitedError,
  RelataError,
  ServerError,
  TimeoutError,
  ValidationError,
} from "./errors.ts";

// ---------------------------------------------------------------------------
// Memory — Mem0-style governed agent memory
// ---------------------------------------------------------------------------

export { Memory } from "./memory.ts";
export type { MemoryOptions } from "./memory.ts";

// ---------------------------------------------------------------------------
// Typed v1.1 clients — `fromClient(client)` factories
// ---------------------------------------------------------------------------

export { GovernanceClient } from "./governance.ts";

export { McpClient } from "./mcp.ts";
export { unwrapMcp } from "./mcp.ts";

export { A2AClient } from "./a2a.ts";

export { SearchClient, buildSearchPayload } from "./search.ts";
export type { SearchQuery, SearchFilter, SearchRankBy } from "./search.ts";

// RAG epic — typed /rag/query client (#4523, foundational; #4514/ADR-0299).
// Thin pass-through only per ADR-0298 — the canonical agentic-loop
// implementation lives in sdks/python's relata.rag.
export { RagClient, buildRagPayload, RAG_DEFAULT_TOP_K } from "./rag.ts";
export type {
  RagQueryOptions,
  RagQueryResponse,
  RagHit,
  RagFilter,
  RagSearchMode,
  RagEmbeddingSlot,
} from "./rag.ts";

// RAG epic — citation-injected synthesis + post-synthesis faithfulness
// scoring (#4527, #4579). Ported from sdks/python's relata.synthesis;
// provider-agnostic (ADR-013) — callers supply llm/entailmentFn.
export {
  buildSynthesisPrompt,
  synthesize,
  DEFAULT_UNSUPPORTED_MARKER,
} from "./synthesis.ts";
export type {
  Citation,
  SynthesizedSentence,
  SynthesisResult,
  SynthesizeOptions,
  LlmFn,
  EntailmentFn,
} from "./synthesis.ts";

// Session-scoped coreference (anaphora) resolution over `/rag/query` turns
// (#4530, #4580 TS/Go parity). Port of `sdks/python/relata/coref.py`.
export { CorefResolver, hasUnresolvedPronoun, subjectFromHit } from "./coref.ts";

// MMR (Maximal Marginal Relevance) diversity selection — RAG epic (#4526),
// TS/Go parity port of sdks/python/relata/rag_rank.py (#4578). Same
// MMR_LAMBDA_BY_PURPOSE table + greedy selection formula as the Python
// reference.
export {
  MMR_LAMBDA_BY_PURPOSE,
  DEFAULT_MMR_LAMBDA,
  mmrLambdaForPurpose,
  defaultRelevance,
  defaultTextSimilarity,
  mmrSelect,
  mmrSelectForPurpose,
} from "./rag-rank.ts";
export type {
  RelevanceFn,
  SimilarityFn,
  MmrSelectOptions,
  MmrSelectForPurposeOptions,
} from "./rag-rank.ts";

// Structural table-of-contents navigation — the true multi-hop agentic
// tree-descent loop over the persisted DocumentStructureNode tree (#4542).
// Port of sdks/python's relata.structural_navigation (#4581, TS/Go parity
// — epic #4576).
export { StructuralNavigator, DEFAULT_MAX_DEPTH } from "./structural-navigation.ts";
export type {
  StructureNode,
  ChildSelector,
  NavigateStructuralTreeOptions,
} from "./structural-navigation.ts";

// RAG epic — SDK-side query-understanding layer (#4524/#4536/#4535, epic
// #4576/#4577): query-shape dispatch, HyDE, decomposition, content-safety
// gate, structured-attribute-filter + aggregation/negation/boolean/ranking
// SQL routing, and the composed `smartRagQuery` entry point. Faithful port
// of sdks/python's relata.rag_understanding — closes the Python-only
// asymmetry ADR-0298 left open pending real usage demand (#4576).
export {
  DANGEROUS_CONTENT_PATTERNS,
  checkContentSafety,
  QueryShape,
  SQL_ROUTABLE_SHAPES,
  ATTRIBUTE_FIELD_KEYWORDS,
  isAttributeFilterIntent,
  isAggregationIntent,
  isNegationIntent,
  isBooleanIntent,
  isRankingIntent,
  classifyQueryShape,
  ENUMERATION_TOP_K,
  isNumericIntent,
  expandQueryHyde,
  NUMERIC_INTENT_WORDS,
  decomposeQuery,
  rrfKForFanout,
  rrfScores,
  rrfMerge,
  extractAttributeFilters,
  routeAttributeFilterQuery,
  extractKeywordFilters,
  routeAggregationQuery,
  routeNegationQuery,
  routeBooleanQuery,
  routeRankingQuery,
  DEFAULT_RANKING_LIMIT,
  routeEnumerationQuery,
  LargeExportResult,
  ENUMERATION_POLL_INTERVAL_MS,
  ENUMERATION_POLL_TIMEOUT_MS,
  SmartRagQueryResult,
  smartRagQuery,
} from "./rag-understanding.ts";
export type {
  Refusal,
  HypothesisGenerator,
  AttributeFilter,
  RagHitResponse,
  RrfMergedResult,
  RouteQueryOptions,
  RouteEnumerationOptions,
  SmartRagQueryOptions,
} from "./rag-understanding.ts";

export { Namespace, validateNamespaceName } from "./namespace.ts";
export type {
  NamespaceQueryOptions,
  NamespaceWriteOptions,
} from "./namespace.ts";

export { AuditClient } from "./audit.ts";

export { IdentityClient } from "./identity.ts";

export { ObjectClient } from "./objects.ts";
export type { RelataRow, ObjectClientCtor, ListObjectsOptions, ListObjectsResponse } from "./objects.ts";

export { IngestClient } from "./ingest.ts";

export { VectorClient } from "./vectors.ts";
export type { VectorRow } from "./vectors.ts";

export { S3Client } from "./s3.ts";
export type { S3ClientOptions, S3HttpResponse } from "./s3.ts";

export { SystemClient } from "./system.ts";
export type { WorkflowRun, WorkflowStepStatus } from "./system.ts";

export { StreamingClient } from "./streaming.ts";
export { StreamingHttpError } from "./streaming.ts";

export { TenantAdminClient } from "./tenants.ts";

export { BackupClient } from "./backup.ts";
export type { BackupRef, RestoreStatus } from "./backup.ts";

export { TokenClient } from "./tokens.ts";
export type { TokenStats } from "./tokens.ts";

export { LogClient } from "./log.ts";
export type { LogLeaf } from "./log.ts";

export { ObservabilityClient } from "./observability.ts";
export type { ObservabilityEvent } from "./observability.ts";

// ---------------------------------------------------------------------------
// Connection pool — multi-endpoint round-robin + failover (#2756)
// ---------------------------------------------------------------------------

export { ClientPool } from "./pool.ts";
export type { ClientPoolOptions } from "./pool.ts";

// ---------------------------------------------------------------------------
// Arrow Flight — first-party do_get transport (#2492)
// ---------------------------------------------------------------------------

export { ArrowFlightTransport, createArrowFlightTransport } from "./flight.ts";
export type { ArrowFlightTransportOptions } from "./flight.ts";
export type { FlightTransport } from "./client.ts";

// ---------------------------------------------------------------------------
// gRPC query — first-party Execute transport with Arrow-IPC opt-in (#4090)
// ---------------------------------------------------------------------------

export { GrpcQueryTransport, createGrpcQueryTransport } from "./grpc-query.ts";
export type { GrpcQueryTransportOptions, GrpcQueryResult } from "./grpc-query.ts";

// ---------------------------------------------------------------------------
// Logger — pluggable diagnostic sink (silent by default)
// ---------------------------------------------------------------------------

export { ConsoleLogger, NoOpLogger, SafeLogger } from "./logger.ts";
export type { Logger, LogContext } from "./logger.ts";

// ---------------------------------------------------------------------------
// Foundational typed surfaces — client canonical validation + AML decoders
// (#2248, #2255)
// ---------------------------------------------------------------------------

export {
  CanonicalError,
  validateEmail, normalizeEmail,
  validatePhone, normalizePhone,
  validateIban, normalizeIban, mod97Valid,
  validateImei, normalizeImei,
  validateVin, normalizeVin,
  validateMsisdn, normalizeMsisdn,
  validateIpv4, normalizeIpv4,
  validateIpv6, normalizeIpv6, parseIpv6, displayIpv6,
} from "./canonical.ts";

export {
  decodeSanctionsHits,
  decodeBeneficialOwners,
  decodeCryptoTrace,
  decodeWireHops,
  decodeHawalaPairs,
  decodeResolvedIdentities,
  decodePathHops,
} from "./aml.ts";
export type {
  SanctionsHit,
  BeneficialOwner,
  CryptoTraceHop,
  WireHop,
  HawalaPair,
  ResolvedIdentity,
  PathHop,
} from "./aml.ts";

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

import { RelataClient } from "./client.ts";
import type { RelataClientOptions } from "./types.ts";

/**
 * Create a `RelataClient` from a URL and optional options object.
 *
 * This is the recommended entry point for most applications.
 *
 * ```typescript
 * import { createClient } from "@zysec-ai/relata-sdk";
 *
 * const relata = createClient("http://localhost:9090", {
 *   bearerToken: process.env.RELATA_TOKEN,
 *   defaultPurpose: "analytics",
 *   timeoutMs: 30_000,
 *   tenant: "acme",
 *   maxRetries: 3,
 * });
 * ```
 *
 * @param baseUrl - Base URL of the Relata server.
 * @param options - Optional configuration overrides.
 */
export function createClient(
  baseUrl: string,
  options?: Omit<RelataClientOptions, "baseUrl">,
): RelataClient {
  return new RelataClient({ baseUrl, ...options });
}
