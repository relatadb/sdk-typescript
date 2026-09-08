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
 * Kept in its own dependency-free leaf module (mirrors `_retry.ts`) so every
 * body-reading call site — `client.ts`, `_typed-http.ts`, `s3.ts`,
 * `streaming.ts`, `observability.ts` — can import it without risking an ESM
 * circular-import cycle back through `client.ts`.
 */

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
