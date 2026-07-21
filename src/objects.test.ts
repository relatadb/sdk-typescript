/**
 * Unit tests for ObjectClient.get / .delete / .list (#1171).
 * Uses a mock fetch so no live server is required.
 */

import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { ObjectClient } from "./objects.ts";

function makeClient(
  responses: Array<{ status: number; body: unknown }>,
): ObjectClient {
  let idx = 0;
  const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
    const r = responses[idx++] ?? { status: 500, body: { error: "no more mocks" } };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  };

  return new ObjectClient({
    baseUrl: "http://localhost:9090",
    bearerToken: "test-token",
    fetch: fakeFetch as typeof globalThis.fetch,
  });
}

describe("ObjectClient.get", () => {
  it("returns the object when found", async () => {
    const obj = { id: "p1", name: "Alice" };
    const client = makeClient([{ status: 200, body: obj }]);
    const result = await client.get("Person", "p1");
    assertEquals(result, obj);
  });

  it("returns null for a missing object (404)", async () => {
    const client = makeClient([{ status: 404, body: { error: "not found" } }]);
    const result = await client.get("Person", "missing");
    assertEquals(result, null);
  });
});

describe("ObjectClient.delete", () => {
  it("returns the delete receipt", async () => {
    const receipt = { deleted: true, id: "p1" };
    const client = makeClient([{ status: 200, body: receipt }]);
    const result = await client.delete("Person", "p1");
    assertEquals(result, receipt);
  });
});

describe("ObjectClient.list", () => {
  it("returns paginated results", async () => {
    const page = { items: [{ id: "p1" }, { id: "p2" }], cursor: "next", total: 10 };
    const client = makeClient([{ status: 200, body: page }]);
    const result = await client.list("Person", { limit: 2 });
    assertEquals(result.items.length, 2);
    assertEquals(result.cursor, "next");
    assertEquals(result.total, 10);
  });

  it("returns empty items when none exist", async () => {
    const client = makeClient([{ status: 200, body: { items: [] } }]);
    const result = await client.list("Person");
    assertEquals(result.items, []);
  });
});

describe("ObjectClient.get non-404 errors", () => {
  it("rethrows non-404 errors", async () => {
    const client = makeClient([{ status: 500, body: { error: "internal error" } }]);
    await assertRejects(() => client.get("Person", "p1"));
  });
});
