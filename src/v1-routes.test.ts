// #6039: SDK 2.6.x called the unversioned data-plane routes, so every call
// against a 3.0 server returned 404. A 3.0 server serves the data plane under
// `/v1`; only the operational and discovery routes below stay unversioned.
// This scans every wrapper's route literals so a new unversioned data-plane
// path fails here rather than at a 3.0 server.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));

// Unversioned on a 3.0 server: health/version/metrics, the admin listener,
// the OpenAPI document, MCP's JSON-RPC door and A2A discovery.
const UNVERSIONED = [
  "/health",
  "/ready",
  "/version",
  "/metrics",
  "/admin/",
  "/openapi.json",
  "/mcp",
  "/.well-known/",
];

// `feed-broker.ts` talks to the separate RIFN broker at its own URL, not the
// database listener. Suffix fragments joined onto a `/v1/...` base by a
// helper (`item(workId, "/heartbeat")`) are not routes on their own.
const OTHER_SERVICE = new Set(["feed-broker.ts"]);
const SUFFIX_ARG = /,\s*$/;

// A quoted string or template literal that starts with "/" followed by a
// lowercase segment: the shape every wrapper uses for its route.
const ROUTE_LITERAL = /["'`](\/[a-z.][a-z0-9._-]*(?:\/[^"'`\s]*)?)["'`$?]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "adapters" ? sourceFiles(p) : [];
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

test("every data-plane route the SDK calls is under /v1 (#6039)", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (OTHER_SERVICE.has(file.slice(SRC.length + 1))) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
      for (const m of line.matchAll(ROUTE_LITERAL)) {
        const path = m[1]!;
        if (SUFFIX_ARG.test(line.slice(0, m.index))) continue;
        if (path.startsWith("/v1/") || path === "/v1") continue;
        if (UNVERSIONED.some((u) => path === u || path.startsWith(u.endsWith("/") ? u : `${u}/`) || path.startsWith(`${u}?`))) continue;
        offenders.push(`${file.slice(SRC.length + 1)}:${i + 1} ${path}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `unversioned data-plane routes:\n${offenders.join("\n")}`);
});
