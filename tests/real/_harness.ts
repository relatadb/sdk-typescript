/**
 * Real-use-case harness: instruments every public SDK class method so a live
 * run MEASURES which methods were actually invoked and whether each invocation
 * reached the server (an HTTP response came back) -- no mocks, no recordings.
 * Evidence is written to $RELATA_EVIDENCE_DIR/calls-<suite>.json on exit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as sdk from "../../src/index.ts";

export type Outcome = "ok" | "http_error" | "client_error";
export interface CallStat {
  calls: number;
  ok: number;
  http_error: number;
  client_error: number;
  /** invocations during which at least one HTTP response was received */
  reached_server: number;
  /** distinct HTTP statuses observed while this method was on the stack */
  statuses: Record<string, number>;
  /** first client-side (non-HTTP) error message, if any */
  first_client_error?: string;
}

export const stats: Record<string, CallStat> = {};
const stack: string[] = [];
const reached = new Map<string, number>();

const origFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  const res = await origFetch(...args);
  for (const id of new Set(stack)) {
    const s = stats[id];
    if (!s) continue;
    reached.set(id, (reached.get(id) ?? 0) + 1);
    s.statuses[String(res.status)] = (s.statuses[String(res.status)] ?? 0) + 1;
  }
  return res;
}) as typeof fetch;

const CLASS_NAMES = [
  "RelataClient", "Memory", "GovernanceClient", "McpClient", "A2AClient", "SearchClient",
  "RagClient", "Namespace", "AuditClient", "IdentityClient", "ObjectClient", "IngestClient",
  "VectorClient", "SystemClient", "FeedBrokerClient", "StreamingClient", "TenantAdminClient",
  "BackupClient", "EvidenceClient", "IngestControlClient", "MediaWorkClient",
  "OntologyDefinitionsClient", "AssertionsClient", "ExtractionClient", "ResolutionClient",
  "FreshnessClient", "TokenClient", "AppPrimitivesClient", "ObservabilityClient", "FilesClient",
  "InvestigationClient", "QueryBuilder", "PathsQueryBuilder",
] as const;

function wrap(cls: string, name: string, fn: (...a: unknown[]) => unknown) {
  const id = `${cls}.${name}`;
  stats[id] ??= { calls: 0, ok: 0, http_error: 0, client_error: 0, reached_server: 0, statuses: {} };
  return function (this: unknown, ...args: unknown[]) {
    const s = stats[id]!;
    s.calls++;
    const before = reached.get(id) ?? 0;
    stack.push(id);
    const done = (outcome: Outcome, err?: unknown) => {
      stack.pop();
      s[outcome]++;
      if ((reached.get(id) ?? 0) > before) s.reached_server++;
      if (outcome === "client_error" && s.first_client_error === undefined) {
        s.first_client_error = String((err as Error)?.message ?? err).slice(0, 200);
      }
    };
    let out: unknown;
    try {
      out = fn.apply(this, args);
    } catch (e) {
      done(classify(e), e);
      throw e;
    }
    if (out && typeof (out as Promise<unknown>).then === "function") {
      return (out as Promise<unknown>).then(
        (v) => (done("ok"), v),
        (e) => (done(classify(e), e), Promise.reject(e)),
      );
    }
    const gen = out as AsyncGenerator<unknown> | null;
    if (gen && typeof gen === "object" && typeof gen.next === "function" && Symbol.asyncIterator in gen) {
      // Async generator (streaming): the HTTP traffic happens inside next(), so keep
      // the method on the stack for each pull and score the whole iteration.
      stack.pop();
      let first = true;
      const step = (fn: () => Promise<IteratorResult<unknown>>) => {
        stack.push(id);
        const b = reached.get(id) ?? 0;
        return fn().then(
          (r) => { stack.pop(); if (first) { first = false; s.ok++; } if ((reached.get(id) ?? 0) > b) s.reached_server++; return r; },
          (e) => { stack.pop(); if (first) { first = false; s[classify(e)]++; if (classify(e) === "client_error" && s.first_client_error === undefined) s.first_client_error = String((e as Error)?.message).slice(0, 200); } else s[classify(e)]++; if ((reached.get(id) ?? 0) > b) s.reached_server++; return Promise.reject(e); },
        );
      };
      return {
        next: (...a: []) => step(() => gen.next(...a)),
        return: (v?: unknown) => gen.return(v),
        throw: (e?: unknown) => gen.throw(e),
        [Symbol.asyncIterator]() { return this; },
      };
    }
    // Sync return (builders, accessors, factories): count as ok.
    done("ok");
    return out;
  };
}

function classify(e: unknown): Outcome {
  const sc = (e as { statusCode?: number })?.statusCode;
  return typeof sc === "number" && sc > 0 ? "http_error" : "client_error";
}

let instrumented = false;
export function instrument(): void {
  if (instrumented) return;
  instrumented = true;
  const mod = sdk as unknown as Record<string, { prototype?: object }>;
  for (const cls of CLASS_NAMES) {
    const klass = mod[cls] as unknown as (Function & { prototype?: object }) | undefined;
    const proto = klass?.prototype;
    if (!klass || !proto) throw new Error(`SDK class ${cls} is not exported from the package root`);
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const d = Object.getOwnPropertyDescriptor(proto, name)!;
      if (typeof d.value === "function") {
        Object.defineProperty(proto, name, { ...d, value: wrap(cls, name, d.value) });
      } else if (typeof d.get === "function") {
        // accessor (baseUrl, tenant, ...): counted as a call of the same name
        Object.defineProperty(proto, name, { ...d, get: wrap(cls, name, d.get as never) as never });
      }
    }
    // static factories such as fromClient
    for (const name of Object.getOwnPropertyNames(klass)) {
      const d = Object.getOwnPropertyDescriptor(klass, name)!;
      if (typeof d.value !== "function" || ["length", "name", "prototype"].includes(name)) continue;
      Object.defineProperty(klass, name, { ...d, value: wrap(cls, name, d.value) });
    }
  }
}

export const HOST = process.env.RELATA_HOST || "http://localhost:9090";
export const TOKEN = process.env.RELATA_TOKEN;
export const ADMIN = process.env.RELATA_ADMIN_URL || "http://localhost:9091";
export const ADMIN_TOKEN = process.env.RELATA_ADMIN_TOKEN;
export const uid = () => `${Date.now() % 100000000}${Math.floor(Math.random() * 1000)}`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns truthy or `ms` elapses; returns the last value. */
export async function until<T>(fn: () => Promise<T>, ms = 15000, step = 250): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await sleep(step);
    v = await fn();
  }
  return v;
}

export function writeEvidence(suite: string, extra: Record<string, unknown> = {}): void {
  const dir = process.env.RELATA_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `calls-${suite}.json`), JSON.stringify({ suite, stats, ...extra }, null, 1));
}

instrument();
export { sdk };

import { RelataClient } from "../../src/index.ts";

export function mkClient(over: Record<string, unknown> = {}): InstanceType<typeof RelataClient> {
  return new RelataClient({
    baseUrl: HOST,
    bearerToken: TOKEN,
    adminBaseUrl: ADMIN,
    defaultPurpose: "investigation",
    timeoutMs: 30000,
    ...over,
  } as ConstructorParameters<typeof RelataClient>[0]);
}
/** A client holding an unscoped `schema-admin` registry token (schema-changing routes). */
export function mkAdmin(): InstanceType<typeof RelataClient> {
  return mkClient({ bearerToken: process.env.RELATA_SCHEMA_TOKEN ?? ADMIN_TOKEN });
}
/** A client holding an unscoped `platform-admin` registry token (rule suppression, tenants, ...). */
export function mkPlat(): InstanceType<typeof RelataClient> {
  return mkClient({ bearerToken: process.env.RELATA_PLATFORM_TOKEN ?? ADMIN_TOKEN });
}
/** A client holding the bootstrap admin secret, pointed at the loopback admin listener. */
export function mkPlatform(): InstanceType<typeof RelataClient> {
  return mkClient({ bearerToken: ADMIN_TOKEN, baseUrl: ADMIN });
}
export const statusOf = (e: unknown): number => (e as { statusCode?: number })?.statusCode ?? 0;

/** Await `p`, assert it rejects with an HTTP status in `want`, and return the error. */
export async function expectHttp(p: Promise<unknown>, want: number[] | number): Promise<{ statusCode: number; code?: string; message: string }> {
  const list = Array.isArray(want) ? want : [want];
  try {
    await p;
  } catch (e) {
    const sc = statusOf(e);
    if (!list.includes(sc)) throw new Error(`expected HTTP ${list.join("|")}, got ${sc}: ${(e as Error).message}`);
    return e as { statusCode: number; code?: string; message: string };
  }
  throw new Error(`expected HTTP ${list.join("|")}, but the call succeeded`);
}
