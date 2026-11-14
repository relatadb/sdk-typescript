/**
 * #6302: a node maintenance-pause 503 (generation rollover, backup, restore)
 * was refused before any handler ran, so both client surfaces resend it for
 * every verb after its Retry-After, within `pauseRetryBudgetMs`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { GovernanceClient, RelataClient, ServerError } from "./index.ts";
import { maintenancePauseDelayMs } from "./_retry.ts";

type Reply = () => Response;

function pause(
  reason = "rollover_commit",
  { retryable = true, retryAfter = "0" }: { retryable?: boolean; retryAfter?: string | null } = {},
): Response {
  const text = JSON.stringify({
    type: "about:blank",
    title: "Service Unavailable",
    status: 503,
    detail: "a backup snapshot, whole-store restore or generation rollover is briefly pausing this node; retry shortly",
    retryable,
    retry_after_secs: 5,
    pause_reason: reason,
  });
  // The server's pause response declares its length (`mayBePauseBody`).
  const headers: Record<string, string> = {
    "content-type": "application/problem+json",
    "content-length": String(new TextEncoder().encode(text).byteLength),
  };
  if (retryAfter !== null) headers["retry-after"] = retryAfter;
  return new Response(text, { status: 503, headers });
}

const ok = (body: unknown): Reply => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Answers with each reply in turn, repeating the last; records methods. */
function scripted(replies: Reply[]): { fetch: typeof globalThis.fetch; methods: string[] } {
  const methods: string[] = [];
  const queue = [...replies];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return next();
  }) as typeof globalThis.fetch;
  return { fetch, methods };
}

for (const reason of ["rollover_begin", "rollover_commit", "backup", "restore"]) {
  test(`#6302: RelataClient resends a POST refused by a ${reason} pause`, async () => {
    const { fetch, methods } = scripted([() => pause(reason), ok({ data: [{ n: 1 }] })]);
    const relata = new RelataClient({ baseUrl: "http://x", fetch, defaultPurpose: "p" });
    const result = await relata.query("SELECT 1");
    assert.equal(result.rows.length, 1);
    assert.deepEqual(methods, ["POST", "POST"], "resent once, with maxRetries 0");
  });
}

test("#6302: typed clients resend a POST refused by a pause", async () => {
  const { fetch, methods } = scripted([() => pause("rollover_begin"), ok({ id: "r1" })]);
  const gov = new GovernanceClient({ baseUrl: "http://x", fetch, purpose: "compliance" });
  assert.deepEqual(await gov.createRule({ name: "r" }), { id: "r1" });
  assert.deepEqual(methods, ["POST", "POST"]);
});

for (const [name, reply] of [
  ["poisoned", () => pause("poisoned", { retryable: false, retryAfter: null })],
  ["storage_recovering", () => pause("storage_recovering")],
  ["non-retryable pause", () => pause("rollover_begin", { retryable: false })],
  ["memory-pressure", () =>
    new Response(JSON.stringify({ code: "memory-pressure", retryable: true }), {
      status: 503,
      headers: { "content-type": "application/problem+json", "retry-after": "1", "content-length": "44" },
    })],
  ["pause body without Content-Length", () =>
    new Response(JSON.stringify({ pause_reason: "backup", retryable: true }), {
      status: 503,
      headers: { "content-type": "application/problem+json" },
    })],
  ["non-JSON", () => new Response("busy", { status: 503 })],
] as Array<[string, Reply]>) {
  test(`#6302: a ${name} 503 is not resent`, async () => {
    const { fetch, methods } = scripted([reply]);
    const relata = new RelataClient({ baseUrl: "http://x", fetch, defaultPurpose: "p" });
    await assert.rejects(() => relata.query("SELECT 1"), (err: unknown) => err instanceof ServerError);
    assert.deepEqual(methods, ["POST"]);
  });
}

test("#6302: pause resends stop at pauseRetryBudgetMs and throw the 503", async () => {
  // Retry-After 0 is clamped to 100 ms: waits of 100, 100, then the 50 left.
  const { fetch, methods } = scripted([() => pause()]);
  const relata = new RelataClient({ baseUrl: "http://x", fetch, defaultPurpose: "p", pauseRetryBudgetMs: 250 });
  await assert.rejects(
    () => relata.query("SELECT 1"),
    (err: unknown) => err instanceof ServerError && err.statusCode === 503,
  );
  assert.equal(methods.length, 4);
});

test("#6302: pauseRetryBudgetMs 0 disables pause resends; typed clients inherit it", async () => {
  const { fetch, methods } = scripted([() => pause()]);
  const relata = new RelataClient({ baseUrl: "http://x", fetch, defaultPurpose: "p", pauseRetryBudgetMs: 0 });
  await assert.rejects(() => relata.query("SELECT 1"), (err: unknown) => err instanceof ServerError);
  assert.deepEqual(methods, ["POST"]);
  assert.equal(relata.pauseRetryBudgetMs, 0);
  assert.equal(new RelataClient({ baseUrl: "http://x" }).pauseRetryBudgetMs, 30_000);
  const gov = GovernanceClient.fromClient(relata);
  await assert.rejects(() => gov.createRule({ name: "r" }, { purpose: "c" }));
  assert.deepEqual(methods, ["POST", "POST"], "the typed client did not resend either");
});

test("#6302: maintenancePauseDelayMs honours Retry-After, then retry_after_secs, clamped", async () => {
  const body = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ pause_reason: "backup", retryable: true, ...extra });
  const delay = (headers: Record<string, string>, extra?: Record<string, unknown>, status = 503) =>
    maintenancePauseDelayMs(new Response(body(extra), {
      status,
      headers: {
        "content-type": "application/json",
        "content-length": String(body(extra).length),
        ...headers,
      },
    }));
  assert.equal(await delay({ "retry-after": "60" }), 5_000);
  assert.equal(await delay({ "retry-after": "2" }), 2_000);
  assert.equal(await delay({}, { retry_after_secs: 3 }), 3_000);
  assert.equal(await delay({}), 1_000);
  assert.equal(await delay({ "retry-after": "2" }, {}, 502), undefined);
});
