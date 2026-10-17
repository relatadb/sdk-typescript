import test from "node:test";
import assert from "node:assert/strict";
import { FilesClient, RelataClient, RelataError, ServerError, TimeoutError } from "./index.ts";
import { ResponseTooLargeError } from "./errors.ts";

test("Files preserves binary views, encoded keys, inherited authentication and DELETE 204", async () => {
  const bytes = new Uint8Array([99, 0, 255, 128, 42, 99]).subarray(1, 5);
  const methods: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/files/content");
    assert.equal(url.searchParams.get("key"), "folder/a+b ?&/雪");
    assert.equal(url.searchParams.get("bucket"), "tenant one");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer secret");
    assert.equal(headers.get("X-Relata-Tenant-Id"), "tenant one");
    assert.ok(headers.get("X-Request-ID"));
    methods.push(init!.method!);
    if (init?.method === "PUT") {
      assert.deepEqual(new Uint8Array(init.body as ArrayBuffer), bytes);
      assert.equal(headers.get("Content-Type"), "application/x-test");
      return Response.json({ key: url.searchParams.get("key"), size: 4, etag: '"hash"' }, { status: 201 });
    }
    if (init?.method === "GET") {
      return new Response(Uint8Array.from(bytes).buffer, { headers: { ETag: '"hash"', "Content-Type": "application/x-test" } });
    }
    return new Response(null, { status: 204 });
  };
  const files = FilesClient.fromClient(new RelataClient({ baseUrl: "http://example.invalid", bearerToken: "secret", tenant: "tenant one", fetch: fetchImpl }));
  const opts = { bucket: "tenant one", contentType: "application/x-test" };
  assert.equal((await files.put("folder/a+b ?&/雪", bytes, opts)).size, 4);
  const content = await files.get("folder/a+b ?&/雪", opts);
  assert.deepEqual(content.data, bytes);
  assert.equal(content.etag, '"hash"');
  assert.equal(content.contentType, "application/x-test");
  assert.equal(content.size, 4);
  await files.delete("folder/a+b ?&/雪", opts);
  assert.deepEqual(methods, ["PUT", "GET", "DELETE"]);
});

for (const method of ["PUT", "DELETE"] as const) {
  test(`Files ${method} retains typed 503 metadata and never retries uncertain writes`, async () => {
    let calls = 0;
    const files = new FilesClient({ baseUrl: "http://example.invalid", maxRetries: 2, retryBackoffMs: 0,
      fetch: async () => { calls++; return Response.json({ detail: "durability uncertain", code: "uncertain", retryable: true }, {
        status: 503, headers: { "Content-Type": "application/problem+json", "Retry-After": "2", "X-Request-ID": "request-1" },
      }); } });
    await assert.rejects(method === "PUT" ? files.put("k", new Uint8Array()) : files.delete("k"), (error: unknown) => {
      assert.ok(error instanceof ServerError);
      assert.equal(error.code, "uncertain");
      assert.equal(error.requestId, "request-1");
      assert.equal(error.retryAfterSeconds, 2);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("Files caps success and error bodies and cancels oversized streams", async () => {
  for (const status of [200, 503]) {
    let cancelled = false;
    const files = new FilesClient({ baseUrl: "http://example.invalid", maxResponseBytes: 3,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(4)); },
        cancel() { cancelled = true; },
      }), { status }) });
    await assert.rejects(files.get("k"), ResponseTooLargeError);
    assert.equal(cancelled, true);
  }
});

test("Files rejects unexpected successful statuses instead of acknowledging a write", async () => {
  const files = new FilesClient({ baseUrl: "http://example.invalid", fetch: async () => Response.json({}, { status: 202 }) });
  await assert.rejects(files.put("k", new Uint8Array()), (error: unknown) => error instanceof RelataError && error.statusCode === 202);
  await assert.rejects(files.delete("k"), RelataError);
});

test("Files GET retries eligible status through the shared dispatcher", async () => {
  let calls = 0;
  let cancelled = false;
  const files = new FilesClient({ baseUrl: "http://example.invalid", maxRetries: 2, retryBackoffMs: 0,
    fetch: async () => {
      if (++calls === 1) return new Response(new ReadableStream<Uint8Array>({
        cancel() { cancelled = true; },
      }), { status: 503 });
      assert.equal(cancelled, true, "previous response must be closed before retry");
      return new Response("ok");
    } });
  assert.equal(new TextDecoder().decode((await files.get("k")).data), "ok");
  assert.equal(calls, 2);
});

test("Files timeout aborts a body stalled after headers and a subsequent GET works", async () => {
  const captured: { signal?: AbortSignal | null } = {};
  let calls = 0;
  const files = new FilesClient({ baseUrl: "http://example.invalid", timeoutMs: 10,
    fetch: async (_input, init) => {
      if (++calls > 1) return new Response("ok");
      captured.signal = init?.signal ?? null;
      return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init!.signal!.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      },
    })); } });
  await assert.rejects(files.get("k"), TimeoutError);
  assert.equal(captured.signal?.aborted, true);
  assert.equal(new TextDecoder().decode((await files.get("k")).data), "ok");
});
