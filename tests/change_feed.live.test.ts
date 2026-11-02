/**
 * Live change-feed follower for scripts/sdk_change_feed_live.py (#5716). The
 * driver owns the server (it SIGKILLs and restarts it); this file only runs the
 * SDK's `followChanges` and appends every delivered event to RELATA_FEED_OUT as
 * one JSON line, until the file named by RELATA_FEED_STOP exists. Skips unless
 * RELATA_TOKEN, RELATA_FEED_OUT and RELATA_FEED_STOP are all set, so a plain
 * `node --test` stays green without a server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";

import { ObjectClient, RelataClient } from "../src/index.ts";

const BASE = process.env.RELATA_HOST || "http://localhost:9090";
const TOKEN = process.env.RELATA_TOKEN;
const OUT = process.env.RELATA_FEED_OUT;
const STOP = process.env.RELATA_FEED_STOP;

test("change feed follow survives server kill and restart", { skip: !(TOKEN && OUT && STOP) }, async () => {
  const client = new RelataClient({ baseUrl: BASE, bearerToken: TOKEN, timeoutMs: 5000 });
  const objects = ObjectClient.fromClient(client);
  const abort = new AbortController();
  const timer = setInterval(() => {
    if (existsSync(STOP!)) abort.abort();
  }, 100);
  let pages = 0;
  try {
    for await (const page of objects.followChanges({
      limit: 50,
      pollIntervalSeconds: 0.2,
      maxReconnects: 40,
      reconnectBackoffSeconds: 0.25,
      maxBackoffSeconds: 2,
      signal: abort.signal,
    })) {
      pages += 1;
      const lines = page.events.map((e) => JSON.stringify({ eventId: e.eventId, seq: e.seq, id: e.id }));
      appendFileSync(OUT!, lines.join("\n") + "\n");
    }
  } finally {
    clearInterval(timer);
  }
  assert.ok(pages > 0, "the follower delivered at least one page");
});
