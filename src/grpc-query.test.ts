/**
 * Tests for the first-party gRPC query client with Arrow-IPC opt-in (#4090).
 *
 * The pure codec helpers (`encodeQueryRequest`/`decodeQueryResponse`) are
 * unit-tested directly against hand-computed wire bytes; the full
 * `GrpcQueryTransport.execute` decode path is exercised with a mock unary
 * gRPC client (both the `rows_json` and `arrow_ipc_rows` response shapes),
 * so no live gRPC server is required — mirrors `flight.test.ts`'s approach.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { tableFromArrays, tableFromIPC, tableToIPC } from "apache-arrow";

import { RelataError } from "./errors.ts";
import {
  GrpcQueryTransport,
  createGrpcQueryTransport,
  decodeQueryResponse,
  decodeRowBatch,
  encodeQueryRequest,
  isSecureGrpcQueryEndpoint,
  stripGrpcQueryScheme,
  type GrpcQueryGrpcClient,
  type GrpcQueryGrpcStream,
  type GrpcQueryPeerModules,
  type GrpcQueryStatus,
} from "./grpc-query.ts";

// ---------------------------------------------------------------------------
// QueryRequest / QueryResponse protobuf codec
// ---------------------------------------------------------------------------

test("encodeQueryRequest: encodes sql (field 2) and purpose (field 1)", () => {
  const out = encodeQueryRequest({ purpose: "analytics", sql: "SELECT 1" });
  // field 1 (purpose): tag 0x0a, len 9, "analytics"
  assert.equal(out[0], 0x0a);
  assert.equal(out[1], 9);
  assert.equal(new TextDecoder().decode(out.subarray(2, 11)), "analytics");
  // field 2 (sql): tag 0x12, len 8, "SELECT 1"
  assert.equal(out[11], 0x12);
  assert.equal(out[12], 8);
  assert.equal(new TextDecoder().decode(out.subarray(13, 21)), "SELECT 1");
  assert.equal(out.length, 21);
});

test("encodeQueryRequest: omits empty purpose/bearerToken (proto3 default elision)", () => {
  const out = encodeQueryRequest({ sql: "SELECT 1" });
  // Only field 2 (sql) present — no field-1 tag byte (0x0a) leading.
  assert.equal(out[0], 0x12);
});

test("encodeQueryRequest: sets wants_arrow_ipc_rows (field 4, varint bool) only when true", () => {
  const withFlag = encodeQueryRequest({ sql: "SELECT 1", wantsArrowIpcRows: true });
  // tag (4<<3)|0 = 0x20, value 1 — trailing 2 bytes.
  assert.deepEqual(Array.from(withFlag.subarray(withFlag.length - 2)), [0x20, 0x01]);

  const withoutFlag = encodeQueryRequest({ sql: "SELECT 1", wantsArrowIpcRows: false });
  assert.ok(!Array.from(withoutFlag).includes(0x20) || withoutFlag.length < withFlag.length);
  assert.equal(withoutFlag.length, withFlag.length - 2);
});

test("decodeQueryResponse: decodes columns (repeated), row_count (varint), rows_json (repeated)", () => {
  // Hand-craft: columns=["id","name"], row_count=2, rows_json=['{"id":1}','{"id":2}']
  const parts: number[] = [];
  const pushStr = (field: number, s: string): void => {
    const b = new TextEncoder().encode(s);
    parts.push((field << 3) | 2, b.length, ...b);
  };
  pushStr(1, "id");
  pushStr(1, "name");
  parts.push((2 << 3) | 0, 2); // row_count = 2
  pushStr(3, '{"id":1}');
  pushStr(3, '{"id":2}');
  const wire = new Uint8Array(parts);

  const decoded = decodeQueryResponse(wire);
  assert.deepEqual(decoded.columns, ["id", "name"]);
  assert.equal(decoded.rowCount, 2);
  assert.deepEqual(decoded.rowsJson, ['{"id":1}', '{"id":2}']);
  assert.equal(decoded.arrowIpcRows.length, 0);
});

test("decodeQueryResponse: decodes arrow_ipc_rows (field 4, bytes)", () => {
  const body = new Uint8Array([1, 2, 3, 4, 5]);
  const wire = new Uint8Array([(4 << 3) | 2, body.length, ...body]);
  const decoded = decodeQueryResponse(wire);
  assert.deepEqual(Array.from(decoded.arrowIpcRows), Array.from(body));
  assert.equal(decoded.rowsJson.length, 0);
});

test("decodeQueryResponse: empty arrow_ipc_rows means 'read rows_json instead', never zero rows", () => {
  const parts: number[] = [];
  const pushStr = (field: number, s: string): void => {
    const b = new TextEncoder().encode(s);
    parts.push((field << 3) | 2, b.length, ...b);
  };
  parts.push((2 << 3) | 0, 1); // row_count = 1
  pushStr(3, '{"x":1}');
  const decoded = decodeQueryResponse(new Uint8Array(parts));
  assert.equal(decoded.arrowIpcRows.length, 0);
  assert.equal(decoded.rowCount, 1);
  assert.deepEqual(decoded.rowsJson, ['{"x":1}']);
});

test("decodeQueryResponse: tolerates unknown wire types (forward-compat)", () => {
  const wire = new Uint8Array([
    0x28, 0x01, // field 5, varint (unknown, skipped)
    0x35, 0xff, 0xff, 0xff, 0xff, // field 6, fixed32 (unknown, skipped)
    (2 << 3) | 0, 7, // field 2 (row_count) = 7
  ]);
  const decoded = decodeQueryResponse(wire);
  assert.equal(decoded.rowCount, 7);
});

// ---------------------------------------------------------------------------
// RowBatch protobuf codec (ExecuteStream, #4090 follow-up)
// ---------------------------------------------------------------------------

test("decodeRowBatch: decodes columns (1), rows_json (2), done (3, varint bool)", () => {
  // Field layout differs from QueryResponse: rows_json is field 2 here (not
  // 3), and `done` (field 3, varint) has no QueryResponse equivalent.
  const parts: number[] = [];
  const pushStr = (field: number, s: string): void => {
    const b = new TextEncoder().encode(s);
    parts.push((field << 3) | 2, b.length, ...b);
  };
  pushStr(1, "id");
  pushStr(1, "name");
  pushStr(2, '{"id":1}');
  pushStr(2, '{"id":2}');
  parts.push((3 << 3) | 0, 1); // done = true
  const decoded = decodeRowBatch(new Uint8Array(parts));
  assert.deepEqual(decoded.columns, ["id", "name"]);
  assert.deepEqual(decoded.rowsJson, ['{"id":1}', '{"id":2}']);
  assert.equal(decoded.done, true);
  assert.equal(decoded.arrowIpcRows.length, 0);
  // Cross-check (mirrors the Python/Go suites' equivalent pin): the very same
  // bytes through the QueryResponse decoder yield NO rows — RowBatch.rows_json
  // is field 2, QueryResponse's is field 3, so reusing the unary decoder on a
  // streamed frame fails *silently* with zero rows rather than erroring. This
  // asserts the two layouts genuinely differ, so a future refactor can't
  // collapse them without a red test.
  const asResponse = decodeQueryResponse(new Uint8Array(parts));
  assert.deepEqual(asResponse.rowsJson, []);
  assert.equal(asResponse.rowCount, 0);
});

test("decodeRowBatch: decodes arrow_ipc_rows (field 4, bytes); done defaults to false", () => {
  const body = new Uint8Array([9, 8, 7]);
  const wire = new Uint8Array([(4 << 3) | 2, body.length, ...body]);
  const decoded = decodeRowBatch(wire);
  assert.deepEqual(Array.from(decoded.arrowIpcRows), Array.from(body));
  assert.equal(decoded.done, false);
  assert.equal(decoded.rowsJson.length, 0);
});

test("decodeRowBatch: tolerates unknown wire types (forward-compat)", () => {
  const wire = new Uint8Array([
    0x28, 0x01, // field 5, varint (unknown, skipped)
    (3 << 3) | 0, 1, // field 3 (done) = true
  ]);
  const decoded = decodeRowBatch(wire);
  assert.equal(decoded.done, true);
});

// ---------------------------------------------------------------------------
// endpoint helpers
// ---------------------------------------------------------------------------

test("stripGrpcQueryScheme: strips grpc/grpcs/tls/http", () => {
  assert.equal(stripGrpcQueryScheme("grpc://h:50051"), "h:50051");
  assert.equal(stripGrpcQueryScheme("grpcs://h:50051"), "h:50051");
  assert.equal(stripGrpcQueryScheme("tls://h:50051"), "h:50051");
  assert.equal(stripGrpcQueryScheme("http://h:50051"), "h:50051");
  assert.equal(stripGrpcQueryScheme("h:50051"), "h:50051");
});

test("isSecureGrpcQueryEndpoint: grpcs/tls select TLS", () => {
  assert.equal(isSecureGrpcQueryEndpoint("grpc://h:50051"), false);
  assert.equal(isSecureGrpcQueryEndpoint("grpcs://h:50051"), true);
  assert.equal(isSecureGrpcQueryEndpoint("tls://h:50051"), true);
});

// ---------------------------------------------------------------------------
// GrpcQueryTransport.execute — full decode path with a mock gRPC client
// ---------------------------------------------------------------------------

interface Captured {
  target?: string;
  creds?: unknown;
  request?: Uint8Array;
  bearer?: string;
  metadataKeys?: Record<string, string>;
  deadline?: number;
  closed?: boolean;
}

/** @internal Encode a base-128 varint (LEB128) — mirrors grpc-query.ts's internal encoder. */
function testEncodeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

/** @internal Build a `QueryResponse` wire payload from rows_json + columns. */
function encodeQueryResponseJson(columns: string[], rowsJson: string[], rowCount: number): Uint8Array {
  const parts: number[] = [];
  const pushStr = (field: number, s: string): void => {
    const b = new TextEncoder().encode(s);
    parts.push((field << 3) | 2, ...testEncodeVarint(b.length), ...b);
  };
  for (const c of columns) pushStr(1, c);
  parts.push((2 << 3) | 0, ...testEncodeVarint(rowCount));
  for (const r of rowsJson) pushStr(3, r);
  return new Uint8Array(parts);
}

/** @internal Build a `QueryResponse` wire payload carrying `arrow_ipc_rows`. */
function encodeQueryResponseArrow(columns: string[], arrowBytes: Uint8Array, rowCount: number): Uint8Array {
  const parts: number[] = [];
  const pushStr = (field: number, s: string): void => {
    const b = new TextEncoder().encode(s);
    parts.push((field << 3) | 2, ...testEncodeVarint(b.length), ...b);
  };
  for (const c of columns) pushStr(1, c);
  parts.push((2 << 3) | 0, ...testEncodeVarint(rowCount));
  parts.push((4 << 3) | 2, ...testEncodeVarint(arrowBytes.length), ...Array.from(arrowBytes));
  return new Uint8Array(parts);
}

/** @internal Build a fake `GrpcQueryPeerModules` whose unary client answers with `responseBytes`. */
function fakeModules(
  responseBytes: Uint8Array,
  captured: Captured,
  opts?: { error?: GrpcQueryStatus },
): GrpcQueryPeerModules {
  const ClientCtor = function (this: GrpcQueryGrpcClient, target: string, creds: unknown) {
    captured.target = target;
    captured.creds = creds;
    this.Execute = (request, _metadata, options, callback) => {
      captured.request = request;
      captured.deadline = options.deadline;
      setImmediate(() => {
        if (opts?.error) callback(opts.error);
        else callback(null, responseBytes);
      });
      return undefined;
    };
    this.close = () => {
      captured.closed = true;
    };
  } as unknown as { new (target: string, credentials: unknown): GrpcQueryGrpcClient };

  return {
    arrow: {
      tableFromIPC: (b: Uint8Array) =>
        tableFromIPC(b) as unknown as {
          numRows: number;
          schema: { fields: Array<{ name: string }> };
          getChild(name: string): { get(i: number): unknown } | null;
        },
    },
    grpc: {
      Metadata: class {
        set(key: string, value: string) {
          captured.metadataKeys = { ...(captured.metadataKeys ?? {}), [key]: value };
          if (key === "authorization") captured.bearer = value;
        }
      },
      makeGenericClientConstructor: () => ClientCtor,
      credentials: {
        createInsecure: () => ({ _insecure: true }),
        createSsl: () => ({ _ssl: true }),
      },
    },
  };
}

test("GrpcQueryTransport.execute: decodes rows_json response into row objects", async () => {
  const resp = encodeQueryResponseJson(["id", "name"], ['{"id":1,"name":"ada"}', '{"id":2,"name":"bob"}'], 2);
  const captured: Captured = {};
  const transport = new GrpcQueryTransport({ moduleLoader: async () => fakeModules(resp, captured) });

  const result = await transport.execute<{ id: number; name: string }>("grpc://h:50051", "SELECT * FROM Person", {
    bearer: "tok",
  });

  assert.deepEqual(result.columns, ["id", "name"]);
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.rows, [{ id: 1, name: "ada" }, { id: 2, name: "bob" }]);
  assert.equal(captured.closed, true);
});

test("GrpcQueryTransport.execute: decodes arrow_ipc_rows response into the same row-object shape", async () => {
  const tbl = tableFromArrays({ id: [10, 20], label: ["x", "y"] });
  const ipc = tableToIPC(tbl) as Uint8Array;
  const resp = encodeQueryResponseArrow(["id", "label"], ipc, 2);
  const captured: Captured = {};
  const transport = new GrpcQueryTransport({ moduleLoader: async () => fakeModules(resp, captured) });

  const result = await transport.execute<{ id: number; label: string }>("grpc://h:50051", "SELECT * FROM T");

  assert.equal(result.rowCount, 2);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]?.id, 10);
  assert.equal(result.rows[1]?.label, "y");
});

test("GrpcQueryTransport.execute: sends wants_arrow_ipc_rows=true, sql, purpose, bearer metadata", async () => {
  const resp = encodeQueryResponseJson([], [], 0);
  const captured: Captured = {};
  const transport = new GrpcQueryTransport({ moduleLoader: async () => fakeModules(resp, captured) });
  await transport.execute("grpc://h:50051", "SELECT 1", { purpose: "analytics", bearer: "secret" });

  assert.ok(captured.request, "Execute request must be sent");
  // trailing bytes must be the wants_arrow_ipc_rows=true varint field.
  assert.deepEqual(Array.from(captured.request!.subarray(-2)), [0x20, 0x01]);
  assert.equal(captured.bearer, "Bearer secret");
  // "SELECT 1" bytes must appear as a contiguous subsequence (the sql field's payload).
  const wire = Array.from(captured.request!);
  const needle = Array.from(new TextEncoder().encode("SELECT 1"));
  const found = wire.some((_, i) => needle.every((b, j) => wire[i + j] === b));
  assert.ok(found, "encoded request must contain the sql bytes");
});

test("GrpcQueryTransport.execute: omits authorization metadata when no bearer", async () => {
  const resp = encodeQueryResponseJson([], [], 0);
  const captured: Captured = {};
  const transport = new GrpcQueryTransport({ moduleLoader: async () => fakeModules(resp, captured) });
  await transport.execute("grpc://h:50051", "SELECT 1");
  assert.equal(captured.bearer, undefined);
});

test("GrpcQueryTransport.execute: selects TLS creds for grpcs://, insecure otherwise", async () => {
  const capInsecure: Captured = {};
  await new GrpcQueryTransport({ moduleLoader: async () => fakeModules(encodeQueryResponseJson([], [], 0), capInsecure) })
    .execute("grpc://h:50051", "SELECT 1");
  assert.deepEqual(capInsecure.creds, { _insecure: true });

  const capTls: Captured = {};
  await new GrpcQueryTransport({ moduleLoader: async () => fakeModules(encodeQueryResponseJson([], [], 0), capTls) })
    .execute("grpcs://h:50051", "SELECT 1");
  assert.deepEqual(capTls.creds, { _ssl: true });
});

test("GrpcQueryTransport.execute: RPC error rejects with a RelataError", async () => {
  const captured: Captured = {};
  const transport = new GrpcQueryTransport({
    moduleLoader: async () => fakeModules(new Uint8Array(0), captured, { error: { code: 16, details: "bad token" } }),
  });
  await assert.rejects(
    () => transport.execute("grpc://h:50051", "SELECT 1"),
    (err: unknown) => err instanceof RelataError && /bad token/.test((err as RelataError).message),
  );
});

test("createGrpcQueryTransport: surfaces a RelataError with install guidance when peer deps are missing", async () => {
  const guidance =
    "The built-in gRPC query transport requires `apache-arrow` and " +
    "`@grpc/grpc-js`, which are optional peer dependencies of " +
    "@zysec-ai/relata-sdk. Install them with:  npm install apache-arrow " +
    "@grpc/grpc-js   — or pass a custom `transport` to queryGrpc().";
  const transport = createGrpcQueryTransport({
    moduleLoader: async () => {
      throw new RelataError("queryGrpc() needs gRPC peer dependencies", 0, guidance);
    },
  });
  await assert.rejects(
    () => transport.execute("grpc://h:50051", "SELECT 1"),
    (err: unknown) => {
      if (!(err instanceof RelataError)) return false;
      const e = err as RelataError;
      return /apache-arrow/.test(e.serverMessage)
        && /@grpc\/grpc-js/.test(e.serverMessage)
        && /npm install/.test(e.serverMessage);
    },
  );
});

// ---------------------------------------------------------------------------
// GrpcQueryTransport.executeStream — server-streaming decode path (#4090 follow-up)
// ---------------------------------------------------------------------------

/** @internal Build a `RowBatch` wire payload. Field layout: columns=1, rows_json=2, done=3, arrow_ipc_rows=4. */
function encodeRowBatchJson(columns: string[], rowsJson: string[], done: boolean): Uint8Array {
  const parts: number[] = [];
  const pushStr = (field: number, s: string): void => {
    const b = new TextEncoder().encode(s);
    parts.push((field << 3) | 2, ...testEncodeVarint(b.length), ...b);
  };
  for (const c of columns) pushStr(1, c);
  for (const r of rowsJson) pushStr(2, r);
  if (done) parts.push((3 << 3) | 0, 1);
  return new Uint8Array(parts);
}

/** @internal Build a `RowBatch` wire payload carrying `arrow_ipc_rows`. */
function encodeRowBatchArrow(columns: string[], arrowBytes: Uint8Array, done: boolean): Uint8Array {
  const parts: number[] = [];
  const pushStr = (field: number, s: string): void => {
    const b = new TextEncoder().encode(s);
    parts.push((field << 3) | 2, ...testEncodeVarint(b.length), ...b);
  };
  for (const c of columns) pushStr(1, c);
  parts.push((4 << 3) | 2, ...testEncodeVarint(arrowBytes.length), ...Array.from(arrowBytes));
  if (done) parts.push((3 << 3) | 0, 1);
  return new Uint8Array(parts);
}

/**
 * @internal Minimal grpc-js-style server-streaming EventEmitter fake —
 * mirrors `flight.test.ts`'s `makeMockStream` (same shape as a real
 * `@grpc/grpc-js` `ClientReadableStream`, cast at the boundary since the
 * narrow `GrpcQueryGrpcStream` interface's per-event overloads don't unify
 * into a single assignable listener-callback type).
 */
function makeMockQueryStream(frames: Uint8Array[], opts?: { error?: GrpcQueryStatus; omitEnd?: boolean }): GrpcQueryGrpcStream {
  const dataLs: Array<(c: Uint8Array) => void> = [];
  const endLs: Array<() => void> = [];
  const errLs: Array<(e: unknown) => void> = [];
  const statusLs: Array<(s: GrpcQueryStatus) => void> = [];
  setImmediate(() => {
    if (opts?.error) {
      for (const l of errLs) l(opts.error);
      return;
    }
    for (const f of frames) for (const l of dataLs) l(f);
    if (!opts?.omitEnd) {
      for (const l of statusLs) l({ code: 0, details: "" });
      for (const l of endLs) l();
    }
  });
  return {
    on(event: string, listener: (...a: never[]) => void): unknown {
      if (event === "data") dataLs.push(listener as (c: Uint8Array) => void);
      else if (event === "end") endLs.push(listener as () => void);
      else if (event === "error") errLs.push(listener as (e: unknown) => void);
      else if (event === "status") statusLs.push(listener as (s: GrpcQueryStatus) => void);
      return undefined;
    },
  } as unknown as GrpcQueryGrpcStream;
}

/** @internal Build a fake `GrpcQueryPeerModules` whose `ExecuteStream` emits `frames` then completes. */
function fakeStreamModules(
  frames: Uint8Array[],
  captured: Captured,
  opts?: { error?: GrpcQueryStatus; omitEnd?: boolean },
): GrpcQueryPeerModules {
  const ClientCtor = function (this: GrpcQueryGrpcClient, target: string, creds: unknown) {
    captured.target = target;
    captured.creds = creds;
    this.ExecuteStream = (request, _metadata, options) => {
      captured.request = request;
      captured.deadline = options.deadline;
      return makeMockQueryStream(frames, opts);
    };
    this.close = () => {
      captured.closed = true;
    };
  } as unknown as { new (target: string, credentials: unknown): GrpcQueryGrpcClient };

  return {
    arrow: {
      tableFromIPC: (b: Uint8Array) =>
        tableFromIPC(b) as unknown as {
          numRows: number;
          schema: { fields: Array<{ name: string }> };
          getChild(name: string): { get(i: number): unknown } | null;
        },
    },
    grpc: {
      Metadata: class {
        set(key: string, value: string) {
          captured.metadataKeys = { ...(captured.metadataKeys ?? {}), [key]: value };
          if (key === "authorization") captured.bearer = value;
        }
      },
      makeGenericClientConstructor: () => ClientCtor,
      credentials: {
        createInsecure: () => ({ _insecure: true }),
        createSsl: () => ({ _ssl: true }),
      },
    },
  };
}

test("GrpcQueryTransport.executeStream: accumulates rows_json across multiple RowBatch frames", async () => {
  const frames = [
    encodeRowBatchJson(["id", "name"], ['{"id":1,"name":"ada"}'], false),
    encodeRowBatchJson(["id", "name"], ['{"id":2,"name":"bob"}'], true),
  ];
  const captured: Captured = {};
  const transport = new GrpcQueryTransport({ moduleLoader: async () => fakeStreamModules(frames, captured) });

  const result = await transport.executeStream<{ id: number; name: string }>(
    "grpc://h:50051",
    "SELECT * FROM Person",
    { bearer: "tok" },
  );

  assert.deepEqual(result.columns, ["id", "name"]);
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.rows, [{ id: 1, name: "ada" }, { id: 2, name: "bob" }]);
  assert.equal(captured.closed, true);
});

test("GrpcQueryTransport.executeStream: decodes arrow_ipc_rows per frame into the same row-object shape", async () => {
  const tbl = tableFromArrays({ id: [10, 20], label: ["x", "y"] });
  const ipc = tableToIPC(tbl) as Uint8Array;
  const frames = [encodeRowBatchArrow(["id", "label"], ipc, true)];
  const captured: Captured = {};
  const transport = new GrpcQueryTransport({ moduleLoader: async () => fakeStreamModules(frames, captured) });

  const result = await transport.executeStream<{ id: number; label: string }>("grpc://h:50051", "SELECT * FROM T");

  assert.equal(result.rowCount, 2);
  assert.equal(result.rows[0]?.id, 10);
  assert.equal(result.rows[1]?.label, "y");
});

test("GrpcQueryTransport.executeStream: an empty terminal frame after data frames contributes no extra rows", async () => {
  const frames = [
    encodeRowBatchJson(["id"], ['{"id":1}'], false),
    encodeRowBatchJson(["id"], [], true), // empty terminator, done=true, no rows
  ];
  const captured: Captured = {};
  const transport = new GrpcQueryTransport({ moduleLoader: async () => fakeStreamModules(frames, captured) });
  const result = await transport.executeStream<{ id: number }>("grpc://h:50051", "SELECT * FROM T");
  assert.equal(result.rowCount, 1);
  assert.deepEqual(result.rows, [{ id: 1 }]);
});

test("GrpcQueryTransport.executeStream: sends wants_arrow_ipc_rows=true on the ExecuteStream request", async () => {
  const captured: Captured = {};
  const transport = new GrpcQueryTransport({
    moduleLoader: async () => fakeStreamModules([encodeRowBatchJson([], [], true)], captured),
  });
  await transport.executeStream("grpc://h:50051", "SELECT 1", { purpose: "analytics", bearer: "secret" });

  assert.ok(captured.request, "ExecuteStream request must be sent");
  assert.deepEqual(Array.from(captured.request!.subarray(-2)), [0x20, 0x01]);
  assert.equal(captured.bearer, "Bearer secret");
});

test("GrpcQueryTransport.executeStream: stream error rejects with a RelataError", async () => {
  const captured: Captured = {};
  const transport = new GrpcQueryTransport({
    moduleLoader: async () =>
      fakeStreamModules([], captured, { error: { code: 16, details: "bad token" } }),
  });
  await assert.rejects(
    () => transport.executeStream("grpc://h:50051", "SELECT 1"),
    (err: unknown) => err instanceof RelataError && /bad token/.test((err as RelataError).message),
  );
});

test("GrpcQueryTransport.executeStream: closes the client after the stream ends", async () => {
  const captured: Captured = {};
  const transport = new GrpcQueryTransport({
    moduleLoader: async () => fakeStreamModules([encodeRowBatchJson([], [], true)], captured),
  });
  await transport.executeStream("grpc://h:50051", "SELECT 1");
  assert.equal(captured.closed, true);
});
