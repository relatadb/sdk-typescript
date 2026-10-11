import { deepEqual, equal, ok, rejects } from "node:assert";
import { test } from "node:test";
import { FeedBrokerClient, type FeedEntry } from "./feed-broker.ts";

const ENTRY: FeedEntry = {
  entry_id: "e1",
  channel: "osint-ioc",
  publisher_id: "did:web:feeds.example.test",
  published_at: "2026-10-11T00:00:00Z",
  valid_from: "2026-10-11T00:00:00Z",
  tlp: "WHITE",
  confidence: 90,
  payload_kind: "object_assertion",
  payload: { indicator: "example.test" },
  publisher_signature: "ed25519-abcd",
};

test("feed broker client targets the explicit broker URL", async () => {
  const calls: { url: string; method: string; headers: Headers; body?: unknown }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    const response = String(url).endsWith("/feed/channels")
      ? [{ path: "relata-feed/osint-ioc", min_tlp: "TLP:WHITE" }]
      : { ok: true };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const broker = new FeedBrokerClient("http://broker.test:9190", { fetch });
  await broker.health();
  deepEqual(await broker.channels(), [{ path: "relata-feed/osint-ioc", min_tlp: "TLP:WHITE" }]);
  await broker.publish("did:web:feeds.example.test", ENTRY);

  equal(calls[0]!.url, "http://broker.test:9190/feed/health");
  equal(calls[1]!.url, "http://broker.test:9190/feed/channels");
  equal(calls[2]!.url, "http://broker.test:9190/feed/publish");
  equal(calls[2]!.method, "POST");
  equal(calls[2]!.headers.get("x-publisher-did"), ENTRY.publisher_id);
  deepEqual(calls[2]!.body, ENTRY);
  ok(!("feedChannels" in (broker as unknown as Record<string, unknown>)));
});

test("feed publish rejects a blank publisher DID before sending", async () => {
  const broker = new FeedBrokerClient("http://broker.test", {
    fetch: (async () => new Response("{}")) as typeof globalThis.fetch,
  });
  await rejects(() => broker.publish(" ", ENTRY), { name: "TypeError" });
});
