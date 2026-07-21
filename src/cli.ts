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

import { createClient } from "./index.ts";
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

/** Diagnostic + non-zero exit. Always exits the process. */
function die(message: string, exitCode = 1): never {
  err(message);
  process.exit(exitCode);
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

interface ParsedArgs {
  command: string;
  sql: string | undefined;
  url: string;
  token: string | undefined;
  purpose: string | undefined;
  timeoutMs: number;
  rawJson: boolean;
}

function parseArgs(argv: string[]): ParsedArgs | null {
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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  if (!parsed) {
    usage();
    process.exit(1);
  }

  const { command, sql, url, token, purpose, timeoutMs, rawJson } = parsed;

  const clientOpts: Parameters<typeof createClient>[1] = { timeoutMs };
  if (token !== undefined) clientOpts.bearerToken = token;
  if (purpose !== undefined) clientOpts.defaultPurpose = purpose;
  const relata = createClient(url, clientOpts);

  try {
    switch (command) {
      case "health": {
        outJson(await relata.health(), rawJson);
        break;
      }
      case "status": {
        outJson(await relata.status(), rawJson);
        break;
      }
      case "audit": {
        const r = await relata.auditCount();
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
          process.exit(2);
        }
        break;
      }
      case "nodes": {
        outJson(await relata.clusterNodes(), rawJson);
        break;
      }
      case "query": {
        if (!sql) {
          die(
            'Error: provide a SQL string after \'query\', e.g.:\n  relata query "SELECT * FROM Person LIMIT 5"',
          );
        }
        const r = await relata.query(sql);
        if (!rawJson) {
          out(`Query ID : ${r.queryId}`);
          out(`Elapsed  : ${r.elapsedMs}ms`);
          out(`Rows     : ${r.rowCount}`);
          out("---");
          for (const row of r.rows) out(JSON.stringify(row));
        } else {
          outJson(r, true);
        }
        break;
      }
      default:
        err(`Error: unknown command "${command}"`);
        usage();
        process.exit(1);
    }
  } catch (e: unknown) {
    if (e instanceof RelataError) {
      err(`Error [${e.name}]: ${e.message}`);
      if (e.requestId) err(`  Request-ID : ${e.requestId}`);
      if (e.queryId) err(`  Query-ID   : ${e.queryId}`);
      if (e instanceof QuotaError && e.retryAfterSeconds !== undefined) {
        err(`  Retry-After: ${e.retryAfterSeconds}s`);
      }
      process.exit(1);
    }
    throw e;
  }
}

main().catch((e: unknown) => {
  // Unknown fatal — print message + name, never the raw object, so logs stay
  // greppable. Keep the stack on stderr for debugging.
  const message = e instanceof Error ? e.message : String(e);
  err(`Fatal: ${message}`);
  if (e instanceof Error && e.stack) err(e.stack);
  process.exit(1);
});
