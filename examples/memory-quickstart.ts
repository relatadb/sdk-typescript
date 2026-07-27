/**
 * memory-quickstart.ts — Mem0-style governed agent memory.
 *
 * Demonstrates the high-level `Memory` client: add / search / recognise /
 * consolidate / forget. Governance stays on: a non-empty purpose is required
 * on every call; `forget` is a retention retract, not a hard delete.
 *
 * Run:
 *   RELATA_TOKEN=secret node --experimental-strip-types examples/memory-quickstart.ts
 */

import { Memory } from "../src/index.ts";
import { banner, exitOnRelataError, loadEnv, out, step } from "./_helpers.ts";

const { url, token } = loadEnv();

interface Hit { text?: string; score?: number; id?: string }

async function main(): Promise<void> {
  const mem = new Memory(url, {
    bearerToken: token,
    purpose: "agent-notes",
  });

  banner("1. add — persist governed memories");
  const id1 = await mem.add("Alice prefers dark mode in the UI");
  const id2 = await mem.add("Bob's timezone is UTC+5:30");
  const id3 = await mem.add("The analytics dashboard is reviewed every Monday");
  out(`stored: ${id1}, ${id2}, ${id3}`);

  step("2. search — hybrid recall");
  const hits = (await mem.search("UI preferences", 3)) as Hit[];
  for (const [i, h] of hits.entries()) {
    out(`  ${i + 1}. [${(h.score ?? 0).toFixed(3)}] ${h.text}`);
  }

  step("3. get — fetch a specific memory by id");
  const one = (await mem.get(id1)) as Hit | null;
  out(`get(${id1}) → ${one?.text ?? "(missing)"}`);

  step("4. update — consolidate an existing memory");
  const newId = await mem.update(id1, "Alice prefers dark mode; she also uses large fonts");
  out(`updated → ${newId}`);

  step("5. forget — retention retract");
  await mem.forget(id2);
  out(`forgot ${id2}`);

  mem.close().catch(() => undefined);
}

await main().catch(exitOnRelataError);
