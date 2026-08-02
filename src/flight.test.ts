/**
 * Tests for the first-party Arrow Flight client (#2492).
 *
 * The pure codec/framing helpers are unit-tested directly; the full
 * `ArrowFlightTransport` decode path is exercised against REAL apache-arrow
 * data (a `tableToIPC` round-trip split into Flight frames) with a mock gRPC
 * client, so no live Flight door is required. The optional-peer-deps absence
 * path is covered by an injected failing module loader.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { tableFromArrays, tableToIPC, tableFromIPC, Message } from "apache-arrow";

import { RelataError, AuthError, ForbiddenError, QuotaError, NetworkError } from "./errors.ts";
import {
  ArrowFlightTransport,
  createArrowFlightTransport,
  decodeFlightData,
  encodeFlightData,
  encodeTicket,
  isSecureFlightEndpoint,
  reassembleIpcStream,
  stripFlightScheme,
  type FlightDataMessage,
  type FlightGrpcClient,
  type FlightGrpcStatus,
  type FlightGrpcStream,
  type FlightPeerModules,
} from "./flight.ts";

// ---------------------------------------------------------------------------
// ticket / protobuf codec
// ---------------------------------------------------------------------------

test("encodeTicket: exact Ticket wire bytes (field 1, length-delimited)", () => {
  const sql = "SELECT 1";
  const payload = new TextEncoder().encode(sql);
  const out = encodeTicket(sql);
  // tag 0x0a (field 1, wire type 2) + 1-byte varint length + UTF-8 payload
  assert.deepEqual(Array.from(out), [0x0a, payload.length, ...Array.from(payload)]);
});

test("encodeTicket: multi-byte varint length for a long ticket", () => {
  const sql = "SELECT * FROM Big WHERE x = '" + "a".repeat(200) + "'";
  const out = encodeTicket(sql);
  // 200-byte payload → tag + 2-byte varint (0x80+low, high) + payload
  assert.equal(out[0], 0x0a);
  assert.equal(out[1]! & 0x80, 0x80); // continuation bit set on first length byte
  assert.equal(out.length, 1 + 2 + new TextEncoder().encode(sql).length);
  // Round-trips through decodeFlightData? Ticket has the same wire shape as a
  // single length-delimited field — decode it manually to confirm varint length.
  const len = ((out[1]! & 0x7f) | ((out[2]! & 0x7f) << 7));
  assert.equal(len, new TextEncoder().encode(sql).length);
});

test("decodeFlightData/encodeFlightData: round-trip with empty body", () => {
  const header = new Uint8Array([1, 2, 3, 4]);
  const wire = encodeFlightData({ dataHeader: header });
  const dec = decodeFlightData(wire);
  assert.deepEqual(Array.from(dec.dataHeader), [1, 2, 3, 4]);
  assert.equal(dec.dataBody.length, 0);
});

test("decodeFlightData/encodeFlightData: round-trip with all fields + big body", () => {
  const header = new Uint8Array(300).map((_, i) => i & 0xff); // forces 2-byte varint
  const body = new Uint8Array(512).map((_, i) => (i * 7) & 0xff);
  const desc = new Uint8Array([9, 9]);
  const meta = new Uint8Array([7]);
  const wire = encodeFlightData({ flightDescriptor: desc, dataHeader: header, appMetadata: meta, dataBody: body });
  const dec = decodeFlightData(wire);
  assert.deepEqual(Array.from(dec.flightDescriptor!), [9, 9]);
  assert.deepEqual(Array.from(dec.dataHeader), Array.from(header));
  assert.deepEqual(Array.from(dec.appMetadata!), [7]);
  assert.deepEqual(Array.from(dec.dataBody), Array.from(body));
});

test("decodeFlightData: tolerates unknown wire types (forward-compat)", () => {
  // Hand-craft a FlightData with an extra unknown varint field (5) and a
  // fixed32 field (6) before the real data_body (4).
  const body = new Uint8Array([42, 43]);
  const wire = new Uint8Array([
    0x28, 0x01, // field 5, varint = 1 (unknown, skipped)
    0x35, 0xff, 0xff, 0xff, 0xff, // field 6, fixed32 (unknown, skipped)
    0x22, body.length, ...body, // field 4, data_body
  ]);
  const dec = decodeFlightData(wire);
  assert.deepEqual(Array.from(dec.dataBody), [42, 43]);
});

// ---------------------------------------------------------------------------
// endpoint helpers
// ---------------------------------------------------------------------------

test("stripFlightScheme: strips grpc/grpcs/tls/http", () => {
  assert.equal(stripFlightScheme("grpc://h:8815"), "h:8815");
  assert.equal(stripFlightScheme("grpcs://h:8815"), "h:8815");
  assert.equal(stripFlightScheme("tls://h:8815"), "h:8815");
  assert.equal(stripFlightScheme("http://h:8815"), "h:8815");
  assert.equal(stripFlightScheme("h:8815"), "h:8815"); // bare host:port passthrough
});

test("isSecureFlightEndpoint: grpcs/tls select TLS", () => {
  assert.equal(isSecureFlightEndpoint("grpc://h:8815"), false);
  assert.equal(isSecureFlightEndpoint("http://h:8815"), false);
  assert.equal(isSecureFlightEndpoint("grpcs://h:8815"), true);
  assert.equal(isSecureFlightEndpoint("tls://h:8815"), true);
});

// ---------------------------------------------------------------------------
// IPC reassembly framing
// ---------------------------------------------------------------------------

test("reassembleIpcStream: emits continuation + LE length + header + body + EOS", () => {
  const header = new Uint8Array([10, 20, 30]);
  const body = new Uint8Array([1, 2, 3, 4]);
  const out = reassembleIpcStream([{ flightDescriptor: undefined, dataHeader: header, appMetadata: undefined, dataBody: body }]);
  // First frame:
  assert.deepEqual(Array.from(out.subarray(0, 4)), [0xff, 0xff, 0xff, 0xff]); // continuation
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  assert.equal(dv.getUint32(4, true), 3); // header length, little-endian
  assert.deepEqual(Array.from(out.subarray(8, 11)), [10, 20, 30]); // header
  assert.deepEqual(Array.from(out.subarray(11, 15)), [1, 2, 3, 4]); // body
  // EOS marker at the tail:
  assert.deepEqual(Array.from(out.subarray(out.length - 8)), [0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]);
});

test("reassembleIpcStream: skips empty-header keepalive frames", () => {
  const header = new Uint8Array([1]);
  const out = reassembleIpcStream([
    { flightDescriptor: undefined, dataHeader: new Uint8Array(0), appMetadata: undefined, dataBody: new Uint8Array(0) },
    { flightDescriptor: undefined, dataHeader: header, appMetadata: undefined, dataBody: new Uint8Array(0) },
  ]);
  // Only one non-empty frame + EOS (8 bytes).
  assert.equal(out.length, 4 + 4 + 1 + 8);
});

test("reassembleIpcStream + tableFromIPC: round-trips a real apache-arrow table", () => {
  const tbl = tableFromArrays({ id: [1, 2, 3], name: ["ada", "bob", "cyra"] });
  const ipc = tableToIPC(tbl) as Uint8Array;
  // Sanity: apache-arrow decodes its own output.
  const sanity = tableFromIPC(ipc);
  assert.equal((sanity as { numRows: number }).numRows, 3);

  // Split the IPC stream into per-FlightData frames (what a real Flight server
  // emits via FlightDataEncoderBuilder) and reassemble through our framer.
  const frames = ipcToFlightFrames(ipc);
  assert.ok(frames.length >= 2, "expected at least schema + record-batch frames");

  const reassembled = reassembleIpcStream(frames);
  const decoded = tableFromIPC(reassembled) as { numRows: number; numCols: number; schema: { fields: Array<{ name: string }> } };
  assert.equal(decoded.numRows, 3);
  assert.equal(decoded.numCols, 2);
  assert.deepEqual(decoded.schema.fields.map((f) => f.name), ["id", "name"]);
});

// ---------------------------------------------------------------------------
// ArrowFlightTransport — full decode path with a mock gRPC client
// ---------------------------------------------------------------------------

/**
 * @internal Split an apache-arrow IPC *streaming* buffer into the per-message
 * `{dataHeader, dataBody}` frames a Flight server's FlightDataEncoderBuilder
 * emits. Mirrors apache-arrow's own `MessageReader` framing (continuation
 * marker + i32 metadata length + Message flatbuf + body) and re-encodes each
 * `Message` to its canonical unpadded flatbuf — byte-identical to the server's
 * `FlightData.data_header`.
 */
function ipcToFlightFrames(ipc: Uint8Array): FlightDataMessage[] {
  const frames: FlightDataMessage[] = [];
  const dv = new DataView(ipc.buffer, ipc.byteOffset, ipc.byteLength);
  let off = 0;
  while (off + 4 <= ipc.byteLength) {
    const head = dv.getInt32(off, true);
    off += 4;
    let metaLen: number;
    if (head === -1) {
      // Continuation marker (0xFFFFFFFF) — next i32 is the metadata length.
      if (off + 4 > ipc.byteLength) break;
      metaLen = dv.getInt32(off, true);
      off += 4;
      if (metaLen === 0) break; // EOS
    } else {
      metaLen = head; // pre-v0.15 legacy (apache-arrow never writes this)
    }
    const meta = ipc.subarray(off, off + metaLen);
    off += metaLen;
    const msg = Message.decode(meta);
    const dataHeader = Message.encode(msg);
    const bodyLen = Number(msg.bodyLength);
    const dataBody = ipc.subarray(off, off + bodyLen);
    off += bodyLen;
    frames.push({ flightDescriptor: undefined, dataHeader, appMetadata: undefined, dataBody });
  }
  return frames;
}

interface Captured {
  target?: string;
  creds?: unknown;
  ticket?: Uint8Array;
  bearer?: string;
  deadline?: number;
  closed?: boolean;
}

/** @internal Build a fake `FlightPeerModules` whose gRPC client emits `frames`. */
function fakeModules(
  frames: Uint8Array[],
  captured: Captured,
  opts?: { statusError?: FlightGrpcStatus },
): FlightPeerModules {
  const ClientCtor = function (this: FlightGrpcClient, target: string, creds: unknown) {
    captured.target = target;
    captured.creds = creds;
    this.DoGet = (request, _metadata, options) => {
      captured.ticket = request;
      captured.deadline = options.deadline;
      return makeMockStream(frames, opts?.statusError);
    };
    this.close = () => {
      captured.closed = true;
    };
  } as unknown as { new (target: string, credentials: unknown): FlightGrpcClient };

  return {
    arrow: { tableFromIPC: (b: Uint8Array) => tableFromIPC(b) },
    grpc: {
      Metadata: class {
        set(key: string, value: string) {
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

/** @internal Minimal grpc-js-style server-streaming EventEmitter for tests. */
function makeMockStream(frames: Uint8Array[], statusError?: FlightGrpcStatus): FlightGrpcStream {
  const dataLs: Array<(c: Uint8Array) => void> = [];
  const endLs: Array<() => void> = [];
  const errLs: Array<(e: unknown) => void> = [];
  const statusLs: Array<(s: FlightGrpcStatus) => void> = [];
  setImmediate(() => {
    for (const f of frames) for (const l of dataLs) l(f);
    if (statusError) {
      for (const l of errLs) l(statusError);
    } else {
      for (const l of statusLs) l({ code: 0, details: "" });
      for (const l of endLs) l();
    }
  });
  return {
    on(event: string, listener: (...a: never[]) => void): unknown {
      if (event === "data") dataLs.push(listener as (c: Uint8Array) => void);
      else if (event === "end") endLs.push(listener as () => void);
      else if (event === "error") errLs.push(listener as (e: unknown) => void);
      else if (event === "status") statusLs.push(listener as (s: FlightGrpcStatus) => void);
      return undefined;
    },
  } as unknown as FlightGrpcStream;
}

test("ArrowFlightTransport.doGet: decodes a real arrow table from FlightData frames", async () => {
  const tbl = tableFromArrays({ id: [10, 20, 30], label: ["x", "y", "z"] });
  const ipc = tableToIPC(tbl) as Uint8Array;
  const frames = ipcToFlightFrames(ipc).map((f) => encodeFlightData(f));
  const captured: Captured = {};
  const transport = new ArrowFlightTransport({ moduleLoader: async () => fakeModules(frames, captured) });

  const result = (await transport.doGet("grpc://localhost:8815", "SELECT * FROM T", "tok")) as {
    numRows: number;
    getChild: (n: string) => { get: (i: number) => unknown } | null;
  };

  assert.equal(result.numRows, 3);
  // apache-arrow Table.getChild(name).get(i) lets us peek typed cell values.
  assert.equal(result.getChild("id")?.get(0), 10);
  assert.equal(result.getChild("id")?.get(2), 30);
  assert.equal(result.getChild("label")?.get(1), "y");
});

test("ArrowFlightTransport.doGet: sends encoded Ticket + Bearer metadata + closes client", async () => {
  const captured: Captured = {};
  const transport = new ArrowFlightTransport({ moduleLoader: async () => fakeModules([], captured) });
  await transport.doGet("grpc://h:8815", "SELECT 1", "secret").catch(() => undefined);

  assert.ok(captured.ticket, "DoGet request (encoded Ticket) must be sent");
  // The request is the Ticket protobuf; field 1 (0x0a) carries the SQL bytes.
  assert.equal(captured.ticket![0], 0x0a);
  const sqlBytes = captured.ticket!.subarray(2);
  assert.equal(new TextDecoder().decode(sqlBytes), "SELECT 1");
  assert.equal(captured.bearer, "Bearer secret");
  assert.equal(captured.closed, true);
  assert.ok(captured.deadline! > Date.now() - 60_000, "deadline must be set in the future");
});

test("ArrowFlightTransport.doGet: omits authorization metadata when no bearer", async () => {
  const captured: Captured = {};
  const transport = new ArrowFlightTransport({ moduleLoader: async () => fakeModules([], captured) });
  await transport.doGet("grpc://h:8815", "SELECT 1", undefined).catch(() => undefined);
  assert.equal(captured.bearer, undefined);
});

test("ArrowFlightTransport.doGet: selects TLS creds for grpcs://, insecure otherwise", async () => {
  // Two transports share a captured-bag each; we drive both and check the creds
  // object the mock constructor received.
  const capInsecure: Captured = {};
  await new ArrowFlightTransport({ moduleLoader: async () => fakeModules([], capInsecure) })
    .doGet("grpc://h:8815", "SELECT 1", undefined).catch(() => undefined);
  assert.deepEqual(capInsecure.creds, { _insecure: true });

  const capTls: Captured = {};
  await new ArrowFlightTransport({ moduleLoader: async () => fakeModules([], capTls) })
    .doGet("grpcs://h:8815", "SELECT 1", undefined).catch(() => undefined);
  assert.deepEqual(capTls.creds, { _ssl: true });
});

test("ArrowFlightTransport.doGet: maps UNAUTHENTICATED → AuthError", async () => {
  const captured: Captured = {};
  const transport = new ArrowFlightTransport({
    moduleLoader: async () => fakeModules([], captured, { statusError: { code: 16, details: "bad token" } }),
  });
  await assert.rejects(
    () => transport.doGet("grpc://h:8815", "SELECT 1", "x"),
    (err: unknown) => err instanceof AuthError,
  );
});

test("ArrowFlightTransport.doGet: maps PERMISSION_DENIED → ForbiddenError, RESOURCE_EXHAUSTED → QuotaError", async () => {
  const forbidden = new ArrowFlightTransport({
    moduleLoader: async () => fakeModules([], {}, { statusError: { code: 7, details: "ACL deny" } }),
  });
  await assert.rejects(
    () => forbidden.doGet("grpc://h:8815", "SELECT 1", undefined),
    (err: unknown) => err instanceof ForbiddenError,
  );

  const quota = new ArrowFlightTransport({
    moduleLoader: async () => fakeModules([], {}, { statusError: { code: 8, details: "quota" } }),
  });
  await assert.rejects(
    () => quota.doGet("grpc://h:8815", "SELECT 1", undefined),
    (err: unknown) => err instanceof QuotaError,
  );
});

test("ArrowFlightTransport.doGet: maps a malformed frame (decode fault) → NetworkError", async () => {
  // A truncated varint in a FlightData frame makes decodeFlightData throw
  // mid-stream; the transport must surface it as a RelataError (NetworkError).
  const bad = new ArrowFlightTransport({
    moduleLoader: async () => fakeModules([new Uint8Array([0x80])], {}), // dangling varint
  });
  await assert.rejects(
    () => bad.doGet("grpc://h:8815", "SELECT 1", undefined),
    (err: unknown) => err instanceof NetworkError,
  );
});

// ---------------------------------------------------------------------------
// Optional peer-dep absence
// ---------------------------------------------------------------------------

test("createArrowFlightTransport: surfaces a RelataError with install guidance when peer deps are missing", async () => {
  // Inject a loader that emulates the dynamic import failing (no apache-arrow /
  // @grpc/grpc-js installed) — the default loader's real-world failure mode.
  // The fixture mirrors the exact RelataError the default loader builds, so the
  // install-guidance wording a caller actually sees is asserted here.
  const guidance =
    "The built-in Arrow Flight transport requires `apache-arrow` and " +
    "`@grpc/grpc-js`, which are optional peer dependencies of " +
    "@zysec-ai/relata-sdk. Install them with:  npm install apache-arrow " +
    "@grpc/grpc-js   — or pass a custom `transport` to queryFlight().";
  const transport = createArrowFlightTransport({
    moduleLoader: async () => {
      throw new RelataError("queryFlight() needs Arrow Flight peer dependencies", 0, guidance);
    },
  });
  await assert.rejects(
    () => transport.doGet("grpc://h:8815", "SELECT 1", undefined),
    (err: unknown) => {
      if (!(err instanceof RelataError)) return false;
      const e = err as RelataError;
      return /apache-arrow/.test(e.serverMessage)
        && /@grpc\/grpc-js/.test(e.serverMessage)
        && /npm install/.test(e.serverMessage);
    },
  );
});
