/**
 * Shared helpers for the Relata TypeScript SDK examples.
 *
 * Standardises three things across every demo script:
 *   - Banner / step output (so `grep "^=="` finds every step).
 *   - Exit codes (0 = ok, 1 = SDK error, 2 = integrity failure).
 *   - Common RelataError formatting (request id, query id, retry-after).
 *
 * Examples import via relative path; this file is **not** shipped in the
 * published npm package (`files: ["dist", "README.md"]`).
 */

import {
  AuthError,
  ForbiddenError,
  type Logger,
  NoOpLogger,
  NetworkError,
  PurposeError,
  QuotaError,
  RateLimitedError,
  RelataError,
  TimeoutError,
} from "../src/index.ts";

/** Stdout write that auto-appends `\n` — mirrors the CLI helper. */
export function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** Stderr write that auto-appends `\n`. */
export function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Stderr write + non-zero exit. Always exits the process. */
export function fatal(message: string, exitCode = 1): never {
  warn(message);
  process.exit(exitCode);
}

/**
 * Print a top-of-script banner. Use once at the start of each example so
 * logs are easy to spot in mixed output.
 */
export function banner(title: string): void {
  out(`=== ${title} ===\n`);
}

/**
 * Print a numbered step header. Indented steps use `indent=true` for
 * sub-phases so `Step 2:` stays greppable.
 */
export function step(label: string): void {
  out(`\nStep: ${label}`);
}

/** Green-ish tick for a successful sub-operation. */
export function ok(message: string): void {
  out(`  ✓ ${message}`);
}

/** Amber-ish warning for a recoverable failure (ACL denial, soft reject). */
export function softFail(message: string): void {
  warn(`  ⚠ ${message}`);
}

/** Resolve `RELATA_URL` / `RELATA_TOKEN` with sensible dev defaults. */
export function loadEnv(): { url: string; token: string | undefined } {
  return {
    url: process.env["RELATA_URL"] ?? "http://localhost:9090",
    token: process.env["RELATA_TOKEN"],
  };
}

/**
 * Map a caught {@link RelataError} to a single-line human message that
 * matches the CLI's error format. Returns `null` for non-Relata errors so
 * the caller can rethrow.
 */
export function describeRelataError(err: unknown): string | null {
  if (!(err instanceof RelataError)) return null;
  const tail: string[] = [];
  if (err.requestId) tail.push(`request ${err.requestId}`);
  if (err.queryId) tail.push(`query ${err.queryId}`);
  if (err instanceof QuotaError && err.retryAfterSeconds !== undefined) {
    tail.push(`retry after ${err.retryAfterSeconds}s`);
  }
  const suffix = tail.length > 0 ? ` (${tail.join(", ")})` : "";
  if (err instanceof AuthError) {
    return `Authentication failed — set RELATA_TOKEN${suffix}`;
  }
  if (err instanceof ForbiddenError) {
    return `Access denied by Cedar ACL — ${err.serverMessage}${suffix}`;
  }
  if (err instanceof RateLimitedError) {
    return `Rate limited${suffix}`;
  }
  if (err instanceof QuotaError) {
    return `Query quota exhausted${suffix}`;
  }
  if (err instanceof PurposeError) {
    return `Purpose rejected — ${err.message}${suffix}`;
  }
  if (err instanceof NetworkError) {
    return `Cannot reach server — ${err.message}${suffix}`;
  }
  if (err instanceof TimeoutError) {
    return `Timed out after ${err.timeoutMs}ms${suffix}`;
  }
  return `${err.name}: ${err.message}${suffix}`;
}

/**
 * Top-level error trap for example scripts. Prints a one-line message to
 * stderr and exits with status 1. Non-Relata errors are rethrown so the
 * process crashes loudly on programmer bugs.
 *
 * Use it at the end of every example:
 *
 * ```typescript
 * try {
 *   // demo body
 * } catch (err) {
 *   exitOnRelataError(err);
 * }
 * ```
 */
export function exitOnRelataError(err: unknown): never {
  const msg = describeRelataError(err);
  if (msg === null) throw err;
  fatal(`✗ ${msg}`);
}

/**
 * A no-op logger for examples that don't need SDK diagnostics. Re-exported
 * here so examples don't reach into `../src/logger.ts` directly.
 *
 * Examples that *do* want retry diagnostics can swap this for
 * `new ConsoleLogger("example-name")`.
 */
export const silentLogger: Logger = new NoOpLogger();
