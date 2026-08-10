/**
 * coref.ts — Session-scoped coreference (anaphora) resolution — RAG epic
 * (#4530). Port of `sdks/python/relata/coref.py` (#4580, TS/Go parity).
 *
 * Multi-turn conversational callers of `/rag/query` (#4514) lose their
 * subject across turns: "What is India's capital?" then "Where is it
 * located?" has no resolvable antecedent for "it" once the second query
 * reaches retrieval in isolation, because `/rag/query` is deliberately
 * stateless and LLM-free per ADR-0299 — that contract does not change here.
 *
 * This module is the SDK-side fix: a **bounded state object**, not a
 * replayed transcript. After each turn the caller tells {@link
 * CorefResolver} the resolved subject (typically the winning hit's first
 * `entity_ids` entry — see {@link subjectFromHit}); before the next turn the
 * caller runs the query through {@link CorefResolver.resolve}, which only
 * pays a network cost when a cheap regex-level anaphora check trips.
 *
 * Storage is a governed `MemoryItem` via `POST /memory/remember` /
 * `POST /memory/consolidate` ({@link Memory}) keyed by session id — **not an
 * SDK-local cache of the subject value itself**, so a second process picking
 * up the same session id still resolves correctly. RelataDB's bi-temporal
 * supersession means each new subject naturally supersedes the last via
 * `consolidate` rather than accumulating: the state is structurally one row
 * per session, never a growing transcript.
 *
 * TypeScript is async-native, so — same as {@link Memory} — there is no
 * separate sync/async split: one `CorefResolver` class, every method
 * returns a `Promise`.
 *
 * ```typescript
 * import { CorefResolver, Memory, RelataClient } from "@zysec-ai/relata-sdk";
 *
 * const client = new RelataClient(baseUrl, { purpose: "research" });
 * const memory = new Memory(baseUrl, { purpose: "research" });
 * const coref = new CorefResolver(memory);
 *
 * const { hits } = await client.rag.query("What is India's capital?", {
 *   type: "DocumentChunk",
 *   purpose: "research",
 * });
 * if (hits.length > 0) {
 *   const subject = subjectFromHit(hits[0]);
 *   if (subject) await coref.rememberSubject("session-1", subject);
 * }
 *
 * // Next turn — "it" has no local antecedent, gets rewritten.
 * const resolved = await coref.resolve("Where is it located?", "session-1");
 * // resolved === "Where is India located?"
 * ```
 */

import { Memory } from "./memory.ts";
import type { RagHit } from "./rag.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pronouns with no fixed antecedent that a stateless single-shot query
 * cannot resolve on its own. Deliberately small and cheap — this is a
 * regex-level guard, not an NLP coreference model.
 */
const PRONOUNS: ReadonlySet<string> = new Set([
  "it",
  "there",
  "that",
  "this",
  "they",
  "them",
  "these",
  "those",
]);

const PRONOUN_RE = new RegExp(
  "\\b(" +
    [...PRONOUNS].sort((a, b) => b.length - a.length).join("|") +
    ")\\b",
  "i",
);

/**
 * Words that look like a local antecedent (capitalised, mid-sentence) but
 * aren't proper nouns — excluded so a stray "I" or a sentence-initial
 * capital doesn't suppress a real trip.
 */
const NOT_ANTECEDENTS: ReadonlySet<string> = new Set(["i"]);

/**
 * `memoryClass` used for coref-state rows — `"episodic"` matches the
 * existing turn-scoped-fact convention `Memory.add`'s default docstring
 * describes.
 */
const COREF_MEMORY_CLASS = "episodic";

const STRIP_PUNCT_RE = /^[.,!?;:'"]+|[.,!?;:'"]+$/g;

/**
 * Derive the storage session id coref state is filed under.
 *
 * Deliberately distinct from the caller's own `sessionId` so this feature's
 * one-row-per-session state never collides with (or is scanned alongside)
 * unrelated `MemoryItem` rows the caller stores under the same
 * conversational session.
 */
function corefSessionKey(sessionId: string): string {
  return `${sessionId}::coref-subject`;
}

/**
 * Cheap regex-level anaphora check.
 *
 * Trips when `query` contains one of {@link PRONOUNS} **and** no local
 * antecedent (a capitalised, non-sentence-initial word) is already present
 * in the same query — e.g. "Where is it located?" trips, but "What did
 * Marie Curie discover and how did it change physics?" does not, because
 * "Marie Curie" is a local antecedent for "it".
 */
export function hasUnresolvedPronoun(query: string): boolean {
  if (!PRONOUN_RE.test(query)) return false;
  const words = query.split(/\s+/).filter((w) => w.length > 0);
  for (const word of words.slice(1)) {
    // skip the sentence-initial word
    const stripped = word.replace(STRIP_PUNCT_RE, "");
    if (
      stripped &&
      /[A-Z]/.test(stripped[0] ?? "") &&
      stripped.length > 1 &&
      !PRONOUNS.has(stripped.toLowerCase()) &&
      !NOT_ANTECEDENTS.has(stripped.toLowerCase())
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Pure string substitution: replace the first unresolved pronoun with
 * `subject`. This is the "simple case" from the mechanism — an LLM call
 * given only `{lastSubject, newQuery}` is a documented alternative for
 * ambiguous phrasing but is not implemented here (out of scope for the
 * minimal fix; nothing about this contract prevents adding it later).
 */
function rewriteWithSubject(query: string, subject: string): string {
  // A non-global RegExp replaces only the first match — same semantics as
  // Python's `re.sub(..., count=1)`.
  return query.replace(PRONOUN_RE, subject);
}

// ---------------------------------------------------------------------------
// subjectFromHit
// ---------------------------------------------------------------------------

/**
 * Extract the resolved-subject candidate from a winning `/rag/query` hit.
 *
 * Per the mechanism (#4530 step 1): the hit's first `entity_ids` entry
 * (already in #4514's frozen response contract — no new field needed)
 * becomes the anchor subject for anaphora resolution on the next turn.
 * Returns `null` when the hit carries no `entity_ids` — nothing to
 * remember, and the caller should skip {@link CorefResolver.rememberSubject}.
 */
export function subjectFromHit(hit: RagHit): string | null {
  return hit.entity_ids.length > 0 ? hit.entity_ids[0] ?? null : null;
}

// ---------------------------------------------------------------------------
// CorefResolver
// ---------------------------------------------------------------------------

/**
 * Session-scoped anaphora resolution over a {@link Memory} client.
 *
 * Two calls drive the whole lifecycle:
 *
 * - {@link rememberSubject} — call after a turn resolves a subject.
 * - {@link resolve} — call before the next turn's `/rag/query` call;
 *   rewrites an unresolved pronoun using the last remembered subject, or
 *   returns the query unchanged when nothing trips.
 *
 * Single-turn callers pay zero extra cost: no `sessionId` or a query with no
 * unresolved pronoun both short-circuit before any network call — the regex
 * check in {@link hasUnresolvedPronoun} is the only always-on cost.
 */
export class CorefResolver {
  readonly #memory: Memory;

  constructor(memory: Memory) {
    this.#memory = memory;
  }

  /**
   * Persist `subject` as the resolved anchor for `sessionId`.
   *
   * Structurally one row: looks up any existing coref-state row for this
   * session and supersedes it via `consolidate` ({@link Memory.update})
   * instead of adding a second row, so state never grows with turn count.
   */
  async rememberSubject(sessionId: string, subject: string): Promise<void> {
    if (!sessionId || !subject) return;
    const storageSession = corefSessionKey(sessionId);
    const existing = await this.#memory.search(subject, {
      sessionId: storageSession,
      topK: 1,
    });
    if (existing.length > 0) {
      const id = existing[0]?.["id"];
      await this.#memory.update(
        id !== undefined && id !== null ? String(id) : "",
        subject,
      );
    } else {
      await this.#memory.add(subject, {
        sessionId: storageSession,
        memoryClass: COREF_MEMORY_CLASS,
      });
    }
  }

  /**
   * Rewrite `query` using the last subject remembered for `sessionId`.
   *
   * Returns `query` unchanged (no network call) when `sessionId` is empty
   * or the anaphora check does not trip. When it trips, recalls the
   * session's coref state (a single bounded `topK: 1` lookup); if no
   * subject was ever stored, `query` is returned unchanged rather than
   * guessing.
   */
  async resolve(query: string, sessionId: string): Promise<string> {
    if (!sessionId || !hasUnresolvedPronoun(query)) return query;
    const storageSession = corefSessionKey(sessionId);
    const rows = await this.#memory.search(query, {
      sessionId: storageSession,
      topK: 1,
    });
    if (rows.length === 0) return query;
    const content = rows[0]?.["content"];
    const subject = content !== undefined && content !== null ? String(content) : "";
    if (!subject) return query;
    return rewriteWithSubject(query, subject);
  }
}
