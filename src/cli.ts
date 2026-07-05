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
 *   query <sql>     Execute a SQL query (requires --purpose)
 *
 * Options:
 *   --url <url>         Relata server URL (default: http://localhost:8080)
 *   --token <token>     Bearer token (or RELATA_TOKEN env var)
 *   --purpose <purpose> Query purpose (or RELATA_PURPOSE env var)
 *   --timeout <ms>      Request timeout in milliseconds (default: 30000)
 *   --json              Output raw JSON (default: pretty-printed)
 *
 * Examples:
 *   relata health --url http://localhost:8080
 *   relata query "SELECT * FROM Person LIMIT 5" --purpose analytics
 *   RELATA_TOKEN=secret relata audit
 */

import { createClient } from "./index.ts";
import { RelataError } from "./errors.ts";

function usage(): void {
  console.error(`
Usage: relata <command> [options]

Commands:
  health          Check server health
  status          Show server status
  audit           Show audit log count and chain validity
  nodes           List cluster nodes
  query <sql>     Execute a SQL query

Options:
  --url <url>         Relata server URL        [default: http://localhost:8080]
  --token <token>     Bearer token             [env: RELATA_TOKEN]
  --purpose <purpose> Query purpose            [env: RELATA_PURPOSE]
  --timeout <ms>      Request timeout (ms)     [default: 30000]
  --json              Output raw JSON

Examples:
  relata health
  relata query "SELECT * FROM Person LIMIT 5" --purpose analytics
  relata audit --url http://prod-relata:8080 --token $RELATA_TOKEN
`.trim());
}

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
  let url = "http://localhost:8080";
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
        console.error(`Unknown flag: ${flag}`);
        return null;
    }
  }

  return { command, sql, url, token, purpose, timeoutMs, rawJson };
}

function print(data: unknown, rawJson: boolean): void {
  if (rawJson) {
    console.log(JSON.stringify(data));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

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
        const r = await relata.health();
        print(r, rawJson);
        break;
      }
      case "status": {
        const r = await relata.status();
        print(r, rawJson);
        break;
      }
      case "audit": {
        const r = await relata.auditCount();
        if (!rawJson) {
          console.log(`Entries   : ${r.entries}`);
          console.log(`Chain valid: ${r.chainValid ? "✓ yes" : "✗ NO — INVESTIGATE IMMEDIATELY"}`);
          if (!r.chainValid) process.exit(2);
        } else {
          print(r, true);
        }
        break;
      }
      case "nodes": {
        const nodes = await relata.clusterNodes();
        print(nodes, rawJson);
        break;
      }
      case "query": {
        if (!sql) {
          console.error("Error: provide a SQL string after 'query', e.g.:\n  relata query \"SELECT * FROM Person LIMIT 5\"");
          process.exit(1);
        }
        const r = await relata.query(sql);
        if (!rawJson) {
          console.log(`Query ID : ${r.queryId}`);
          console.log(`Elapsed  : ${r.elapsedMs}ms`);
          console.log(`Rows     : ${r.rowCount}`);
          console.log("---");
          for (const row of r.rows) {
            console.log(JSON.stringify(row));
          }
        } else {
          print(r, true);
        }
        break;
      }
      default:
        console.error(`Unknown command: "${command}"`);
        usage();
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof RelataError) {
      console.error(`Error [${err.name}]: ${err.message}`);
      if (err.queryId) console.error(`Query ID: ${err.queryId}`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
