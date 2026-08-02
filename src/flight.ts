/**
 * First-party Arrow Flight client for the TypeScript SDK (#2492).
 *
 * The Python, Go, and Rust SDKs each ship a native Arrow Flight `do_get`
 * client (pyarrow.flight / arrow/go/v15/arrow/flight / relata-sdk-rust's
 * `query_flight`). The TS SDK previously threw unless the caller supplied a
 * `transport` adapter, because there is no canonical, maintained JS Arrow
 * Flight client (apache-arrow ships the columnar format + IPC codecs but no
 * gRPC Flight transport, and every third-party "arrow-flight-client" package
 * on npm is an unmaintained 0.0.x/alpha experiment — see the investigation
 * notes in the PR for #2492).
 *
 * This module closes that gap with a first-party `ArrowFlightTransport`:
 * `queryFlight()` now works out of the box, with zero caller wiring. It opens
 * a real gRPC Flight `do_get` to the server's Flight door
 * (`crates/relata-cli/src/flight_server.rs::do_get`), sends the SQL ticket,
 * and decodes the streamed `FlightData` frames back into an `apache-arrow`
 * `Table` — byte-for-byte the same path the Go SDK's `queryFlightDoGet` walks.
 *
 * The heavy transport deps — `apache-arrow` (IPC decode) and `@grpc/grpc-js`
 * (gRPC) — are **optional peer dependencies**: they are dynamically imported
 * on first use, so importing the SDK never pulls them in, and apps that never
 * call `queryFlight()` pay no cost. If the peers are absent when `queryFlight()`
 * is invoked without a caller-supplied `transport`, a clear `RelataError` with
 * install guidance is thrown. Callers that already operate their own Arrow
 * Flight stack can still pass a custom `transport` to `queryFlight()` exactly
 * as before (#2253).
 *
 * Only two protobuf messages are exchanged on the wire for `do_get`:
 * `Ticket { bytes ticket = 1 }` (request) and `FlightData { FlightDescriptor
 * flight_descriptor = 1; bytes data_header = 2; bytes app_metadata = 3; bytes
 * data_body = 4 }` (response stream). Both are trivial on the wire, so this
 * module hand-rolls their encode/decode (LEB128 varints + length-delimited
 * fields) instead of pulling in `@grpc/proto-loader` + a `.proto` asset — the
 * same minimalism as a one-shot `grpcurl`. The gRPC service is bound via
 * `@grpc/grpc-js`'s `makeGenericClientConstructor` with raw-buffer
 * (de)serialization, so the Flight client is a pure `grpc-js` + `apache-arrow`
 * composition.
 *
 * Browser / edge runtimes: gRPC is Node-only, so the built-in transport is
 * Node-only. Browser/Cloudflare Workers callers must still supply their own
 * `transport` (e.g. built on grpc-web).
 *
 * @module
 */

import {
  AuthError,
  BadRequestError,
  ForbiddenError,
  NetworkError,
  QuotaError,
  RelataError,
  TimeoutError,
} from "./errors.ts";

// ---------------------------------------------------------------------------
// Flight endpoint helpers (mirrors sdks/go/relata/flight.go + client.ts)
// ---------------------------------------------------------------------------

/**
 * Report whether `endpoint` requests a TLS-protected Arrow Flight connection
 * (#2362). The `grpcs://` / `tls://` schemes select TLS; `grpc://` (and the
 * legacy bare `http://` form) remain plaintext — mirroring the Go SDK's
 * `isSecureFlightEndpoint`. TLS matters here because the Flight bearer token
 * travels as gRPC `authorization` metadata over whatever transport is selected.
 */
export function isSecureFlightEndpoint(endpoint: string): boolean {
  return endpoint.startsWith("grpcs://") || endpoint.startsWith("tls://");
}

/**
 * Strip the scheme prefix from a Flight endpoint, leaving the bare `host:port`
 * that `@grpc/grpc-js`'s `Client` target wants. Accepts `grpc://`, `grpcs://`,
 * `tls://`, and the legacy `http://` form. Mirrors Go's `stripFlightScheme`.
 */
export function stripFlightScheme(endpoint: string): string {
  for (const prefix of ["grpcs://", "grpc://", "tls://", "http://"]) {
    if (endpoint.startsWith(prefix)) return endpoint.slice(prefix.length);
  }
  return endpoint;
}

// ---------------------------------------------------------------------------
// Minimal protobuf codec for Ticket + FlightData (#2492)
// ---------------------------------------------------------------------------
//
// Arrow Flight's `do_get` exchanges exactly two protobuf messages:
//
//   message Ticket         { bytes ticket = 1; }
//   message FlightData {
//     FlightDescriptor flight_descriptor = 1;
//     bytes              data_header     = 2; // IPC Message flatbuf
//     bytes              app_metadata    = 3;
//     bytes              data_body       = 4; // RecordBatch body buffers
//   }
//
// Both are length-delimited (protobuf wire type 2). Encoding/decoding them by
// hand keeps the Flight client a pure `grpc-js` + `apache-arrow` composition:
// no `@grpc/proto-loader`, no bundled `.proto` asset, no `protobufjs`.

/** Encode a non-negative integer as a base-128 varint (LEB128). @internal */
function encodeVarint(n: number): number[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`varint must be a non-negative integer, got ${n}`);
  }
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

/** @internal Result of {@link readVarint}. */
interface VarintRead {
  /** Decoded unsigned value. */
  value: number;
  /** Offset of the first byte AFTER the varint. */
  next: number;
}

/** Decode a base-128 varint at `offset`. @internal */
function readVarint(buf: Uint8Array, offset: number): VarintRead {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i]!;
    i += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, next: i };
    }
    shift += 7;
    if (shift > 35) {
      throw new Error("protobuf varint overflow (>32 bits) — corrupt Flight frame");
    }
  }
  throw new Error("truncated protobuf varint — short Flight frame");
}

/**
 * Encode an Arrow Flight `Ticket` (`{ bytes ticket = 1 }`) as the on-wire
 * request body for `FlightService/DoGet`. `ticketSql` is the raw UTF-8 SQL,
 * optionally already prefixed with a leading `PURPOSE '<id>'` SQL comment by
 * {@link buildFlightTicket}. @internal exported for testing.
 */
export function encodeTicket(ticketSql: string): Uint8Array {
  const payload = new TextEncoder().encode(ticketSql);
  const tag = 0x0a; // field 1, wire type 2 (length-delimited)
  const lenBytes = encodeVarint(payload.length);
  const out = new Uint8Array(1 + lenBytes.length + payload.length);
  out[0] = tag;
  out.set(lenBytes, 1);
  out.set(payload, 1 + lenBytes.length);
  return out;
}

/** @internal Decoded `FlightData` frame. */
export interface FlightDataMessage {
  /** `FlightDescriptor` flatbuf bytes (field 1), when present. */
  readonly flightDescriptor: Uint8Array | undefined;
  /** IPC `Message` flatbuf (field 2) — a Schema or RecordBatch message. */
  readonly dataHeader: Uint8Array;
  /** Application metadata (field 3), when present. */
  readonly appMetadata: Uint8Array | undefined;
  /** RecordBatch body buffers (field 4), when present. */
  readonly dataBody: Uint8Array;
}

/**
 * Decode an Arrow Flight `FlightData` protobuf into its four fields. Only the
 * length-delimited fields the transport needs (`data_header`, `data_body`) are
 * materialised; unexpected wire types are skipped per the protobuf spec, so the
 * decoder is forward-compatible with future Flight fields. @internal exported
 * for testing.
 */
export function decodeFlightData(buf: Uint8Array): FlightDataMessage {
  let i = 0;
  let flightDescriptor: Uint8Array | undefined;
  let dataHeader: Uint8Array = new Uint8Array(0);
  let appMetadata: Uint8Array | undefined;
  let dataBody: Uint8Array = new Uint8Array(0);
  while (i < buf.length) {
    const tagRead = readVarint(buf, i);
    i = tagRead.next;
    const fieldNumber = tagRead.value >>> 3;
    const wireType = tagRead.value & 0x07;
    if (wireType === 2) {
      const lenRead = readVarint(buf, i);
      i = lenRead.next;
      const seg = buf.subarray(i, i + lenRead.value);
      i += lenRead.value;
      switch (fieldNumber) {
        case 1: flightDescriptor = seg; break;
        case 2: dataHeader = seg; break;
        case 3: appMetadata = seg; break;
        case 4: dataBody = seg; break;
      }
    } else if (wireType === 0) {
      i = readVarint(buf, i).next;
    } else if (wireType === 1) {
      i += 8;
    } else if (wireType === 5) {
      i += 4;
    } else {
      break; // unknown wire type — stop (FlightData never uses groups)
    }
  }
  return { flightDescriptor, dataHeader, appMetadata, dataBody };
}

/**
 * Encode a `FlightData` protobuf from its constituent fields — the inverse of
 * {@link decodeFlightData}. Used by tests to fabricate realistic frames from
 * real apache-arrow IPC output. @internal exported for testing.
 */
export function encodeFlightData(msg: {
  flightDescriptor?: Uint8Array | undefined;
  dataHeader: Uint8Array;
  appMetadata?: Uint8Array | undefined;
  dataBody?: Uint8Array | undefined;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  const writeLengthDelimited = (field: number, payload: Uint8Array): void => {
    parts.push(new Uint8Array([(field << 3) | 2]), new Uint8Array(encodeVarint(payload.length)), payload);
  };
  if (msg.flightDescriptor && msg.flightDescriptor.length > 0) {
    writeLengthDelimited(1, msg.flightDescriptor);
  }
  writeLengthDelimited(2, msg.dataHeader);
  if (msg.appMetadata && msg.appMetadata.length > 0) writeLengthDelimited(3, msg.appMetadata);
  if (msg.dataBody && msg.dataBody.length > 0) writeLengthDelimited(4, msg.dataBody);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// IPC stream reassembly (#2492)
// ---------------------------------------------------------------------------
//
// Each `FlightData` carries one IPC `Message` flatbuf (`data_header`) plus the
// record-batch body (`data_body`). An Arrow IPC *streaming* frame is:
//
//   <continuation 0xFFFFFFFF><u32 LE metadata_length><metadata><body>
//
// so reassembling a Flight stream into a buffer apache-arrow's
// `RecordBatchStreamReader` (via `tableFromIPC`) can consume is just: emit one
// such frame per `FlightData`, then the 8-byte EOS marker. This is byte-for-byte
// what sdks/go/relata/flight.go::writeIPCFrame does — proven wire-compatible
// with `crates/relata-cli/src/flight_server.rs`'s `FlightDataEncoderBuilder`
// output.

/**
 * Reassemble a sequence of decoded `FlightData` frames into a single Arrow IPC
 * streaming buffer that `apache-arrow`'s `tableFromIPC` / `RecordBatchStreamReader`
 * can decode. Frames with an empty `dataHeader` (pure-metadata keepalives) are
 * skipped, and the stream is terminated with the canonical EOS marker
 * (`0xFFFFFFFF` + `0x00000000`). @internal exported for testing.
 */
export function reassembleIpcStream(frames: Iterable<FlightDataMessage>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const continuation = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  for (const frame of frames) {
    if (frame.dataHeader.length === 0) continue;
    const lenView = new DataView(new ArrayBuffer(4));
    lenView.setUint32(0, frame.dataHeader.length, true);
    chunks.push(continuation, new Uint8Array(lenView.buffer), frame.dataHeader);
    if (frame.dataBody.length > 0) chunks.push(frame.dataBody);
  }
  // EOS marker: continuation + zero-length metadata.
  chunks.push(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]));
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Optional peer-dep loading (apache-arrow + @grpc/grpc-js)
// ---------------------------------------------------------------------------

/**
 * @internal Structural shape of the two optional peer modules the transport
 * uses. Kept as a narrow, local interface so the emitted `.d.ts` never
 * references `apache-arrow` / `@grpc/grpc-js` types — consumers that don't
 * install them still type-check against the rest of the SDK.
 */
export interface FlightPeerModules {
  /** `apache-arrow` namespace subset. */
  readonly arrow: {
    /** `apache-arrow`'s `tableFromIPC` — decodes an IPC stream into a Table. */
    tableFromIPC(bytes: Uint8Array): unknown;
  };
  /** `@grpc/grpc-js` namespace subset. */
  readonly grpc: {
    /** gRPC metadata constructor (used for the `authorization` header). */
    Metadata: { new (): { set(key: string, value: string): unknown } };
    makeGenericClientConstructor(
      methods: Record<string, unknown>,
      serviceName: string,
      options: Record<string, unknown>,
    ): { new (target: string, credentials: unknown): FlightGrpcClient };
    readonly credentials: {
      createInsecure(): unknown;
      createSsl(): unknown;
    };
  };
}

/**
 * @internal The subset of the `@grpc/grpc-js` generic client the transport
 * drives. `DoGet` is server-streaming: it returns a Node `Readable`-ish stream
 * (EventEmitter emitting `data`/`end`/`error`/`status`).
 */
export interface FlightGrpcClient {
  DoGet(
    request: Uint8Array,
    metadata: { set(key: string, value: string): unknown },
    options: { deadline: number },
  ): FlightGrpcStream;
  close(): void;
}

/** @internal Stream emitted by `Client.DoGet`. */
export interface FlightGrpcStream {
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (err: unknown) => void): unknown;
  on(event: "status", listener: (status: FlightGrpcStatus) => void): unknown;
}

/** @internal gRPC trailing status. */
export interface FlightGrpcStatus {
  readonly code: number;
  readonly details: string;
}

/**
 * @internal The default peer-module loader: dynamically imports `apache-arrow`
 * and `@grpc/grpc-js`. Throws a `RelataError` with install guidance when either
 * peer is absent — the message `queryFlight()` surfaces so a caller learns
 * exactly what to `npm install` instead of an opaque module-resolution error.
 */
async function defaultLoadFlightModules(): Promise<FlightPeerModules> {
  let arrow: { tableFromIPC: (bytes: Uint8Array) => unknown };
  let grpc: typeof import("@grpc/grpc-js");
  try {
    // Dynamic import keeps these optional peer deps out of the SDK's module
    // graph until `queryFlight()` is actually used.
    arrow = (await import("apache-arrow")) as unknown as typeof arrow;
    grpc = (await import("@grpc/grpc-js")) as typeof import("@grpc/grpc-js");
  } catch {
    throw new RelataError(
      "queryFlight() needs Arrow Flight peer dependencies",
      0,
      "The built-in Arrow Flight transport requires `apache-arrow` and " +
        "`@grpc/grpc-js`, which are optional peer dependencies of " +
        "@zysec-ai/relata-sdk. Install them with:  npm install apache-arrow " +
        "@grpc/grpc-js   — or pass a custom `transport` to queryFlight().",
    );
  }
  // Cast the real grpc-js namespace to the narrow structural subset the
  // transport uses — the full module has far more surface than `FlightPeerModules`
  // (and its client ctor types require `ChannelCredentials`, not `unknown`), but
  // the runtime contract is exactly the subset declared here.
  return {
    arrow: arrow as unknown as FlightPeerModules["arrow"],
    grpc: grpc as unknown as FlightPeerModules["grpc"],
  };
}

// ---------------------------------------------------------------------------
// gRPC status → RelataError mapping
// ---------------------------------------------------------------------------

/** @internal gRPC status codes used by the mapping below (subset of grpc-js). */
const GRPC = {
  OK: 0,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  INVALID_ARGUMENT: 3,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

/**
 * @internal Map a gRPC `status` (from the stream's `error` or trailing
 * `status` event) to the closest `RelataError` subclass, mirroring how the
 * HTTP door's RFC 7807 responses are mapped in `errors.ts`. The Flight server
 * (`flight_server.rs`) emits: `UNAUTHENTICATED` for a bad bearer, `INVALID_ARGUMENT`
 * for a bad ticket, `PERMISSION_DENIED` for ACL/purpose/cross-shard denials,
 * `RESOURCE_EXHAUSTED` for per-tenant quota, and `INTERNAL` for planner errors.
 */
function mapGrpcError(status: FlightGrpcStatus, cause?: unknown): RelataError {
  const details = status.details || `gRPC code ${status.code}`;
  switch (status.code) {
    case GRPC.UNAUTHENTICATED:
      return new AuthError(details);
    case GRPC.PERMISSION_DENIED:
      return new ForbiddenError(details);
    case GRPC.RESOURCE_EXHAUSTED:
      return new QuotaError(details);
    case GRPC.INVALID_ARGUMENT:
      return new BadRequestError(details);
    case GRPC.DEADLINE_EXCEEDED:
      return new TimeoutError(0);
    case GRPC.UNAVAILABLE:
      return new NetworkError(`Arrow Flight unavailable: ${details}`, cause ?? status);
    default:
      return new RelataError(`Arrow Flight do_get failed: ${details}`, 0, details, undefined, {
        retryable: false,
      });
  }
}

// ---------------------------------------------------------------------------
// ArrowFlightTransport
// ---------------------------------------------------------------------------

/**
 * Options for {@link ArrowFlightTransport} and {@link createArrowFlightTransport}.
 */
export interface ArrowFlightTransportOptions {
  /**
   * Per-call deadline for the gRPC `DoGet` RPC, in milliseconds. The transport
   * surfaces `DEADLINE_EXCEEDED` as a {@link TimeoutError}. Defaults to 30s.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * @internal Override the peer-module loader (apache-arrow + @grpc/grpc-js).
   * Defaults to a real dynamic import that throws a clear `RelataError` when
   * the optional peers are absent. Used by tests.
   */
  readonly moduleLoader?: (() => Promise<FlightPeerModules>) | undefined;
}

/**
 * First-party Arrow Flight `do_get` transport (#2492).
 *
 * Implements the {@link FlightTransport} contract from `client.ts`: given the
 * resolved Flight `endpoint`, the assembled `ticketSql`, and the `bearer`
 * token, it opens a gRPC `FlightService/DoGet` RPC, streams `FlightData`
 * frames, reassembles them into an Arrow IPC buffer, and returns the decoded
 * `apache-arrow` `Table`. Used automatically by `RelataClient.queryFlight()`
 * when no caller `transport` is supplied, and usable directly:
 *
 * ```typescript
 * import { createArrowFlightTransport } from "@zysec-ai/relata-sdk";
 * import type { Table } from "apache-arrow";
 *
 * const table = await relata.queryFlight<Table>(
 *   "SELECT * FROM Person LIMIT 1000",
 *   { transport: createArrowFlightTransport() },
 * );
 * ```
 *
 * The transport builds a fresh gRPC client per call and closes it when the
 * stream ends (connection pooling is a future enhancement — sibling SDKs do
 * the same). TLS is selected automatically for `grpcs://` / `tls://`
 * endpoints (#2362), matching the Go SDK.
 */
export class ArrowFlightTransport<T = unknown> {
  readonly #moduleLoader: () => Promise<FlightPeerModules>;
  readonly #timeoutMs: number;

  /** Construct a transport. See {@link ArrowFlightTransportOptions}. */
  constructor(opts: ArrowFlightTransportOptions = {}) {
    this.#moduleLoader = opts.moduleLoader ?? defaultLoadFlightModules;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Perform the Arrow Flight `do_get` RPC and return the decoded columnar
   * result. Implements {@link FlightTransport}.
   */
  async doGet(
    endpoint: string,
    ticketSql: string,
    bearer: string | undefined,
  ): Promise<T> {
    const { arrow, grpc } = await this.#moduleLoader();
    const target = stripFlightScheme(endpoint);
    const creds = isSecureFlightEndpoint(endpoint)
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();
    const ClientCtor = grpc.makeGenericClientConstructor(
      {
        DoGet: {
          path: "/arrow.flight.protocol.FlightService/DoGet",
          requestStream: false,
          responseStream: true,
          // Raw pass-through: the request is the pre-serialized Ticket bytes,
          // each response chunk is a serialized FlightData we decode ourselves.
          requestSerialize: (req: Uint8Array) => Buffer.from(req),
          requestDeserialize: (buf: Uint8Array) => buf,
          responseSerialize: (res: Uint8Array) => Buffer.from(res),
          responseDeserialize: (buf: Uint8Array) => buf,
        },
      },
      "FlightService",
      {},
    );
    const client = new ClientCtor(target, creds);
    const metadata = new grpc.Metadata();
    if (bearer) metadata.set("authorization", `Bearer ${bearer}`);
    const ticket = encodeTicket(ticketSql);
    try {
      const frames = await this.#collectDoGet(client, ticket, metadata);
      const ipc = reassembleIpcStream(frames);
      return arrow.tableFromIPC(ipc) as T;
    } finally {
      client.close();
    }
  }

  /**
   * @internal Drive the server-streaming `DoGet` to completion, collecting
   * decoded `FlightData` frames. Resolves on `end`, rejects on `error` or a
   * non-OK trailing `status` — the two ways grpc-js surfaces RPC failure.
   */
  #collectDoGet(
    client: FlightGrpcClient,
    ticket: Uint8Array,
    metadata: { set(key: string, value: string): unknown },
  ): Promise<FlightDataMessage[]> {
    return new Promise((resolve, reject) => {
      const frames: FlightDataMessage[] = [];
      let settled = false;
      const finishOk = (): void => {
        if (!settled) {
          settled = true;
          resolve(frames);
        }
      };
      const fail = (err: unknown): void => {
        if (!settled) {
          settled = true;
          reject(err instanceof RelataError ? err : new NetworkError("Arrow Flight stream failed", err));
        }
      };
      const stream = client.DoGet(ticket, metadata, { deadline: Date.now() + this.#timeoutMs });
      stream.on("data", (chunk: Uint8Array) => {
        try {
          frames.push(decodeFlightData(chunk));
        } catch (err) {
          fail(err);
        }
      });
      stream.on("end", finishOk);
      stream.on("error", (err: unknown) => {
        // grpc-js delivers a status object on `error` for RPC-level failures.
        const maybeStatus = err as Partial<FlightGrpcStatus> | undefined;
        if (maybeStatus && typeof maybeStatus.code === "number") {
          fail(mapGrpcError(maybeStatus as FlightGrpcStatus, err));
        } else {
          fail(err);
        }
      });
      stream.on("status", (status: FlightGrpcStatus) => {
        if (status.code !== GRPC.OK) fail(mapGrpcError(status));
      });
    });
  }
}

/**
 * Create a first-party {@link ArrowFlightTransport}. Pass the resulting
 * transport to `RelataClient.queryFlight()` explicitly, or omit `transport`
 * entirely — `queryFlight()` uses this adapter by default. Call with a type
 * argument to get the decoded `apache-arrow` `Table` typed:
 *
 * ```typescript
 * import type { Table } from "apache-arrow";
 * const transport = createArrowFlightTransport<Table>();
 * ```
 */
export function createArrowFlightTransport<T = unknown>(
  opts?: ArrowFlightTransportOptions,
): ArrowFlightTransport<T> {
  return new ArrowFlightTransport<T>(opts);
}
