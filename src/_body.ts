/**
 * @internal
 * Shared helper for reading a `Response.body` that may be body-less.
 *
 * `fetch()`/undici set `response.body` to `null` for every HEAD response and
 * for 204 (No Content), 205 (Reset Content), and 304 (Not Modified) — per
 * RFC 9110 §6.4.1 these statuses never carry a message body. Every body
 * reader in this SDK previously fell back to `response.body ?? new
 * ReadableStream<Uint8Array>()` — but a bare `ReadableStream` constructed
 * with no underlying source (no `start` callback) never enqueues a chunk and
 * never closes, so `reader.read()` against it never settles. Any main-port
 * call that ever receives one of those body-less responses would park the
 * calling promise forever, and — because the per-attempt timeout timer in
 * `RelataClient`/`TypedClientBase` is scoped to `fetch()` itself (which has
 * already resolved with headers by the time the body read starts) — the
 * timeout cannot rescue it either (#5278; same null-body shape IntOps#4977
 * fixed at the S3 door).
 *
 * Kept in its own leaf module (mirrors `_retry.ts`) so every
 * body-reading call site — `client.ts`, `_typed-http.ts`, `s3.ts`,
 * `streaming.ts`, `observability.ts` — can import it without risking an ESM
 * circular-import cycle back through `client.ts`.
 */

import { ResponseTooLargeError } from "./errors.ts";

/**
 * Return `response.body` unchanged when present, otherwise a genuinely
 * closed empty stream — so a body-less response resolves a body read
 * immediately with `{ done: true }` instead of hanging.
 */
export function bodyOrClosedStream(response: Response): ReadableStream<Uint8Array> {
  if (response.body !== null) return response.body;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/** @internal Shared capped buffered reader; always attempts stream cancellation. */
export async function readCappedResponseBody(response: Response, cap: number): Promise<Uint8Array> {
  const reader = bodyOrClosedStream(response).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > cap) throw new ResponseTooLargeError(cap);
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* cancellation is best effort */ }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}
