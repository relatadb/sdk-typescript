// Two-person restore: the refusal carries a confirmation id the SDK exposes,
// and restore() can send it back (with force) to finish the operation.
import assert from "node:assert/strict";
import { test } from "node:test";

import { BackupClient, ForbiddenError } from "./index.ts";

const TWO_PERSON_BODY = {
  type: "about:blank",
  title: "Forbidden",
  status: 403,
  code: "TWO_PERSON_REQUIRED",
  detail: "this operation is destructive and requires a second, distinct admin credential",
  confirmation_id: "2P-01a21e15-8481-7f63-8906-a40bbeba95b6",
  expires_at_ns: 1795801956385709000,
};

function fetchReturning(status: number, body: unknown, seen: string[]): typeof globalThis.fetch {
  return (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (typeof init?.body === "string") seen.push(init.body);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" },
    });
  }) as typeof globalThis.fetch;
}

test("restore: a two-person refusal exposes confirmationId and its expiry", async () => {
  const backup = new BackupClient({ baseUrl: "http://x", fetch: fetchReturning(403, TWO_PERSON_BODY, []) });
  await assert.rejects(backup.restore("snap-1"), (err: unknown) => {
    assert.ok(err instanceof ForbiddenError);
    assert.equal(err.code, "TWO_PERSON_REQUIRED");
    assert.equal(err.confirmationId, TWO_PERSON_BODY.confirmation_id);
    assert.equal(err.confirmationExpiresAtNs, TWO_PERSON_BODY.expires_at_ns);
    return true;
  });
});

test("restore: sends confirmationId and force when set, omits them otherwise", async () => {
  const seen: string[] = [];
  const backup = new BackupClient({ baseUrl: "http://x", fetch: fetchReturning(202, { restore_id: "rst-2" }, seen) });
  assert.equal(await backup.restore("snap-1", { force: true, confirmationId: "2P-abc" }), "rst-2");
  assert.equal(await backup.restore("snap-1"), "rst-2");
  assert.deepEqual(JSON.parse(seen[0] ?? "{}"), { snapshot_id: "snap-1", force: true, confirmation_id: "2P-abc" });
  assert.deepEqual(JSON.parse(seen[1] ?? "{}"), { snapshot_id: "snap-1" });
});
