/**
 * Pluggable logger for the Relata TypeScript SDK.
 *
 * The SDK is **silent by default** — no `console.*` calls ship from the
 * library. Callers that want visibility into retry attempts, deprecation
 * warnings, or future diagnostics can supply a `Logger` via
 * `RelataClientOptions.logger`.
 *
 * Two ready-to-use implementations ship in this module:
 *
 * - {@link NoOpLogger} — the silent default. All methods are no-ops.
 * - {@link ConsoleLogger} — writes `warn`/`error` to `stderr` and
 *   `info`/`debug` to `stdout`, with a `relata:` prefix. Use it from CLIs
 *   and example scripts; for library consumers prefer wiring a real
 *   logger (pino, winston, bunyan, otel) via the {@link Logger} interface.
 *
 * ```typescript
 * import { createClient, ConsoleLogger } from "@zysec-ai/relata-sdk";
 *
 * const relata = createClient(url, {
 *   logger: new ConsoleLogger("my-app"),
 *   maxRetries: 3,  // retry attempts are now visible on stderr
 * });
 * ```
 *
 * Custom loggers implement the same four-method surface:
 *
 * ```typescript
 * import type { Logger } from "@zysec-ai/relata-sdk";
 *
 * const myLogger: Logger = {
 *   debug: (msg, ctx) => myTracing.span(msg, ctx),
 *   info:  (msg, ctx) => myTracing.span(msg, ctx),
 *   warn:  (msg, ctx) => myTracing.warn(msg, ctx),
 *   error: (msg, ctx) => myTracing.error(msg, ctx),
 * };
 * ```
 *
 * The optional `context` argument is a plain object so callers can forward
 * structured fields (request id, attempt number, status code, …) to their
 * observability backend without parsing strings.
 */

/**
 * Structured context payload accepted by every {@link Logger} method.
 *
 * The SDK populates keys such as `attempt`, `status`, `url`, `requestId`,
 * and `elapsedMs`; custom implementations are free to ignore or extend it.
 */
export type LogContext = Readonly<Record<string, unknown>>;

/**
 * Four-level logger surface. `error` is for failures the caller must see,
 * `warn` for recoverable situations, `info` for lifecycle events, and
 * `debug` for verbose diagnostics.
 */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

/**
 * The default logger — silent. The library assigns this when no
 * `logger` is supplied in {@link RelataClientOptions} so existing callers
 * see no behavioural change.
 */
export class NoOpLogger implements Logger {
  debug(_message: string, _context?: LogContext): void {}
  info(_message: string, _context?: LogContext): void {}
  warn(_message: string, _context?: LogContext): void {}
  error(_message: string, _context?: LogContext): void {}
}

/**
 * Wrap a {@link Logger} so any thrown error from its methods is swallowed.
 *
 * The SDK contract is "a logger failure must never take down the
 * application" — loggers are observability side-channels, not control
 * flow. This wrapper enforces that contract at the call boundary so
 * custom implementations don't need to self-guard.
 *
 * The internal SDK call sites use this wrapper; library consumers
 * composing their own loggers do not need it.
 *
 * @internal
 */
export class SafeLogger implements Logger {
  readonly #inner: Logger;

  constructor(inner: Logger) {
    this.#inner = inner;
  }

  debug(message: string, context?: LogContext): void {
    this.#invoke("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.#invoke("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.#invoke("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.#invoke("error", message, context);
  }

  #invoke(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context: LogContext | undefined,
  ): void {
    try {
      this.#inner[level](message, context);
    } catch {
      // Intentionally silent — see class doc.
    }
  }
}

/**
 * A logger that writes to `console` with a `relata:` prefix.
 *
 * - `error` / `warn` → `console.error` (so they reach `stderr` and don't
 *   pollute piped stdout in CLIs).
 * - `info` / `debug` → `console.log` (stdout).
 *
 * Each line is shaped `<prefix> <message>` followed by an optional
 * JSON-encoded context object when `context` is non-empty. The format is
 * stable enough for `grep` but not a substitute for a real structured
 * logger in production.
 *
 * @param prefix  Optional component name inserted after the `relata:` tag.
 *                Use it to distinguish multiple clients in a polyglot process.
 * @param console Optional console override (defaults to `globalThis.console`).
 *                Inject a stub in tests; never reach for this in app code.
 */
export class ConsoleLogger implements Logger {
  readonly #tag: string;
  readonly #console: Pick<Console, "log" | "error">;

  constructor(prefix?: string, override?: Pick<Console, "log" | "error">) {
    this.#tag = prefix === undefined ? "relata" : `relata:${prefix}`;
    this.#console = override ?? globalThis.console;
  }

  debug(message: string, context?: LogContext): void {
    this.#write(this.#console.log, "debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.#write(this.#console.log, "info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.#write(this.#console.error, "warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.#write(this.#console.error, "error", message, context);
  }

  #write(
    sink: (...args: unknown[]) => void,
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context: LogContext | undefined,
  ): void {
    if (context === undefined || Object.keys(context).length === 0) {
      sink(`${this.#tag} ${level.toUpperCase()} ${message}`);
    } else {
      sink(
        `${this.#tag} ${level.toUpperCase()} ${message}`,
        JSON.stringify(context),
      );
    }
  }
}
