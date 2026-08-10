/**
 * Query-shape dispatch + HyDE + decomposition — RAG epic SDK-side query
 * understanding (#4524), extended by #4536 with a content-safety pre-filter
 * gate and structured-attribute-filter query routing, and by #4535 with
 * aggregation/negation/boolean/ranking SQL routing.
 *
 * Faithful TS port of `sdks/python/relata/rag_understanding.py` (#4577,
 * epic #4576) — closing the deliberate Python-only asymmetry ADR-0298
 * introduced ("one SDK carries the canonical implementation... until real
 * usage demands porting the loop to them too"). Every verified numeric
 * constant (thresholds, defaults, the RRF `k` formula) matches the Python
 * source exactly; `smartRagQuery`'s branch order (safety gate -> SQL-shape
 * check -> decomposition/HyDE) is preserved.
 *
 * Two structural adaptations from the Python source, both required by
 * language shape rather than a deliberate behavior change:
 *
 * 1. Python exposes separate sync (`route_*_query`) and async (`aroute_*_query`)
 *    twins because its `RelataClient` has two transports. TypeScript's
 *    `RelataClient` is async-only, so each Python sync/async pair collapses
 *    to a single `async` function here (matching the Python async twin's
 *    behavior 1:1).
 * 2. Python's `smart_rag_query` takes just a `RagClient` and reaches into its
 *    private `_client` attribute to get the underlying `RelataClient` for SQL
 *    routing. TypeScript's `RagClient` (`rag.ts`) holds no such back-reference
 *    (its transport fields are true `#private`), so `smartRagQuery` here takes
 *    the `RelataClient` directly and builds a `RagClient` internally via
 *    `RagClient.fromClient()` — functionally identical from the caller's
 *    perspective, just one fewer object to construct by hand.
 *
 * Per ADR-0298, RelataDB has no server-side agent loop and orchestration
 * lives in the SDK. `sdks/python/relata/rag.py`'s `RagClient` stays the
 * canonical implementation; `./rag.ts`'s `RagClient` stays a thin
 * pass-through over the frozen `/rag/query` contract. This module is the
 * one exception epic #4576 opens: the query-understanding layer *above*
 * that thin pass-through, now shipped here too.
 *
 * This module never calls an LLM itself: {@link HypothesisGenerator} is a
 * caller-supplied callback (RelataDB runs no LLM, ADR-013).
 */

import type { RelataClient } from "./client.ts";
import { RagClient, RAG_DEFAULT_TOP_K, type RagHit, type RagQueryOptions } from "./rag.ts";
import { TypedClientBase, type TypedClientCtor } from "./_typed-http.ts";
import { sqlLiteral, validateIdentifier } from "./_sql.ts";
import type { QueryResult } from "./types.ts";
import { TimeoutError } from "./errors.ts";

// ---------------------------------------------------------------------------
// 0. Content-safety pre-filter (#4536) — runs before everything else, before
//    any /rag/query or /query call is constructed.
// ---------------------------------------------------------------------------

/**
 * A reviewed starter set of dangerous-content categories -> compiled regex,
 * for a counter-terrorism-intelligence-style deployment. **Not applied
 * unless a caller explicitly passes it** (or its own mapping) — the gate
 * itself is off by default (see {@link checkContentSafety}). Patterns are
 * precision-reviewed to require construction/how-to intent, not mere
 * mention, so a news article or countermeasures/deactivation discussion
 * about the same subject matter is not falsely refused.
 */
export const DANGEROUS_CONTENT_PATTERNS: Readonly<Record<string, RegExp>> = {
  weapons_explosives_construction:
    /\bhow\s+to\s+(?:build|make|construct|assemble|manufacture)\s+(?:an?\s+)?(?:ied|bomb|explosive\w*|pipe\s*bomb|detonator)\b|\b(?:ied|bomb|explosive)\s+construction\s+(?:guide|instructions?|manual)\b/i,
};

/** A client-side refusal from the content-safety pre-filter (#4536). */
export interface Refusal {
  /** Machine-readable refusal reason code. Always `"content_safety"`. */
  reason: string;
  /** Matched dangerous-content category label. */
  category: string;
  /** Human-readable explanation, safe to surface to callers. */
  message: string;
}

/**
 * Coarse, no-LLM content-safety pre-filter (#4536), run ahead of every other
 * technique in this module.
 *
 * Off by default: no `patterns` (or an empty mapping) never refuses
 * anything. A deployment opts in explicitly by passing a category-label ->
 * pattern mapping — {@link DANGEROUS_CONTENT_PATTERNS} is a reviewed starter
 * set, but this is a deployment-specific policy decision, so nothing is
 * applied by default.
 *
 * Returns a {@link Refusal} on the first matching category (mapping
 * iteration order), or `undefined` when nothing matches (or the gate is
 * disabled). This is a coarse pre-filter, not a substitute for governance
 * already enforced in-scan by RelataDB's ACL/cell-masking (ADR-0299 §11).
 */
export function checkContentSafety(
  query: string,
  patterns?: Readonly<Record<string, string | RegExp>>,
): Refusal | undefined {
  if (!patterns) return undefined;
  for (const [category, pattern] of Object.entries(patterns)) {
    const compiled = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");
    if (compiled.test(query)) {
      return {
        reason: "content_safety",
        category,
        message:
          `This query was refused by the content-safety pre-filter ` +
          `(category: ${JSON.stringify(category)}) before any retrieval or SQL call was made.`,
      };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 1. Query-shape dispatch
// ---------------------------------------------------------------------------

/** Detected shape of a query text, per {@link classifyQueryShape}. */
export type QueryShape =
  | "attribute_filter"
  | "aggregation"
  | "negation"
  | "boolean"
  | "ranking"
  | "conjunction"
  | "enumeration"
  | "simple";

export const QueryShape = {
  ATTRIBUTE_FILTER: "attribute_filter",
  AGGREGATION: "aggregation",
  NEGATION: "negation",
  BOOLEAN: "boolean",
  RANKING: "ranking",
  CONJUNCTION: "conjunction",
  ENUMERATION: "enumeration",
  SIMPLE: "simple",
} as const satisfies Record<string, QueryShape>;

/**
 * Shapes routed to governed SQL instead of retrieval (#4536's
 * ATTRIBUTE_FILTER, extended by #4535's four). A pure-retrieval top-k search
 * has no notion of "all"/"not"/"count"/"order by".
 */
export const SQL_ROUTABLE_SHAPES: ReadonlySet<QueryShape> = new Set<QueryShape>([
  QueryShape.ATTRIBUTE_FILTER,
  QueryShape.AGGREGATION,
  QueryShape.NEGATION,
  QueryShape.BOOLEAN,
  QueryShape.RANKING,
]);

/**
 * Physical/descriptive-attribute keyword -> canonical field name this
 * keyword's presence implies (#4536's structured-attribute-filter shape).
 * Verified against the sampled production query "list of persons above 6ft
 * tall with moustache, fair complexion". Deliberately example-driven and
 * conservative — callers extend/override via the `fieldMap` argument to
 * {@link extractAttributeFilters} / {@link routeAttributeFilterQuery}.
 */
export const ATTRIBUTE_FIELD_KEYWORDS: Readonly<Record<string, string>> = {
  tall: "height",
  height: "height",
  moustache: "facial_hair",
  mustache: "facial_hair",
  beard: "facial_hair",
  "clean-shaven": "facial_hair",
  complexion: "complexion",
  fair: "complexion",
  "dark-complexioned": "complexion",
  wheatish: "complexion",
  "olive-skinned": "complexion",
  build: "build",
  athletic: "build",
  heavyset: "build",
  slim: "build",
  lean: "build",
  scar: "distinguishing_marks",
  tattoo: "distinguishing_marks",
  birthmark: "distinguishing_marks",
  mole: "distinguishing_marks",
};

function keywordAlternationRe(keywords: Iterable<string>): RegExp {
  const escaped = [...keywords]
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "i");
}

const ATTRIBUTE_FILTER_RE = keywordAlternationRe(Object.keys(ATTRIBUTE_FIELD_KEYWORDS));

/**
 * `true` when `query` names at least one physical/descriptive attribute
 * keyword from {@link ATTRIBUTE_FIELD_KEYWORDS} — #4536's
 * structured-attribute-filter shape.
 */
export function isAttributeFilterIntent(query: string): boolean {
  return ATTRIBUTE_FILTER_RE.test(query);
}

/** Conjunction patterns: "who ... and ...", "with X and Y", "both ... and ...". */
const CONJUNCTION_RE = /\bwho\b.*\band\b|\bwith\b\s+\S+\s+\band\b\s+\S+|\bboth\b.*\band\b/i;

/** Enumeration patterns: a query opening with "which"/"list"/"how many"/etc. */
const ENUMERATION_RE = /^\s*(which|what\s+are\s+all|list|enumerate|name\s+all|how\s+many)\b/i;

/**
 * Enumeration queries aggregate across more of the corpus than a
 * single-fact lookup, so they widen `topK` past #4514's server default
 * (`RAG_RETRIEVE_DEFAULT_TOP_K`, {@link RAG_DEFAULT_TOP_K} = 8) to give
 * document-level aggregation enough candidates to work with.
 */
export const ENUMERATION_TOP_K = 25;

// ---------------------------------------------------------------------------
// 1b. Aggregation/negation/boolean/ranking detection (#4535) — a pure-
//     retrieval top-k search structurally cannot answer these; each routes
//     to governed SQL instead of retrieval.
// ---------------------------------------------------------------------------

/**
 * Lexical cues for a countable/aggregate intent ("how many", "count of",
 * "total number of", "average", ...).
 */
const AGGREGATION_RE =
  /\bhow\s+many\b|\bhow\s+much\b|\bcount\s+of\b|\btotal\s+number\s+of\b|\btotal\s+count\b|\baverage\b|\bavg\b|\bsum\s+of\b/i;

/**
 * Negation markers ("not", "except", "excluding", "without", ...) adjacent
 * to an entity/attribute reference.
 */
const NEGATION_RE = /\bnot\b|\bexcept\b|\bexcluding\b|\bwithout\b|\bisn't\b|\baren't\b|\bdoesn't\b|\bdon't\b/i;

/**
 * Boolean/set-operation shape: "members of X and Y", "belongs to X or Y",
 * "affiliated with X and Y" — structurally distinct from the CONJUNCTION
 * shape (single answer spanning more of one document, not a set operation
 * over named entities).
 */
const BOOLEAN_RE =
  /\b(?:members?\s+of|belongs?\s+to|affiliated\s+with|part\s+of)\s+[\w&-]+(?:\s+[\w&-]+){0,3}\s+(?:and|or)\s+[\w&-]+/i;

/** Ranking/top-N shape: "top N", "first N", "most X", "highest"/"lowest". */
const RANKING_RE = /\btop\s+\d+\b|\bfirst\s+\d+\b|\bmost\s+\w+\b|\bhighest\b|\blowest\b|\bleast\s+\w+\b/i;

/** `true` when `query` carries a countable/aggregate lexical cue (#4535). */
export function isAggregationIntent(query: string): boolean {
  return AGGREGATION_RE.test(query);
}

/** `true` when `query` carries a negation marker (#4535). */
export function isNegationIntent(query: string): boolean {
  return NEGATION_RE.test(query);
}

/** `true` when `query` names multiple entities joined by "and"/"or" in a set-operation shape (#4535). */
export function isBooleanIntent(query: string): boolean {
  return BOOLEAN_RE.test(query);
}

/** `true` when `query` carries a ranking/top-N lexical cue (#4535). */
export function isRankingIntent(query: string): boolean {
  return RANKING_RE.test(query);
}

/**
 * Classify `query` as a {@link QueryShape} via regex — no LLM call, cheap
 * enough to run on every query.
 *
 * Checked in this order: ATTRIBUTE_FILTER, AGGREGATION, NEGATION, BOOLEAN,
 * RANKING, CONJUNCTION, ENUMERATION, SIMPLE — see the Python reference's
 * docstring for why ATTRIBUTE_FILTER and the #4535 shapes must be checked
 * ahead of ENUMERATION (their trigger words otherwise overlap with
 * ENUMERATION's opening-word cues).
 */
export function classifyQueryShape(query: string): QueryShape {
  if (isAttributeFilterIntent(query)) return QueryShape.ATTRIBUTE_FILTER;
  if (isAggregationIntent(query)) return QueryShape.AGGREGATION;
  if (isNegationIntent(query)) return QueryShape.NEGATION;
  if (isBooleanIntent(query)) return QueryShape.BOOLEAN;
  if (isRankingIntent(query)) return QueryShape.RANKING;
  if (CONJUNCTION_RE.test(query)) return QueryShape.CONJUNCTION;
  if (ENUMERATION_RE.test(query)) return QueryShape.ENUMERATION;
  return QueryShape.SIMPLE;
}

/**
 * Return a copy of `ragOptions` adjusted for the detected `shape`.
 *
 * Conjunction queries route toward `expandWindow: true` (only if the caller
 * did not already set it explicitly). Enumeration queries widen `topK` to at
 * least {@link ENUMERATION_TOP_K}, taking the max with whatever the caller
 * already requested so an explicit larger value is never shrunk.
 */
function applyQueryShape(
  shape: QueryShape,
  ragOptions: Partial<RagQueryOptions>,
): Partial<RagQueryOptions> {
  const out = { ...ragOptions };
  if (shape === QueryShape.CONJUNCTION) {
    out.expandWindow ??= true;
  } else if (shape === QueryShape.ENUMERATION) {
    out.topK = Math.max(out.topK ?? RAG_DEFAULT_TOP_K, ENUMERATION_TOP_K);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. HyDE, with the numeric-intent guard
// ---------------------------------------------------------------------------

/**
 * Caller-supplied hypothetical-answer generator. RelataDB runs no LLM
 * (ADR-013) — this is always provided by the application, never called by
 * RelataDB itself. May return synchronously or a `Promise` (unlike the
 * Python reference's sync-only `Callable[[str], str]` — TypeScript has no
 * sync/async transport split to mirror, so this accepts either).
 */
export type HypothesisGenerator = (query: string) => string | Promise<string>;

/**
 * Numeric-intent trigger words (verified list from the reference toolkit).
 * A query containing one of these usually wants an exact number; HyDE's
 * hallucinated hypothetical answer would invent a plausible-but-wrong one,
 * so HyDE is skipped entirely for these rather than risk it.
 */
export const NUMERIC_INTENT_WORDS: ReadonlySet<string> = new Set([
  "revenue",
  "percentage",
  "percent",
  "count",
  "how many",
  "total",
  "sum",
  "average",
  "mean",
  "median",
  "dosage",
  "dose",
  "amount",
  "quantity",
  "number of",
  "price",
  "cost",
  "rate",
  "ratio",
  "margin",
  "growth rate",
]);

const NUMERIC_INTENT_RE = keywordAlternationRe(NUMERIC_INTENT_WORDS);

/**
 * `true` when `query` contains a {@link NUMERIC_INTENT_WORDS} trigger word —
 * the guard {@link expandQueryHyde} uses to skip HyDE entirely.
 */
export function isNumericIntent(query: string): boolean {
  return NUMERIC_INTENT_RE.test(query);
}

/**
 * Return the HyDE-expanded search text for `query`, or `query` unchanged
 * when {@link isNumericIntent} trips.
 *
 * `hypothesisFn` is called with `query` and must return a hypothetical
 * answer (plain text); that hypothetical answer becomes the `query` field
 * sent to `POST /rag/query` (#4514), which embeds and searches it
 * server-side — this function does not embed anything itself.
 */
export async function expandQueryHyde(
  query: string,
  hypothesisFn: HypothesisGenerator,
): Promise<string> {
  if (isNumericIntent(query)) return query;
  const hypothetical = await hypothesisFn(query);
  return hypothetical || query;
}

// ---------------------------------------------------------------------------
// 3. Decomposition + RRF merge with auto-scaling k
// ---------------------------------------------------------------------------

/**
 * Splits a multi-part question into sub-queries on (a) a `?` immediately
 * followed by a new capitalised sentence, or (b) an "and" conjoining two
 * question clauses ("... and when ...", "... and how ...").
 */
const DECOMPOSITION_SPLIT_RE =
  /\?\s+(?=[A-Z])|\s+and\s+(?=(?:what|when|where|who|which|how|why)\b)/i;

/**
 * Split `query` into independently-retrievable sub-queries.
 *
 * Returns `[query]` unchanged (a single-element array) when no split point
 * is detected — callers should treat `length === 1` as "no decomposition
 * happened," not as an error.
 */
export function decomposeQuery(query: string): string[] {
  const parts = query
    .split(DECOMPOSITION_SPLIT_RE)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : [query];
}

/**
 * Auto-scaling RRF dampening constant for merging `nSubqueries` parallel
 * result lists: `max(10, 60 / n)` (verified in the reference toolkit).
 * Deliberately *not* RelataDB's fixed internal `RRF_K=60`
 * (`crates/relata-query/src/hybrid.rs`), which fuses BM25⊕vector within one
 * `/rag/query` call — a different merge at a different layer.
 */
export function rrfKForFanout(nSubqueries: number): number {
  if (nSubqueries <= 0) throw new RangeError("nSubqueries must be positive");
  return Math.max(10.0, 60.0 / nSubqueries);
}

/** A minimal `{ hits }`-shaped response — anything `RagClient.query()` can return. */
export interface RagHitResponse {
  hits: RagHit[];
}

/**
 * Per-`chunkId` summed RRF contribution `1 / (k + rank)` across `responses`.
 * Split out from {@link rrfMerge} so the exact arithmetic (and, in
 * particular, which `k` it was actually called with) is directly assertable
 * in tests without depending on final hit ordering. Exported primarily for
 * that test parity with the Python reference's `_rrf_scores`.
 */
export function rrfScores(responses: readonly RagHitResponse[], k: number): Map<string, number> {
  const scores = new Map<string, number>();
  for (const response of responses) {
    response.hits.forEach((hit, i) => {
      const rank = i + 1;
      scores.set(hit.chunk_id, (scores.get(hit.chunk_id) ?? 0) + 1 / (k + rank));
    });
  }
  return scores;
}

/** Result of {@link rrfMerge}: deduped, RRF-ordered hits plus a convenience `total`. */
export interface RrfMergedResult {
  hits: RagHit[];
  total: number;
}

/**
 * Reciprocal-Rank-Fuse `responses` (one per sub-query) into a single merged
 * result, deduped by `chunk_id` and re-ordered by the summed RRF
 * contribution `1 / (k + rank)` (see {@link rrfScores}).
 *
 * Each hit's own `bm25_score`/`vector_score` is passed through untouched —
 * RRF only decides final ordering/dedup here, it never fuses or overwrites
 * those fields.
 */
export function rrfMerge(responses: readonly RagHitResponse[], k: number): RrfMergedResult {
  const scores = rrfScores(responses, k);
  const firstSeen = new Map<string, RagHit>();
  for (const response of responses) {
    for (const hit of response.hits) {
      if (!firstSeen.has(hit.chunk_id)) firstSeen.set(hit.chunk_id, hit);
    }
  }
  const orderedIds = [...scores.keys()].sort((a, b) => (scores.get(b)! - scores.get(a)!));
  const hits = orderedIds.map((id) => firstSeen.get(id)!);
  return { hits, total: hits.length };
}

// ---------------------------------------------------------------------------
// SQL-predicate building shared by every routing function below
// ---------------------------------------------------------------------------

/** A single `{field, op, value}` predicate — the shape SQL-routing extraction produces. */
export interface AttributeFilter {
  field: string;
  op: string;
  value: unknown;
}

/**
 * `{ purpose }` when `purpose` is defined, `{}` otherwise.
 *
 * Under `exactOptionalPropertyTypes`, an object literal with `purpose:
 * possiblyUndefined` is a distinct (disallowed) type from the key being
 * absent — every call site below that forwards an optional `purpose`
 * through to a `QueryOptions`-shaped parameter spreads this instead of
 * writing the key directly, so an unset `purpose` stays genuinely absent.
 */
function purposeOpt(purpose: string | undefined): { purpose?: string } {
  return purpose !== undefined ? { purpose } : {};
}

/**
 * Strip every `undefined`-valued key from `obj`, for the same
 * `exactOptionalPropertyTypes` reason as {@link purposeOpt} but for a
 * multi-field options object built from several independently-optional
 * inputs at once.
 */
function stripUndefined<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v !== undefined) out[key] = v;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

const SQL_OP_ALLOWLIST = new Set([">=", "<=", "=", "ILIKE", "NOT ILIKE", "IN"]);

function sqlLiteralValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  return sqlLiteral(String(value));
}

function filterToSqlPredicate(f: AttributeFilter): string {
  validateIdentifier(f.field, "field name");
  if (!SQL_OP_ALLOWLIST.has(f.op)) {
    throw new RangeError(`invalid SQL operator ${JSON.stringify(f.op)}`);
  }
  if (f.op === "IN") {
    const values = (f.value as unknown[]).map(sqlLiteralValue).join(", ");
    return `${f.field} IN (${values})`;
  }
  return `${f.field} ${f.op} ${sqlLiteralValue(f.value)}`;
}

// ---------------------------------------------------------------------------
// 4. Structured-attribute-filter routing (#4536)
// ---------------------------------------------------------------------------

/** "above/over/taller than N (ft|feet|cm|in|inches)" — the >= half of the height-comparison shape. */
const ATTRIBUTE_ABOVE_RE =
  /\b(?:above|over|taller\s+than|greater\s+than|more\s+than)\s+(\d+(?:\.\d+)?)\s*(ft|feet|cm|in|inches)?\b/i;
/** "below/under/shorter than N (ft|feet|cm|in|inches)" — the <= half. */
const ATTRIBUTE_BELOW_RE =
  /\b(?:below|under|shorter\s+than|less\s+than)\s+(\d+(?:\.\d+)?)\s*(ft|feet|cm|in|inches)?\b/i;

const FEET_TO_CM = 30.48;
const INCH_TO_CM = 2.54;

function heightValueCm(raw: string, unit: string | undefined): number {
  const value = Number(raw);
  const u = (unit ?? "ft").toLowerCase();
  if (u === "ft" || u === "feet") return Math.round(value * FEET_TO_CM * 10) / 10;
  if (u === "in" || u === "inches") return Math.round(value * INCH_TO_CM * 10) / 10;
  return value; // already centimeters
}

/**
 * Extract `[{field, op, value}]` predicates for an attribute-filter-shaped
 * query (#4536).
 *
 * `fieldMap` overrides/extends {@link ATTRIBUTE_FIELD_KEYWORDS}. Height
 * comparisons (e.g. "above 6ft tall") become a `>=`/`<=` predicate on the
 * mapped field, converted to centimeters. Every other matched keyword
 * becomes an `ILIKE` predicate. Returns `[]` when nothing in the query
 * matches {@link ATTRIBUTE_FIELD_KEYWORDS} — callers must treat that as
 * "could not extract a filter," not an error.
 */
export function extractAttributeFilters(
  query: string,
  fieldMap?: Readonly<Record<string, string>>,
): AttributeFilter[] {
  const keywords: Record<string, string> = { ...ATTRIBUTE_FIELD_KEYWORDS, ...fieldMap };
  const heightField = keywords["height"] ?? "height";

  const filters: AttributeFilter[] = [];

  const above = ATTRIBUTE_ABOVE_RE.exec(query);
  if (above) {
    filters.push({ field: heightField, op: ">=", value: heightValueCm(above[1]!, above[2]) });
  }
  const below = ATTRIBUTE_BELOW_RE.exec(query);
  if (below) {
    filters.push({ field: heightField, op: "<=", value: heightValueCm(below[1]!, below[2]) });
  }

  const seenFields = new Set(filters.map((f) => f.field));
  const orderedKeywords = Object.keys(keywords).sort((a, b) => b.length - a.length);
  for (const keyword of orderedKeywords) {
    const field = keywords[keyword]!;
    // Height is comparison-only (above/below), never ILIKE. A bare
    // field-name mention (e.g. "complexion" -> "complexion") names no
    // actual value, so it must not become a self-referential
    // `complexion ILIKE '%complexion%'` predicate. Every other field takes
    // its first matching keyword only.
    if (field === heightField || seenFields.has(field) || keyword === field) continue;
    if (new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(query)) {
      filters.push({ field, op: "ILIKE", value: `%${keyword}%` });
      seenFields.add(field);
    }
  }

  return filters;
}

function attributeFilterSql(
  query: string,
  type: string,
  fieldMap: Readonly<Record<string, string>> | undefined,
  knownFields: Iterable<string> | undefined,
): string | undefined {
  validateIdentifier(type, "type");
  let filters = extractAttributeFilters(query, fieldMap);
  if (knownFields !== undefined) {
    const known = new Set(knownFields);
    filters = filters.filter((f) => known.has(f.field));
  }
  if (filters.length === 0) return undefined;
  const whereClause = filters.map(filterToSqlPredicate).join(" AND ");
  return `SELECT * FROM ${type} WHERE ${whereClause}`;
}

/** Options shared by every SQL-routing function below. */
export interface RouteQueryOptions {
  purpose?: string;
  fieldMap?: Readonly<Record<string, string>>;
  knownFields?: Iterable<string>;
}

/**
 * Route an attribute-filter-shaped query (#4536) to a governed SQL
 * `/query` call instead of a semantic-similarity retrieval guess.
 *
 * Returns `undefined` (never throws for "nothing to route") when
 * {@link extractAttributeFilters} found nothing, or when `knownFields` is
 * given and none of the extracted filters' fields are present in it — the
 * caller falls back to retrieval in that case rather than silently guessing
 * against fields that don't exist on `type`'s schema.
 */
export async function routeAttributeFilterQuery(
  client: RelataClient,
  query: string,
  type: string,
  opts: RouteQueryOptions = {},
): Promise<QueryResult | undefined> {
  const sql = attributeFilterSql(query, type, opts.fieldMap, opts.knownFields);
  if (sql === undefined) return undefined;
  return client.query(sql, purposeOpt(opts.purpose));
}

// ---------------------------------------------------------------------------
// 5. Aggregation/negation/boolean/ranking SQL routing (#4535)
// ---------------------------------------------------------------------------
//
// Unlike ATTRIBUTE_FIELD_KEYWORDS (a general-purpose default for physical/
// descriptive attributes), there is no sensible universal keyword
// vocabulary for these four shapes — callers supply their own
// `fieldMap` (keyword -> canonical field name, deployment-specific).
// AGGREGATION is the one exception: a bare COUNT(*) needs no domain
// vocabulary at all, so it always attempts SQL routing.

/**
 * Generic keyword -> field predicate extraction, shared by the aggregation/
 * negation/boolean routers (#4535) — the same mechanism as
 * {@link extractAttributeFilters}'s ILIKE branch, but against a
 * caller-required `fieldMap` rather than a built-in default.
 *
 * `dedupeFields: true` (the default) keeps only the first matching keyword
 * per field, matching {@link extractAttributeFilters}'s behaviour.
 * {@link routeBooleanQuery} passes `dedupeFields: false` because a boolean
 * shape's whole point is multiple predicates over the *same* field.
 */
export function extractKeywordFilters(
  query: string,
  fieldMap: Readonly<Record<string, string>>,
  opts: { op?: string; dedupeFields?: boolean } = {},
): AttributeFilter[] {
  const op = opts.op ?? "ILIKE";
  const dedupeFields = opts.dedupeFields ?? true;
  const filters: AttributeFilter[] = [];
  const seenFields = new Set<string>();
  const orderedKeywords = Object.keys(fieldMap).sort((a, b) => b.length - a.length);
  for (const keyword of orderedKeywords) {
    const field = fieldMap[keyword]!;
    if (dedupeFields && seenFields.has(field)) continue;
    if (new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(query)) {
      const value = op === "ILIKE" || op === "NOT ILIKE" ? `%${keyword}%` : keyword;
      filters.push({ field, op, value });
      seenFields.add(field);
    }
  }
  return filters;
}

/**
 * Return the canonical field for the first `fieldMap` keyword found in
 * `query` (longest keyword first), or `undefined` when nothing matches —
 * used by {@link routeRankingQuery} to pick the `ORDER BY` column.
 */
function firstMatchingField(
  query: string,
  fieldMap: Readonly<Record<string, string>>,
): string | undefined {
  const orderedKeywords = Object.keys(fieldMap).sort((a, b) => b.length - a.length);
  for (const keyword of orderedKeywords) {
    if (new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(query)) {
      return fieldMap[keyword];
    }
  }
  return undefined;
}

/**
 * Route an aggregation-shaped query (#4535, e.g. "how many incidents
 * happened in 2023?") to a governed `SELECT COUNT(*)` instead of a
 * retrieval top-k the caller would have to guess-count from.
 *
 * Always attempts SQL routing (returns a real `QueryResult`, never
 * `undefined`) when no `fieldMap` is given, or when `fieldMap` is given but
 * names nothing found in `query` — a bare `COUNT(*)` over `type` needs no
 * domain vocabulary. Returns `undefined` (fall back to retrieval) only when
 * `fieldMap` *did* extract a keyword filter but `knownFields` rules every
 * extracted field out.
 */
export async function routeAggregationQuery(
  client: RelataClient,
  query: string,
  type: string,
  opts: RouteQueryOptions = {},
): Promise<QueryResult | undefined> {
  validateIdentifier(type, "type");
  let filters = opts.fieldMap ? extractKeywordFilters(query, opts.fieldMap) : [];
  if (opts.knownFields !== undefined && filters.length > 0) {
    const known = new Set(opts.knownFields);
    const resolved = filters.filter((f) => known.has(f.field));
    if (resolved.length === 0) return undefined;
    filters = resolved;
  }
  let sql = `SELECT COUNT(*) AS count FROM ${type}`;
  if (filters.length > 0) {
    sql += ` WHERE ${filters.map(filterToSqlPredicate).join(" AND ")}`;
  }
  return client.query(sql, purposeOpt(opts.purpose));
}

/**
 * Route a negation-shaped query (#4535, e.g. "Which SIMI members are NOT in
 * custody?") to a governed `NOT ILIKE` predicate instead of retrieval —
 * retrieval has no notion of "not".
 *
 * Requires `fieldMap` (no built-in default). Returns `undefined` when
 * `fieldMap` is absent, or extracts no keyword, or (with `knownFields`
 * given) resolves to no schema-known field.
 */
export async function routeNegationQuery(
  client: RelataClient,
  query: string,
  type: string,
  opts: RouteQueryOptions = {},
): Promise<QueryResult | undefined> {
  if (!opts.fieldMap) return undefined;
  validateIdentifier(type, "type");
  let filters = extractKeywordFilters(query, opts.fieldMap, { op: "NOT ILIKE" });
  if (opts.knownFields !== undefined) {
    const known = new Set(opts.knownFields);
    filters = filters.filter((f) => known.has(f.field));
  }
  if (filters.length === 0) return undefined;
  const whereClause = filters.map(filterToSqlPredicate).join(" AND ");
  return client.query(`SELECT * FROM ${type} WHERE ${whereClause}`, purposeOpt(opts.purpose));
}

/** Matches the conjunction word actually used in a BOOLEAN-shaped query. */
const BOOLEAN_CONJUNCTION_WORD_RE = /\b(and|or)\b/i;

/**
 * Route a boolean/set-operation-shaped query (#4535, e.g. "Members of SIMI
 * AND LeT") to governed SQL predicates joined by the query's own
 * `AND`/`OR` instead of a semantic-similarity guess.
 *
 * Requires `fieldMap` and at least two resolved keyword matches — anything
 * less returns `undefined` and the caller falls back to retrieval.
 */
export async function routeBooleanQuery(
  client: RelataClient,
  query: string,
  type: string,
  opts: RouteQueryOptions = {},
): Promise<QueryResult | undefined> {
  if (!opts.fieldMap) return undefined;
  validateIdentifier(type, "type");
  let filters = extractKeywordFilters(query, opts.fieldMap, { op: "=", dedupeFields: false });
  if (opts.knownFields !== undefined) {
    const known = new Set(opts.knownFields);
    filters = filters.filter((f) => known.has(f.field));
  }
  if (filters.length < 2) return undefined;
  const conj = BOOLEAN_CONJUNCTION_WORD_RE.exec(query);
  const joiner = conj && conj[1]!.toLowerCase() === "or" ? " OR " : " AND ";
  const whereClause = filters.map(filterToSqlPredicate).join(joiner);
  return client.query(`SELECT * FROM ${type} WHERE ${whereClause}`, purposeOpt(opts.purpose));
}

/** Explicit "top N" / "first N" count, when given. */
const RANKING_N_RE = /\btop\s+(\d+)\b|\bfirst\s+(\d+)\b/i;
/** "highest"/"most" default to descending; no explicit N given. */
const RANKING_ASCENDING_RE = /\blowest\b|\bleast\b/i;
/** Default `LIMIT` for a ranking query with no explicit "top N"/"first N". */
export const DEFAULT_RANKING_LIMIT = 10;

function rankingLimit(query: string): number {
  const m = RANKING_N_RE.exec(query);
  if (!m) return DEFAULT_RANKING_LIMIT;
  return Number(m[1] ?? m[2]);
}

/**
 * Route a ranking/top-N-shaped query (#4535, e.g. "Top 5 most active
 * members") to a governed `ORDER BY ... LIMIT N` instead of retrieval.
 *
 * Requires `fieldMap` naming the sortable attribute — returns `undefined`
 * when `fieldMap` is absent, resolves to no field, or (with `knownFields`
 * given) the resolved field isn't schema-known.
 */
export async function routeRankingQuery(
  client: RelataClient,
  query: string,
  type: string,
  opts: RouteQueryOptions = {},
): Promise<QueryResult | undefined> {
  if (!opts.fieldMap) return undefined;
  const orderField = firstMatchingField(query, opts.fieldMap);
  if (orderField === undefined) return undefined;
  if (opts.knownFields !== undefined && !new Set(opts.knownFields).has(orderField)) {
    return undefined;
  }
  validateIdentifier(type, "type");
  validateIdentifier(orderField, "order field");
  const limit = rankingLimit(query);
  const direction = RANKING_ASCENDING_RE.test(query) ? "ASC" : "DESC";
  const sql = `SELECT * FROM ${type} ORDER BY ${orderField} ${direction} LIMIT ${limit}`;
  return client.query(sql, purposeOpt(opts.purpose));
}

// ---------------------------------------------------------------------------
// 5b. ENUMERATION large-result-set routing (#4535, second half)
// ---------------------------------------------------------------------------
//
// "Give me all calls made by X last year" is structurally different from
// the four shapes above: its legitimate result can be thousands to millions
// of rows. `POST /rag/export` always runs the query as a background
// operation; a result at/under the server's row threshold comes back
// inline, a larger one is written as a governed S3Object and the response
// carries the real count, a small explicitly-labeled preview, and the
// bucket/key to fetch the rest.

/** Default interval between `GET /v1/operations/{id}` polls, in milliseconds. */
export const ENUMERATION_POLL_INTERVAL_MS = 500;

/**
 * Default ceiling on total poll time before giving up with a
 * {@link TimeoutError} — a large enumeration is a background job, but it
 * must not poll forever.
 */
export const ENUMERATION_POLL_TIMEOUT_MS = 300_000;

/**
 * Result of a completed `POST /rag/export` operation (#4535).
 *
 * Exactly one of two shapes, distinguished by {@link isFileBacked}:
 * **Inline** (`rowCount` at/under the server's threshold): `data` carries
 * every matching row; `bucket`/`key` are `undefined`. **File-backed**
 * (`rowCount` over the threshold): `preview` carries a small,
 * explicitly-labeled sample (never presented as complete);
 * `bucket`/`key`/`etag` name the governed `S3Object` holding the full
 * result, readable back via the S3-compatible door.
 */
export class LargeExportResult {
  // Explicit `| undefined` unions, not the `?:` optional modifier: a
  // constructed instance always has every key present (this isn't a wire
  // payload where key-absence is meaningful), so under
  // exactOptionalPropertyTypes the constructor's straight `this.x =
  // init.x` assignments need the field's type to literally include
  // `undefined` as a value, not just make the key optional.
  readonly rowCount: number;
  readonly columns: string[];
  readonly data: Record<string, unknown>[] | undefined;
  readonly preview: Record<string, unknown>[] | undefined;
  readonly previewNote: string | undefined;
  readonly bucket: string | undefined;
  readonly key: string | undefined;
  readonly etag: string | undefined;
  readonly contentType: string | undefined;
  readonly sizeBytes: number | undefined;

  constructor(init: {
    rowCount: number;
    columns: string[];
    data?: Record<string, unknown>[] | undefined;
    preview?: Record<string, unknown>[] | undefined;
    previewNote?: string | undefined;
    bucket?: string | undefined;
    key?: string | undefined;
    etag?: string | undefined;
    contentType?: string | undefined;
    sizeBytes?: number | undefined;
  }) {
    this.rowCount = init.rowCount;
    this.columns = init.columns;
    this.data = init.data;
    this.preview = init.preview;
    this.previewNote = init.previewNote;
    this.bucket = init.bucket;
    this.key = init.key;
    this.etag = init.etag;
    this.contentType = init.contentType;
    this.sizeBytes = init.sizeBytes;
  }

  /**
   * `true` when the result was too large for an inline response and was
   * written as a governed `S3Object` instead.
   */
  get isFileBacked(): boolean {
    return this.bucket !== undefined;
  }
}

function largeExportResultFromBody(body: Record<string, unknown>): LargeExportResult {
  return new LargeExportResult({
    rowCount: (body["row_count"] as number | undefined) ?? 0,
    columns: (body["columns"] as string[] | undefined) ?? [],
    data: body["data"] as Record<string, unknown>[] | undefined,
    preview: body["preview"] as Record<string, unknown>[] | undefined,
    previewNote: body["preview_note"] as string | undefined,
    bucket: body["bucket"] as string | undefined,
    key: body["key"] as string | undefined,
    etag: body["etag"] as string | undefined,
    contentType: body["content_type"] as string | undefined,
    sizeBytes: body["size_bytes"] as number | undefined,
  });
}

function enumerationExportSql(
  query: string,
  type: string,
  fieldMap: Readonly<Record<string, string>> | undefined,
  knownFields: Iterable<string> | undefined,
): string | undefined {
  validateIdentifier(type, "type");
  let filters = fieldMap ? extractKeywordFilters(query, fieldMap) : [];
  if (knownFields !== undefined && filters.length > 0) {
    const known = new Set(knownFields);
    const resolved = filters.filter((f) => known.has(f.field));
    if (resolved.length === 0) return undefined;
    filters = resolved;
  }
  let sql = `SELECT * FROM ${type}`;
  if (filters.length > 0) {
    sql += ` WHERE ${filters.map(filterToSqlPredicate).join(" AND ")}`;
  }
  return sql;
}

/**
 * @internal Thin `POST /rag/export` + `GET /v1/operations/{id}` transport,
 * built off the same `TypedClientBase` plumbing `RagClient` (`rag.ts`) uses
 * — inherits auth/tenant/timeout/retry from the parent `RelataClient`.
 */
class RagExportTransport extends TypedClientBase {
  static fromClient(client: RelataClient): RagExportTransport {
    return new RagExportTransport(TypedClientBase.clientToCtor(client) as TypedClientCtor);
  }

  export(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._post<Record<string, unknown>>("/rag/export", payload);
  }

  operationStatus(operationId: string): Promise<Record<string, unknown>> {
    return this._get<Record<string, unknown>>(
      `/v1/operations/${encodeURIComponent(operationId)}`,
    );
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Options for {@link routeEnumerationQuery}. */
export interface RouteEnumerationOptions {
  fieldMap?: Readonly<Record<string, string>>;
  knownFields?: Iterable<string>;
  /** Optional, filename-only hint (#4535's "human-legible filename" requirement). */
  keyFilter?: string;
  /** Optional, filename-only hint. */
  dateFrom?: string;
  /** Optional, filename-only hint. */
  dateTo?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

/**
 * Route an ENUMERATION-shaped query (#4535, e.g. "give me all calls made by
 * 9800004040 last year") to `POST /rag/export` instead of a widened-`topK`
 * retrieval guess that can never be exhaustive.
 *
 * Returns `undefined` (caller should fall back to retrieval) only when
 * `fieldMap` extracted a keyword whose field isn't in `knownFields` —
 * otherwise always attempts the export. `keyFilter`/`dateFrom`/`dateTo` are
 * optional, filename-only hints — they do not affect the query itself.
 *
 * Polls `GET /v1/operations/{id}` every `pollIntervalMs` until the
 * background export completes. Rejects with {@link TimeoutError} if it has
 * not completed within `pollTimeoutMs`, or whatever error the server
 * reports (e.g. a tripped row-cap backstop surfaced unchanged as a failed
 * operation — this routing does not bypass that cap).
 */
export async function routeEnumerationQuery(
  client: RelataClient,
  query: string,
  type: string,
  opts: RouteEnumerationOptions = {},
): Promise<LargeExportResult | undefined> {
  const sql = enumerationExportSql(query, type, opts.fieldMap, opts.knownFields);
  if (sql === undefined) return undefined;

  const payload: Record<string, unknown> = { sql, type };
  if (opts.keyFilter !== undefined) payload["key_filter"] = opts.keyFilter;
  if (opts.dateFrom !== undefined) payload["date_from"] = opts.dateFrom;
  if (opts.dateTo !== undefined) payload["date_to"] = opts.dateTo;

  const transport = RagExportTransport.fromClient(client);
  const op = await transport.export(payload);
  const operationId = op["operation_id"] as string | undefined;
  if (!operationId) return largeExportResultFromBody(op);

  const pollIntervalMs = opts.pollIntervalMs ?? ENUMERATION_POLL_INTERVAL_MS;
  const pollTimeoutMs = opts.pollTimeoutMs ?? ENUMERATION_POLL_TIMEOUT_MS;
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    const status = await transport.operationStatus(operationId);
    if (status["status"] !== "running") return largeExportResultFromBody(status);
    if (Date.now() >= deadline) {
      throw new TimeoutError(pollTimeoutMs);
    }
    await sleep(pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Entry point — composes everything ahead of the first /rag/query call
// ---------------------------------------------------------------------------

/** Result of {@link smartRagQuery} — extends the plain `{hits}` RAG response with the gate/routing outcome. */
export class SmartRagQueryResult {
  // Explicit `| undefined` unions on refused/sqlResult/lowConfidenceReason
  // (not `?:`), same reasoning as LargeExportResult above — a constructed
  // instance always has every key present.
  readonly hits: RagHit[];
  readonly total: number;
  readonly refused: Refusal | undefined;
  readonly sqlResult: QueryResult | undefined;
  lowConfidence: boolean;
  lowConfidenceReason: string | undefined;

  constructor(init: {
    hits: RagHit[];
    refused?: Refusal | undefined;
    sqlResult?: QueryResult | undefined;
    lowConfidence?: boolean;
    lowConfidenceReason?: string | undefined;
  }) {
    this.hits = init.hits;
    this.total = init.hits.length;
    this.refused = init.refused;
    this.sqlResult = init.sqlResult;
    this.lowConfidence = init.lowConfidence ?? false;
    this.lowConfidenceReason = init.lowConfidenceReason;
  }

  /** `true` when the client-side content-safety gate (#4536) refused this query before any call was made. */
  get isRefused(): boolean {
    return this.refused !== undefined;
  }

  /** `true` when a structured-attribute-filter/#4535 router answered via SQL instead of retrieval. */
  get isSqlRouted(): boolean {
    return this.sqlResult !== undefined;
  }
}

/** Options for {@link smartRagQuery}. */
export interface SmartRagQueryOptions {
  purpose?: string;
  /** When given, each sub-query's search text is HyDE-expanded before the call (skipped per sub-query when {@link isNumericIntent} trips). */
  hypothesisFn?: HypothesisGenerator;
  /** Category-label -> pattern mapping for {@link checkContentSafety} (#4536). `undefined` (the default) disables the gate entirely. */
  contentSafetyPatterns?: Readonly<Record<string, string | RegExp>>;
  /** Overrides/extends {@link ATTRIBUTE_FIELD_KEYWORDS} for #4536's structured-attribute-filter routing. */
  attributeFieldMap?: Readonly<Record<string, string>>;
  /** Restricts attribute-filter routing to fields actually present on `type`'s schema (#4536). */
  attributeKnownFields?: Iterable<string>;
  /** Keyword -> canonical field name for #4535's aggregation/negation/boolean/ranking routing. */
  structuredFieldMap?: Readonly<Record<string, string>>;
  /** Restricts #4535's routing to fields actually present on `type`'s schema. */
  structuredKnownFields?: Iterable<string>;
  /** Forwarded to `RagClient.query()` for every sub-query call, after {@link classifyQueryShape}'s per-shape adjustments are applied on top. */
  ragOptions?: Partial<RagQueryOptions>;
}

/**
 * Run `query` through the content-safety gate, structured-attribute
 * routing, decomposition, per-sub-query shape dispatch, and optional HyDE,
 * then issue the (possibly several, parallel) `/rag/query` calls via a
 * `RagClient` built from `client` and RRF-merge the results.
 *
 * Sub-query fan-out runs concurrently via `Promise.all` — the TypeScript
 * equivalent of the Python reference's async twin (`asmart_rag_query`);
 * JavaScript's single-threaded event loop has no thread-pool-size knob to
 * mirror the sync twin's `max_workers`.
 *
 * `refused` is set (empty `hits`) when the content-safety gate matched,
 * before any `/rag/query`/`/query` call was made. `sqlResult` is set (empty
 * `hits`) when an attribute-filter/aggregation/negation/boolean/
 * ranking-shaped query was routed to SQL instead of retrieval. Otherwise
 * this is the (possibly RRF-merged) retrieval result — with `lowConfidence`
 * set when a SQL-routable shape could not be routed and fell back to
 * retrieval.
 */
export async function smartRagQuery(
  client: RelataClient,
  query: string,
  type: string,
  opts: SmartRagQueryOptions = {},
): Promise<SmartRagQueryResult> {
  const refusal = checkContentSafety(query, opts.contentSafetyPatterns);
  if (refusal !== undefined) {
    return new SmartRagQueryResult({ hits: [], refused: refusal });
  }

  let lowConfidence = false;
  const shape = classifyQueryShape(query);
  if (SQL_ROUTABLE_SHAPES.has(shape)) {
    const routeOpts: RouteQueryOptions = stripUndefined({
      purpose: opts.purpose,
      fieldMap:
        shape === QueryShape.ATTRIBUTE_FILTER ? opts.attributeFieldMap : opts.structuredFieldMap,
      knownFields:
        shape === QueryShape.ATTRIBUTE_FILTER
          ? opts.attributeKnownFields
          : opts.structuredKnownFields,
    });
    let sqlResult: QueryResult | undefined;
    switch (shape) {
      case QueryShape.ATTRIBUTE_FILTER:
        sqlResult = await routeAttributeFilterQuery(client, query, type, routeOpts);
        break;
      case QueryShape.AGGREGATION:
        sqlResult = await routeAggregationQuery(client, query, type, routeOpts);
        break;
      case QueryShape.NEGATION:
        sqlResult = await routeNegationQuery(client, query, type, routeOpts);
        break;
      case QueryShape.BOOLEAN:
        sqlResult = await routeBooleanQuery(client, query, type, routeOpts);
        break;
      default: // QueryShape.RANKING
        sqlResult = await routeRankingQuery(client, query, type, routeOpts);
        break;
    }
    if (sqlResult !== undefined) {
      return new SmartRagQueryResult({ hits: [], sqlResult });
    }
    lowConfidence = true;
  }

  const ragClient = RagClient.fromClient(client);
  const subQueries = decomposeQuery(query);

  const run = async (subQuery: string): Promise<RagHitResponse> => {
    const subShape = classifyQueryShape(subQuery);
    const callOpts = applyQueryShape(subShape, opts.ragOptions ?? {});
    const searchText = opts.hypothesisFn
      ? await expandQueryHyde(subQuery, opts.hypothesisFn)
      : subQuery;
    // `type` is always defined here (unlike `purpose`), so stripUndefined's
    // blanket-optional return type isn't right for this call — spread
    // purposeOpt's conditional piece in alongside the always-present `type`.
    return ragClient.query(searchText, { ...callOpts, type, ...purposeOpt(opts.purpose) });
  };

  let merged: RrfMergedResult;
  if (subQueries.length === 1) {
    const response = await run(subQueries[0]!);
    merged = { hits: response.hits, total: response.hits.length };
  } else {
    const responses = await Promise.all(subQueries.map(run));
    merged = rrfMerge(responses, rrfKForFanout(subQueries.length));
  }

  const result = new SmartRagQueryResult({ hits: merged.hits });
  if (lowConfidence) {
    result.lowConfidence = true;
    result.lowConfidenceReason =
      `${shape}-shaped query could not be routed to SQL ` +
      `(no matching canonical field on ${JSON.stringify(type)}); fell back to retrieval (#4536/#4535)`;
  }
  return result;
}
