/**
 * @relata/sdk — TypeScript SDK for the Relata data engine.
 *
 * Relata is a Rust data engine for ontology-driven, enterprise-grade workloads.
 * This SDK provides a typed HTTP client, a fluent query builder, and full TypeScript
 * types for all API responses.
 *
 * **Quick start**
 *
 * ```typescript
 * import { createClient } from "@relata/sdk";
 *
 * const relata = createClient("http://localhost:8080", {
 *   bearerToken: process.env.RELATA_TOKEN,
 *   defaultPurpose: "analytics",
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
 * // Graph traversal
 * const paths = await relata
 *   .select("Person")
 *   .pathsBetween("customer-001", "device-042", { maxHops: 3 })
 *   .purpose("security_incident")
 *   .limit(100)
 *   .execute();
 * ```
 *
 * **Key concepts**
 * - Every query must declare a `purpose` (e.g. `"analytics"`, `"audit"`).
 * - SQL is extended with `AS OF`, `WITH PROVENANCE`, `PATHS_BETWEEN`, `MATCH_FACE`,
 *   `LOOKUP_IDENTITY`, `HYBRID_SCORE`, `NETWORK_EXPAND`.
 * - Bearer token auth via `Authorization: Bearer <token>`.
 * - Zero runtime dependencies — uses native `fetch` (Node 18+, Deno, Bun, browser).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export { RelataClient } from "./client.ts";
export type { RelataClientOptions } from "./types.ts";

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

export { QueryBuilder, PathsQueryBuilder } from "./query.ts";
export type { SortDirection } from "./query.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  AuditCountResponse,
  ClusterNode,
  ClusterNodesResponse,
  HealthResponse,
  QueryOptions,
  QueryResult,
  StatusResponse,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export {
  AuthError,
  BadRequestError,
  ForbiddenError,
  NetworkError,
  PurposeError,
  QuotaError,
  RelataError,
  ServerError,
  TimeoutError,
} from "./errors.ts";

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
 * import { createClient } from "@relata/sdk";
 *
 * const relata = createClient("http://localhost:8080", {
 *   bearerToken: process.env.RELATA_TOKEN,
 *   defaultPurpose: "analytics",
 *   timeoutMs: 30_000,
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
