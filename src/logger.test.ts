/**
 * Tests for the pluggable `Logger` interface and the retry-loop wiring in
 * `RelataClient`. Verifies that:
 *   1. `NoOpLogger` (the default) emits nothing.
 *   2. `ConsoleLogger` writes warn/error to `stderr`, info/debug to `stdout`,
 *      with a stable `relata:` prefix and JSON context.
 *   3. `RelataClient` with `maxRetries > 0` invokes the supplied logger on
 *      every retry attempt with structured context.
 *   4. The default client (no `logger` option) does not touch `console`.
 *
 * Uses Node's built-in `node:test` runner; no external deps.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ConsoleLogger,
  createClient,
  NoOpLogger,
  SafeLogger,
  ServerError,
  type Logger,
  type LogContext,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Capture sink — collects calls without touching the real console.
// ---------------------------------------------------------------------------

interface CapturedCall {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context: LogContext | undefined;
}

function captureSink(): { calls: CapturedCall[]; logger: Logger } {
  const calls: CapturedCall[] = [];
  const logger: Logger = {
    debug: (m, c) => calls.push({ level: "debug", message: m, context: c }),
    info:  (m, c) => calls.push({ level: "info",  message: m, context: c }),
    warn:  (m, c) => calls.push({ level: "warn",  message: m, context: c }),
    error: (m, c) => calls.push({ level: "error", message: m, context: c }),
  };
  return { calls, logger };
}

/** Plain function-call recorder (Node's `node:test` doesn't export `spy`). */
interface Spy {
  calls: unknown[][];
  fn: (...args: unknown[]) => void;
}
function spy(): Spy {
  const calls: unknown[][] = [];
  return {
    calls,
    fn: (...args: unknown[]) => { calls.push(args); },
  };
}

// ---------------------------------------------------------------------------
// Mock fetch — returns the provided responses in order.
// ---------------------------------------------------------------------------

function mockFetch(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof globalThis.fetch;
  calls: { value: number };
} {
  let i = 0;
  const calls = { value: 0 };
  const fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
    calls.value++;
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    }) as unknown as globalThis.Response;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("NoOpLogger: all four levels are no-ops", () => {
  const l = new NoOpLogger();
  // Should not throw under any call shape.
  l.debug("x");
  l.info("y", { k: 1 });
  l.warn("z", { k: 1 });
  l.error("err", { k: 1, err: "boom" });
  assert.ok(l instanceof NoOpLogger);
});

test("ConsoleLogger: warn/error go to console.error, info/debug to console.log", () => {
  const log = spy();
  const error = spy();
  const l = new ConsoleLogger("test", {
    log: log.fn as unknown as Console["log"],
    error: error.fn as unknown as Console["error"],
  });

  l.debug("d");
  l.info("i");
  l.warn("w");
  l.error("e");

  assert.equal(log.calls.length, 2, "debug+info → console.log");
  assert.equal(error.calls.length, 2, "warn+error → console.error");
});

test("ConsoleLogger: prefix is 'relata' when none supplied", () => {
  const log = spy();
  const l = new ConsoleLogger(undefined, {
    log: log.fn as unknown as Console["log"],
    error: () => {},
  });

  l.info("hello");
  const args = log.calls[0] as [string];
  assert.match(args[0], /^relata INFO hello$/);
});

test("ConsoleLogger: prefix becomes 'relata:<prefix>' when supplied", () => {
  const log = spy();
  const l = new ConsoleLogger("worker", {
    log: log.fn as unknown as Console["log"],
    error: () => {},
  });

  l.info("hi");
  const args = log.calls[0] as [string];
  assert.match(args[0], /^relata:worker INFO hi$/);
});

test("ConsoleLogger: context object is JSON-appended when non-empty", () => {
  const log = spy();
  const l = new ConsoleLogger("w", {
    log: log.fn as unknown as Console["log"],
    error: () => {},
  });

  l.info("retry", { attempt: 2, status: 503 });
  const args = log.calls[0] as [string, string];
  assert.match(args[0], /^relata:w INFO retry$/);
  assert.deepEqual(JSON.parse(args[1]), { attempt: 2, status: 503 });
});

test("ConsoleLogger: empty context is omitted entirely", () => {
  const log = spy();
  const l = new ConsoleLogger("w", {
    log: log.fn as unknown as Console["log"],
    error: () => {},
  });

  l.info("hi", {});
  // Only one argument — the message line — when context is empty.
  assert.equal((log.calls[0] as unknown[]).length, 1);
});

test("RelataClient: default logger is silent (no console writes on retry)", async () => {
  // Stash the real console to detect any leak.
  const realLog = console.log;
  const realError = console.error;
  let touched = false;
  console.log = () => { touched = true; };
  console.error = () => { touched = true; };
  try {
    // GET /health is idempotent → eligible for retry on 503 (#2489).
    const { fetch } = mockFetch([
      { status: 503, body: { error: "boom" } },
      { status: 503, body: { error: "boom" } },
      { status: 200, body: { status: "ok", profile: "free", node_id: "n1" } },
    ]);
    const client = createClient("http://x.example", {
      maxRetries: 2,
      retryBackoffMs: 1,
      fetch,
    });
    const r = await client.health();
    assert.equal(r.status, "ok");
    assert.equal(touched, false, "default logger must not touch console");
  } finally {
    console.log = realLog;
    console.error = realError;
  }
});

test("RelataClient: retry loop emits warn per attempt then error on exhaustion", async () => {
  const { calls, logger } = captureSink();
  const { fetch, calls: fetchCalls } = mockFetch([
    { status: 503, body: { error: "boom" } },
    { status: 503, body: { error: "boom" } },
    { status: 503, body: { error: "boom" } },
  ]);

  const client = createClient("http://x.example", {
    maxRetries: 2,
    retryBackoffMs: 1,
    fetch,
    logger,
  });

  // GET /health is idempotent → retried on 503 (#2489).
  await assert.rejects(
    () => client.health(),
    (err: unknown) => err instanceof ServerError,
  );

  // 2 retry warnings + 1 exhaustion error = 3 entries.
  const warns = calls.filter((c) => c.level === "warn");
  const errors = calls.filter((c) => c.level === "error");
  assert.equal(warns.length, 2, "one warn per retry attempt");
  assert.equal(errors.length, 1, "one error when retries exhaust");
  assert.equal(fetchCalls.value, 3, "one fetch per attempt");

  // Structured context on the first warn.
  const first = warns[0]!;
  assert.equal(first.message, "retrying after retryable HTTP status");
  assert.equal(first.context!["status"], 503);
  assert.equal(first.context!["attempt"], 1);
  assert.equal(first.context!["maxAttempts"], 3);
  assert.equal(first.context!["backoffMs"], 1);
  assert.equal(first.context!["method"], "GET");
  assert.equal(first.context!["path"], "/health");
});

test("RelataClient: timeout emits warn with timeoutMs in context", async () => {
  const { calls, logger } = captureSink();
  // Mock fetch that honours the abort signal — resolves/rejects only when
  // the caller aborts via the AbortController (after the timeout fires).
  const fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) reject(new Error("aborted"));
        else signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }
    });
  }) as unknown as typeof globalThis.fetch;
  const client = createClient("http://x.example", {
    defaultPurpose: "analytics",
    timeoutMs: 20,
    fetch,
    logger,
  });

  await assert.rejects(() => client.query("SELECT 1"));

  const timeo = calls.find(
    (c) => c.level === "warn" && c.message === "request timed out",
  );
  assert.ok(timeo, "timeout must emit a warn");
  assert.equal(timeo!.context!["timeoutMs"], 20);
});

test("RelataClient: a throwing logger is silently swallowed (defensive contract)", async () => {
  // A logger that throws on every call — the SDK must not propagate it,
  // because a logger is an observability side-channel, not control flow.
  const throwingLogger: Logger = {
    debug: () => { throw new Error("kaboom"); },
    info:  () => { throw new Error("kaboom"); },
    warn:  () => { throw new Error("kaboom"); },
    error: () => { throw new Error("kaboom"); },
  };
  const { fetch } = mockFetch([
    { status: 503, body: { error: "x" } },
    { status: 200, body: { status: "ok", profile: "free", node_id: "n1" } },
  ]);

  const client = createClient("http://x.example", {
    maxRetries: 1,
    retryBackoffMs: 1,
    fetch,
    logger: throwingLogger,
  });

  // GET /health is idempotent → retried on 503 (#2489).
  const r = await client.health();
  assert.equal(r.status, "ok");
});

test("SafeLogger: wraps an inner Logger and silently swallows throws", () => {
  const calls: string[] = [];
  const inner: Logger = {
    debug: (m) => { calls.push(`debug:${m}`); },
    info:  (m) => { calls.push(`info:${m}`); },
    warn:  () => { throw new Error("nope"); },
    error: () => { throw new Error("nope"); },
  };
  const safe = new SafeLogger(inner);

  // Non-throwing path passes through.
  safe.debug("d");
  safe.info("i");
  assert.deepEqual(calls, ["debug:d", "info:i"]);

  // Throwing path is swallowed — no exception escapes.
  safe.warn("w");
  safe.error("e", { k: 1 });
  // Calls array unchanged because warn/error threw before pushing.
  assert.deepEqual(calls, ["debug:d", "info:i"]);
});
