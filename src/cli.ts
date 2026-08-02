#!/usr/bin/env node
/**
 * Relata CLI helper — thin wrapper around the TypeScript SDK.
 *
 * Usage:
 *   relata <command> [options]
 *
 * Commands:
 *   health          Check server health
 *   status          Show server status
 *   audit           Show audit log count and chain validity
 *   nodes           List cluster nodes
 *   query <sql>     Execute a SQL query
 *
 * Options:
 *   --url <url>         Relata server URL (default: http://localhost:9090)
 *   --token <token>     Bearer token (or RELATA_TOKEN env var)
 *   --purpose <purpose> Per-query purpose (or RELATA_PURPOSE env var)
 *   --timeout <ms>      Request timeout in milliseconds (default: 30000)
 *   --json              Output raw JSON (default: pretty-printed)
 *
 * Exit codes:
 *   0   success
 *   1   usage error, missing argument, or generic failure
 *   2   audit chain integrity failure (tamper alert)
 *
 * Examples:
 *   relata health --url http://localhost:9090
 *   relata query "SELECT * FROM Person LIMIT 5" --purpose analytics
 *   RELATA_TOKEN=secret relata audit
 */

import { fileURLToPath } from "node:url";

import { type RelataClient, createClient } from "./index.ts";
import { QuotaError, RelataError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Output helpers — every byte the CLI writes goes through here. The shape is
// deliberate: stdout carries data, stderr carries diagnostics, so JSON
// consumers can pipe `--json` output safely even when warnings are emitted.
// ---------------------------------------------------------------------------

/** Human-readable messages and `--json` payloads go to stdout. */
function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** JSON payload (compact or pretty) goes to stdout. */
function outJson(data: unknown, pretty: boolean): void {
  out(pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
}

/** Diagnostics go to stderr so they never corrupt a stdout pipe. */
function err(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Standard usage banner, written to stderr so `--help` works in pipes. */
function usage(): void {
  err(`
Usage: relata <command> [options]

Commands:
  health          Check server health
  status          Show server status
  audit           Show audit log count and chain validity
  nodes           List cluster nodes
  query <sql>     Execute a SQL query

Options:
  --url <url>         Relata server URL        [default: http://localhost:9090]
  --token <token>     Bearer token             [env: RELATA_TOKEN]
  --purpose <purpose> Per-query purpose        [env: RELATA_PURPOSE]
  --timeout <ms>      Request timeout (ms)     [default: 30000]
  --json              Output raw JSON

Exit codes:
  0   success
  1   usage error, missing argument, or generic failure
  2   audit chain integrity failure

Examples:
  relata health
  relata query "SELECT * FROM Person LIMIT 5" --purpose analytics
  relata audit --url http://prod-relata:8080 --token $RELATA_TOKEN
`.trim());
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * Result of parsing `process.argv` (or an injected argv array in tests).
 * Exported so the contract-test harness can exercise the parser directly
 * without touching real `process.argv`/env or constructing a client.
 */
export interface ParsedCliArgs {
  command: string;
  sql: string | undefined;
  url: string;
  token: string | undefined;
  purpose: string | undefined;
  timeoutMs: number;
  rawJson: boolean;
}

/**
 * Parse an argv array (Node's full `process.argv` shape — `[node, script,
 * ...args]` — the first two entries are stripped).
 *
 * Returns `null` when the caller asked for help (`--help`/`-h`), passed no
 * arguments, or passed an unrecognized flag; the (sole) caller is
 * responsible for printing `usage()` and choosing an exit code in that case.
 *
 * Pure — reads only `argv` and (for the `RELATA_TOKEN`/`RELATA_PURPOSE`
 * defaults) `process.env`; never touches the network or exits the process.
 */
export function parseArgs(argv: string[]): ParsedCliArgs | null {
  const args = argv.slice(2); // strip node + script path

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return null;
  }

  const command = args[0] ?? "";
  let sql: string | undefined;
  let url = "http://localhost:9090";
  let token = process.env["RELATA_TOKEN"];
  let purpose = process.env["RELATA_PURPOSE"];
  let timeoutMs = 30_000;
  let rawJson = false;

  let i = 1;

  if (command === "query") {
    // Next positional arg is the SQL string
    if (i < args.length && !args[i]!.startsWith("--")) {
      sql = args[i++];
    }
  }

  while (i < args.length) {
    const flag = args[i++]!;
    switch (flag) {
      case "--url":
        url = args[i++] ?? url;
        break;
      case "--token":
        token = args[i++];
        break;
      case "--purpose":
        purpose = args[i++];
        break;
      case "--timeout":
        timeoutMs = parseInt(args[i++] ?? "30000", 10);
        break;
      case "--json":
        rawJson = true;
        break;
      default:
        err(`Error: unknown flag "${flag}"`);
        return null;
    }
  }

  return { command, sql, url, token, purpose, timeoutMs, rawJson };
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

/**
 * Run one parsed CLI invocation against an already-constructed client and
 * return the process exit code the caller should use (0 = success).
 *
 * Deliberately takes an injected `client` rather than constructing one from
 * `parsed.url`/`token`/`purpose`/`timeoutMs` itself, and returns a code
 * instead of calling `process.exit()` directly, so this function is safely
 * importable and testable (mock `fetch` on the client) without exiting the
 * host test process or touching a real server. `main()` below is the only
 * caller that turns this return value into an actual `process.exit()`.
 */
export async function runCommand(
  args: ParsedCliArgs,
  client: RelataClient,
): Promise<number> {
  const { command, sql, rawJson } = args;

  try {
    switch (command) {
      case "health": {
        outJson(await client.health(), rawJson);
        return 0;
      }
      case "status": {
        outJson(await client.status(), rawJson);
        return 0;
      }
      case "audit": {
        const r = await client.auditCount();
        if (!rawJson) {
          out(`Entries    : ${r.entries}`);
          out(
            `Chain valid: ${r.chainValid ? "yes" : "NO — TAMPER ALERT (exit 2)"}`,
          );
        } else {
          outJson(r, true);
        }
        if (!r.chainValid) {
          err("Audit chain integrity failure — investigate immediately.");
          return 2;
        }
        return 0;
      }
      case "nodes": {
        outJson(await client.clusterNodes(), rawJson);
        return 0;
      }
      case "query": {
        if (!sql) {
          err(
            'Error: provide a SQL string after \'query\', e.g.:\n  relata query "SELECT * FROM Person LIMIT 5"',
          );
          return 1;
        }
        const r = await client.query(sql);
        if (!rawJson) {
          out(`Query ID : ${r.queryId}`);
          out(`Elapsed  : ${r.elapsedMs}ms`);
          out(`Rows     : ${r.rowCount}`);
          out("---");
          for (const row of r.rows) out(JSON.stringify(row));
        } else {
          outJson(r, true);
        }
        return 0;
      }
      default:
        err(`Error: unknown command "${command}"`);
        usage();
        return 1;
    }
  } catch (e: unknown) {
    if (e instanceof RelataError) {
      err(`Error [${e.name}]: ${e.message}`);
      if (e.requestId) err(`  Request-ID : ${e.requestId}`);
      if (e.queryId) err(`  Query-ID   : ${e.queryId}`);
      if (e instanceof QuotaError && e.retryAfterSeconds !== undefined) {
        err(`  Retry-After: ${e.retryAfterSeconds}s`);
      }
      return 1;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Main — real process wiring only (argv, env, exit codes). Kept intentionally
// thin: all testable logic lives in `parseArgs`/`runCommand` above.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  if (!parsed) {
    usage();
    process.exit(1);
  }

  const { url, token, purpose, timeoutMs } = parsed;

  const clientOpts: Parameters<typeof createClient>[1] = { timeoutMs };
  if (token !== undefined) clientOpts.bearerToken = token;
  if (purpose !== undefined) clientOpts.defaultPurpose = purpose;
  const relata = createClient(url, clientOpts);

  const exitCode = await runCommand(parsed, relata);
  if (exitCode !== 0) process.exit(exitCode);
}

// ESM equivalent of the classic `require.main === module` CJS guard: only
// auto-run `main()` when this file is executed directly (e.g. as the `relata`
// bin script), not when it's imported for its exported `parseArgs`/
// `runCommand` surface (as the contract-test harness does).
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    // Unknown fatal — print message + name, never the raw object, so logs
    // stay greppable. Keep the stack on stderr for debugging.
    const message = e instanceof Error ? e.message : String(e);
    err(`Fatal: ${message}`);
    if (e instanceof Error && e.stack) err(e.stack);
    process.exit(1);
  });
}
