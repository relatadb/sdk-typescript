/**
 * First-party gRPC query client with Arrow-IPC `RowBatch` opt-in (#4090).
 *
 * PR #4086 (epic #3879 Wave 6, #3912/#4020 item 2) landed the server-side
 * wire encoding for a negotiated Arrow-IPC row encoding on the plain gRPC
 * `RelataQuery` service (`proto/relata.proto`'s `QueryRequest.wants_arrow_ipc_rows`
 * / `QueryResponse.arrow_ipc_rows` / `RowBatch.arrow_ipc_rows`,
 * `crates/relata-server/src/grpc.rs::encode_rows_arrow_ipc_or_json`), mirroring
 * ADR-0255's own `ShardQueryRequest`/`ShardQueryResponse` negotiated-capability
 * pattern. No first-party SDK opted into it — this module is that opt-in for
 * the TypeScript SDK, picked as the first mover because it already has the
 * exact scaffolding this needs: `flight.ts` (#2492) already ships a
 * first-party gRPC transport with `apache-arrow` + `@grpc/grpc-js` as
 * **optional peer dependencies** and a hand-rolled protobuf wire codec (no
 * `@grpc/proto-loader`, no bundled `.proto` asset). This module is the same
 * pattern applied to `RelataQuery.Execute` instead of `FlightService.DoGet`.
 *
 * `QueryRequest`/`QueryResponse`/`RowBatch` are simple enough (every field is
 * a scalar or a `repeated string`/`bytes` — no nested messages, no maps, no
 * oneofs) that hand-rolling their encode/decode stays a small, self-contained
 * slice, same as `flight.ts`'s `Ticket`/`FlightData` codec.
 *
 * This module wires both `RelataQuery` RPCs that make sense for a
 * `wants_arrow_ipc_rows` caller: the unary `Execute` (`GrpcQueryTransport.execute`)
 * and the server-streaming `ExecuteStream` (`GrpcQueryTransport.executeStream`,
 * #4090 follow-up — collects the streamed `RowBatch` frames and decodes them
 * into the same row-object shape `execute` returns). Both normalize to the
 * same result shape regardless of which wire encoding the server chose
 * (`rows_json` vs `arrow_ipc_rows`) — callers never need to know which one
 * came back; an empty `arrow_ipc_rows` (on `QueryResponse` or a `RowBatch`
 * frame) always means "read `rows_json` instead" per the proto's documented
 * fallback contract, never "zero rows."
 *
 * @module
 */

import { RelataError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Minimal protobuf varint + wire helpers (mirrors flight.ts's local codec —
// kept self-contained here rather than shared, same as every first-party SDK
// reimplementing its own minimal framing locally).
// ---------------------------------------------------------------------------

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
  /** Decoded unsigned value (safe up to `Number.MAX_SAFE_INTEGER`). */
  value: number;
  /** Offset of the first byte AFTER the varint. */
  next: number;
}

/**
 * Decode a base-128 varint at `offset` using floating-point accumulation
 * (safe up to 2^53) rather than a 32-bit bitmask — `QueryResponse.row_count`
 * is a genuine `int64`, unlike Flight's length-prefix varints which never
 * exceed 32 bits. @internal
 */
function readVarint(buf: Uint8Array, offset: number): VarintRead {
  let result = 0;
  let mult = 1;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i]!;
    i += 1;
    result += (byte & 0x7f) * mult;
    if ((byte & 0x80) === 0) return { value: result, next: i };
    mult *= 128;
    if (mult > Number.MAX_SAFE_INTEGER) {
      throw new Error("protobuf varint overflow — value exceeds safe integer range");
    }
  }
  throw new Error("truncated protobuf varint — short gRPC query frame");
}

/**
 * Encode a `QueryRequest` (`proto/relata.proto`) — `purpose` (1), `sql` (2),
 * `bearer_token` (3, unused server-side today — auth travels as gRPC
 * `authorization` metadata, same as {@link ArrowFlightTransport}, see
 * `crates/relata-server/src/grpc.rs::check_bearer_token`), `wants_arrow_ipc_rows`
 * (4). Proto3 default values (`""`, `false`) are omitted, matching idiomatic
 * proto3 wire output. @internal exported for testing.
 */
export function encodeQueryRequest(req: {
  purpose?: string;
  sql: string;
  bearerToken?: string;
  wantsArrowIpcRows?: boolean;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  const writeString = (field: number, s: string): void => {
    if (!s) return;
    const payload = new TextEncoder().encode(s);
    parts.push(
      new Uint8Array([(field << 3) | 2]),
      new Uint8Array(encodeVarint(payload.length)),
      payload,
    );
  };
  writeString(1, req.purpose ?? "");
  writeString(2, req.sql);
  writeString(3, req.bearerToken ?? "");
  if (req.wantsArrowIpcRows) {
    parts.push(new Uint8Array([(4 << 3) | 0]), new Uint8Array(encodeVarint(1)));
  }
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

/** @internal Decoded `QueryResponse` (`proto/relata.proto`). */
export interface DecodedQueryResponse {
  /** Column names (field 1, repeated string). */
  readonly columns: string[];
  /** Total row count (field 2, int64) — reflects the true count either way. */
  readonly rowCount: number;
  /** JSON-encoded rows (field 3) — read when `arrowIpcRows` is empty. */
  readonly rowsJson: string[];
  /**
   * Arrow IPC stream bytes (field 4). Empty means "read `rowsJson` instead"
   * per the proto's documented fallback contract — never "zero rows."
   */
  readonly arrowIpcRows: Uint8Array;
}

/**
 * Decode a `QueryResponse` protobuf. Unknown wire types are skipped so the
 * decoder is forward-compatible with future response fields, mirroring
 * `flight.ts`'s `decodeFlightData`. @internal exported for testing.
 */
export function decodeQueryResponse(buf: Uint8Array): DecodedQueryResponse {
  let i = 0;
  const columns: string[] = [];
  let rowCount = 0;
  const rowsJson: string[] = [];
  let arrowIpcRows: Uint8Array = new Uint8Array(0);
  const decoder = new TextDecoder();
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
        case 1: columns.push(decoder.decode(seg)); break;
        case 3: rowsJson.push(decoder.decode(seg)); break;
        case 4: arrowIpcRows = seg; break;
        default: break;
      }
    } else if (wireType === 0) {
      const vRead = readVarint(buf, i);
      i = vRead.next;
      if (fieldNumber === 2) rowCount = vRead.value;
    } else if (wireType === 1) {
      i += 8;
    } else if (wireType === 5) {
      i += 4;
    } else {
      break; // unknown wire type — stop (QueryResponse never uses groups)
    }
  }
  return { columns, rowCount, rowsJson, arrowIpcRows };
}

/**
 * @internal Decoded `RowBatch` (`proto/relata.proto`) — one frame of a
 * streamed `RelataQuery.ExecuteStream` response. Field layout is **not** the
 * same as `QueryResponse`: `columns` (1, repeated string), `rows_json` (2,
 * repeated string — field 2 here, field 3 on `QueryResponse`), `done` (3,
 * bool varint — `QueryResponse` has no equivalent), `arrow_ipc_rows` (4,
 * bytes, same field number and fallback contract as `QueryResponse`).
 */
export interface DecodedRowBatch {
  /** Column names (field 1, repeated string) — resent on every frame. */
  readonly columns: string[];
  /** JSON-encoded rows for this frame (field 2) — read when `arrowIpcRows` is empty. */
  readonly rowsJson: string[];
  /** Whether this is the terminal frame — never carries rows itself unless
   * this frame's data is also the last (one-batch-lookahead server contract). */
  readonly done: boolean;
  /**
   * Arrow IPC stream bytes for this frame (field 4). Empty means "read this
   * frame's `rowsJson` instead" — same fallback convention as
   * `QueryResponse.arrow_ipc_rows`, applied per frame.
   */
  readonly arrowIpcRows: Uint8Array;
}

/**
 * Decode a single `RowBatch` protobuf frame. Unknown wire types are skipped
 * for forward compatibility, mirroring {@link decodeQueryResponse}. @internal
 * exported for testing.
 */
export function decodeRowBatch(buf: Uint8Array): DecodedRowBatch {
  let i = 0;
  const columns: string[] = [];
  const rowsJson: string[] = [];
  let done = false;
  let arrowIpcRows: Uint8Array = new Uint8Array(0);
  const decoder = new TextDecoder();
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
        case 1: columns.push(decoder.decode(seg)); break;
        case 2: rowsJson.push(decoder.decode(seg)); break;
        case 4: arrowIpcRows = seg; break;
        default: break;
      }
    } else if (wireType === 0) {
      const vRead = readVarint(buf, i);
      i = vRead.next;
      if (fieldNumber === 3) done = vRead.value !== 0;
    } else if (wireType === 1) {
      i += 8;
    } else if (wireType === 5) {
      i += 4;
    } else {
      break; // unknown wire type — stop (RowBatch never uses groups)
    }
  }
  return { columns, rowsJson, done, arrowIpcRows };
}

// ---------------------------------------------------------------------------
// Endpoint helpers (mirrors flight.ts's stripFlightScheme/isSecureFlightEndpoint)
// ---------------------------------------------------------------------------

/**
 * Report whether `endpoint` requests a TLS-protected gRPC connection.
 * `grpcs://` / `tls://` select TLS; `grpc://` (and the legacy bare `http://`
 * form) remain plaintext. @internal exported for testing.
 */
export function isSecureGrpcQueryEndpoint(endpoint: string): boolean {
  return endpoint.startsWith("grpcs://") || endpoint.startsWith("tls://");
}

/**
 * Strip the scheme prefix from a gRPC endpoint, leaving the bare `host:port`
 * that `@grpc/grpc-js`'s `Client` target wants. @internal exported for
 * testing.
 */
export function stripGrpcQueryScheme(endpoint: string): string {
  for (const prefix of ["grpcs://", "grpc://", "tls://", "http://"]) {
    if (endpoint.startsWith(prefix)) return endpoint.slice(prefix.length);
  }
  return endpoint;
}

// ---------------------------------------------------------------------------
// Optional peer-dep loading (apache-arrow + @grpc/grpc-js) — same pattern as
// flight.ts's defaultLoadFlightModules.
// ---------------------------------------------------------------------------

/**
 * @internal Structural shape of the two optional peer modules this transport
 * uses. Slightly richer than {@link FlightPeerModules} (flight.ts) — decoding
 * `arrow_ipc_rows` into row objects needs `schema.fields` + `getChild`, not
 * just `tableFromIPC`.
 */
export interface GrpcQueryPeerModules {
  /** `apache-arrow` namespace subset. */
  readonly arrow: {
    tableFromIPC(bytes: Uint8Array): {
      numRows: number;
      schema: { fields: Array<{ name: string }> };
      getChild(name: string): { get(i: number): unknown } | null;
    };
  };
  /** `@grpc/grpc-js` namespace subset. */
  readonly grpc: {
    Metadata: { new (): { set(key: string, value: string): unknown } };
    makeGenericClientConstructor(
      methods: Record<string, unknown>,
      serviceName: string,
      options: Record<string, unknown>,
    ): { new (target: string, credentials: unknown): GrpcQueryGrpcClient };
    readonly credentials: {
      createInsecure(): unknown;
      createSsl(): unknown;
    };
  };
}

/** @internal Trailing gRPC status shape (subset of grpc-js). */
export interface GrpcQueryStatus {
  readonly code: number;
  readonly details: string;
}

/**
 * @internal The subset of the `@grpc/grpc-js` generic client the transport
 * drives. `Execute` is unary: grpc-js's generated client shape is
 * `Method(request, metadata, options, callback)`. `ExecuteStream` is
 * server-streaming: it returns a `GrpcQueryGrpcStream` (Node
 * `Readable`-ish EventEmitter), same shape as `flight.ts`'s `DoGet`.
 */
export interface GrpcQueryGrpcClient {
  Execute(
    request: Uint8Array,
    metadata: { set(key: string, value: string): unknown },
    options: { deadline: number },
    callback: (err: GrpcQueryStatus | null, response?: Uint8Array) => void,
  ): unknown;
  ExecuteStream(
    request: Uint8Array,
    metadata: { set(key: string, value: string): unknown },
    options: { deadline: number },
  ): GrpcQueryGrpcStream;
  close(): void;
}

/** @internal Stream emitted by `Client.ExecuteStream` — mirrors `flight.ts`'s `FlightGrpcStream`. */
export interface GrpcQueryGrpcStream {
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (err: unknown) => void): unknown;
  on(event: "status", listener: (status: GrpcQueryStatus) => void): unknown;
}

/**
 * @internal The default peer-module loader: dynamically imports
 * `apache-arrow` and `@grpc/grpc-js`. Throws a `RelataError` with install
 * guidance when either peer is absent, mirroring `flight.ts`'s
 * `defaultLoadFlightModules`.
 */
async function defaultLoadGrpcQueryModules(): Promise<GrpcQueryPeerModules> {
  let arrow: GrpcQueryPeerModules["arrow"];
  let grpc: typeof import("@grpc/grpc-js");
  try {
    arrow = (await import("apache-arrow")) as unknown as GrpcQueryPeerModules["arrow"];
    grpc = (await import("@grpc/grpc-js")) as typeof import("@grpc/grpc-js");
  } catch {
    throw new RelataError(
      "queryGrpc() needs gRPC peer dependencies",
      0,
      "The built-in gRPC query transport requires `apache-arrow` and " +
        "`@grpc/grpc-js`, which are optional peer dependencies of " +
        "@zysec-ai/relata-sdk. Install them with:  npm install apache-arrow " +
        "@grpc/grpc-js   — or pass a custom `transport` to queryGrpc().",
    );
  }
  return {
    arrow,
    grpc: grpc as unknown as GrpcQueryPeerModules["grpc"],
  };
}

/**
 * @internal Convert a self-contained Arrow IPC stream (schema + one
 * RecordBatch, per `QueryResponse.arrow_ipc_rows`'s documented shape,
 * `crates/relata-cluster/src/transport.rs::encode_shard_rows_arrow_ipc`) into
 * plain row objects — the same shape `rowsJson.map(JSON.parse)` would
 * produce, so callers never need to know which wire encoding the server
 * chose.
 */
function arrowIpcRowsToObjects<T>(
  bytes: Uint8Array,
  arrow: GrpcQueryPeerModules["arrow"],
): T[] {
  const table = arrow.tableFromIPC(bytes);
  const fieldNames = table.schema.fields.map((f) => f.name);
  const rows: T[] = [];
  for (let r = 0; r < table.numRows; r += 1) {
    const row: Record<string, unknown> = {};
    for (const name of fieldNames) {
      row[name] = table.getChild(name)?.get(r) ?? null;
    }
    rows.push(row as T);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// GrpcQueryTransport
// ---------------------------------------------------------------------------

/** Decoded result of {@link GrpcQueryTransport.execute}. */
export interface GrpcQueryResult<T> {
  /** Column names in projection order (empty if the server sent none). */
  readonly columns: string[];
  /** Total row count. */
  readonly rowCount: number;
  /** Decoded rows — from `arrow_ipc_rows` when present, else `rows_json`. */
  readonly rows: T[];
}

/** Options for {@link GrpcQueryTransport} / {@link createGrpcQueryTransport}. */
export interface GrpcQueryTransportOptions {
  /** Per-call deadline for the gRPC `Execute` RPC, in milliseconds. Defaults to 30s. */
  readonly timeoutMs?: number | undefined;
  /** @internal Override the peer-module loader. Used by tests. */
  readonly moduleLoader?: (() => Promise<GrpcQueryPeerModules>) | undefined;
}

/**
 * First-party gRPC `RelataQuery.Execute` transport that negotiates the
 * Arrow-IPC row encoding (#4090). Opens a real gRPC unary RPC, sets
 * `wants_arrow_ipc_rows = true` on the request, and transparently decodes
 * whichever encoding the server answered with (`arrow_ipc_rows` or
 * `rows_json`) into the same row-object shape.
 *
 * The transport builds a fresh gRPC client per call and closes it when the
 * call completes — same lifecycle as {@link ArrowFlightTransport}.
 */
export class GrpcQueryTransport {
  readonly #moduleLoader: () => Promise<GrpcQueryPeerModules>;
  readonly #timeoutMs: number;

  /** Construct a transport. See {@link GrpcQueryTransportOptions}. */
  constructor(opts: GrpcQueryTransportOptions = {}) {
    this.#moduleLoader = opts.moduleLoader ?? defaultLoadGrpcQueryModules;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Execute `sql` over gRPC's `RelataQuery/Execute` unary RPC, opting into
   * `wants_arrow_ipc_rows`.
   *
   * `headers` carries the tenant / acting-as / delegated-by / request-id
   * scope as gRPC metadata, same convention as
   * {@link ArrowFlightTransport.doGet}.
   */
  async execute<T = Record<string, unknown>>(
    endpoint: string,
    sql: string,
    opts?: {
      purpose?: string;
      bearer?: string;
      headers?: Record<string, string>;
    },
  ): Promise<GrpcQueryResult<T>> {
    const { arrow, grpc } = await this.#moduleLoader();
    const target = stripGrpcQueryScheme(endpoint);
    const creds = isSecureGrpcQueryEndpoint(endpoint)
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();
    const ClientCtor = grpc.makeGenericClientConstructor(
      {
        Execute: {
          path: "/relata.RelataQuery/Execute",
          requestStream: false,
          responseStream: false,
          requestSerialize: (req: Uint8Array) => Buffer.from(req),
          requestDeserialize: (buf: Uint8Array) => buf,
          responseSerialize: (res: Uint8Array) => Buffer.from(res),
          responseDeserialize: (buf: Uint8Array) => buf,
        },
      },
      "RelataQuery",
      {},
    );
    const client = new ClientCtor(target, creds);
    const metadata = new grpc.Metadata();
    if (opts?.bearer) metadata.set("authorization", `Bearer ${opts.bearer}`);
    if (opts?.headers !== undefined) {
      for (const [k, v] of Object.entries(opts.headers)) metadata.set(k.toLowerCase(), v);
    }
    // #9a: `exactOptionalPropertyTypes: true` (tsconfig) rejects an explicit
    // `purpose: undefined` — only set the key when a value is actually present.
    const encodeReq: Parameters<typeof encodeQueryRequest>[0] = { sql, wantsArrowIpcRows: true };
    if (opts?.purpose !== undefined) encodeReq.purpose = opts.purpose;
    const reqBytes = encodeQueryRequest(encodeReq);
    try {
      const respBytes = await this.#callExecute(client, reqBytes, metadata);
      const decoded = decodeQueryResponse(respBytes);
      const rows =
        decoded.arrowIpcRows.length > 0
          ? arrowIpcRowsToObjects<T>(decoded.arrowIpcRows, arrow)
          : decoded.rowsJson.map((s) => JSON.parse(s) as T);
      return { columns: decoded.columns, rowCount: decoded.rowCount, rows };
    } finally {
      client.close();
    }
  }

  /**
   * Execute `sql` over gRPC's `RelataQuery/ExecuteStream` server-streaming
   * RPC, opting into `wants_arrow_ipc_rows` (#4090 follow-up). Collects every
   * streamed `RowBatch` frame (each frame independently negotiates the
   * Arrow-IPC encoding, same fallback contract as {@link execute}'s
   * `QueryResponse`) and decodes them into the same row-object result shape
   * `execute` returns, so callers don't need a different consumption model
   * for a large result set versus a small one.
   *
   * Same options as {@link execute}; `headers`/`purpose`/`bearer` carry the
   * same tenant/delegation/correlation scope.
   */
  async executeStream<T = Record<string, unknown>>(
    endpoint: string,
    sql: string,
    opts?: {
      purpose?: string;
      bearer?: string;
      headers?: Record<string, string>;
    },
  ): Promise<GrpcQueryResult<T>> {
    const { arrow, grpc } = await this.#moduleLoader();
    const target = stripGrpcQueryScheme(endpoint);
    const creds = isSecureGrpcQueryEndpoint(endpoint)
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();
    const ClientCtor = grpc.makeGenericClientConstructor(
      {
        ExecuteStream: {
          path: "/relata.RelataQuery/ExecuteStream",
          requestStream: false,
          responseStream: true,
          requestSerialize: (req: Uint8Array) => Buffer.from(req),
          requestDeserialize: (buf: Uint8Array) => buf,
          responseSerialize: (res: Uint8Array) => Buffer.from(res),
          responseDeserialize: (buf: Uint8Array) => buf,
        },
      },
      "RelataQuery",
      {},
    );
    const client = new ClientCtor(target, creds);
    const metadata = new grpc.Metadata();
    if (opts?.bearer) metadata.set("authorization", `Bearer ${opts.bearer}`);
    if (opts?.headers !== undefined) {
      for (const [k, v] of Object.entries(opts.headers)) metadata.set(k.toLowerCase(), v);
    }
    // #9a: `exactOptionalPropertyTypes: true` (tsconfig) rejects an explicit
    // `purpose: undefined` — only set the key when a value is actually present.
    const encodeReq: Parameters<typeof encodeQueryRequest>[0] = { sql, wantsArrowIpcRows: true };
    if (opts?.purpose !== undefined) encodeReq.purpose = opts.purpose;
    const reqBytes = encodeQueryRequest(encodeReq);
    try {
      const frames = await this.#collectExecuteStream(client, reqBytes, metadata);
      let columns: string[] = [];
      const rows: T[] = [];
      for (const frame of frames) {
        if (frame.columns.length > 0) columns = frame.columns;
        if (frame.arrowIpcRows.length > 0) {
          rows.push(...arrowIpcRowsToObjects<T>(frame.arrowIpcRows, arrow));
        } else if (frame.rowsJson.length > 0) {
          rows.push(...frame.rowsJson.map((s) => JSON.parse(s) as T));
        }
      }
      return { columns, rowCount: rows.length, rows };
    } finally {
      client.close();
    }
  }

  /**
   * @internal Drive the server-streaming `ExecuteStream` call to completion,
   * collecting decoded `RowBatch` frames. Resolves on the `done: true` frame
   * (or the underlying stream's `end` event, whichever comes first — both
   * signal the same thing per the server's one-batch-lookahead contract);
   * rejects on `error` or a non-OK trailing `status`. Mirrors `flight.ts`'s
   * `#collectDoGet`.
   */
  #collectExecuteStream(
    client: GrpcQueryGrpcClient,
    request: Uint8Array,
    metadata: { set(key: string, value: string): unknown },
  ): Promise<DecodedRowBatch[]> {
    return new Promise((resolve, reject) => {
      const frames: DecodedRowBatch[] = [];
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
          const maybeStatus = err as Partial<GrpcQueryStatus> | undefined;
          const details =
            maybeStatus?.details ?? (err instanceof Error ? err.message : `gRPC stream failure: ${String(err)}`);
          reject(new RelataError(`gRPC query ExecuteStream failed: ${details}`, 0, details));
        }
      };
      const stream = client.ExecuteStream(request, metadata, { deadline: Date.now() + this.#timeoutMs });
      stream.on("data", (chunk: Uint8Array) => {
        try {
          const frame = decodeRowBatch(chunk);
          frames.push(frame);
          if (frame.done) finishOk();
        } catch (err) {
          fail(err);
        }
      });
      stream.on("end", finishOk);
      stream.on("error", (err: unknown) => {
        const maybeStatus = err as Partial<GrpcQueryStatus> | undefined;
        if (maybeStatus && typeof maybeStatus.code === "number") fail(maybeStatus);
        else fail(err);
      });
      stream.on("status", (status: GrpcQueryStatus) => {
        if (status.code !== 0) fail(status);
      });
    });
  }

  /**
   * @internal Drive the unary `Execute` call to completion, wrapped as a
   * Promise. Rejects with a `RelataError` on RPC failure (mirrors
   * `flight.ts`'s status handling, minus the streaming-specific machinery
   * since `Execute` is unary).
   */
  #callExecute(
    client: GrpcQueryGrpcClient,
    request: Uint8Array,
    metadata: { set(key: string, value: string): unknown },
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      client.Execute(
        request,
        metadata,
        { deadline: Date.now() + this.#timeoutMs },
        (err, response) => {
          if (err) {
            const details = err.details || `gRPC code ${err.code}`;
            reject(new RelataError(`gRPC query Execute failed: ${details}`, 0, details));
            return;
          }
          resolve(response ?? new Uint8Array(0));
        },
      );
    });
  }
}

/**
 * Create a first-party {@link GrpcQueryTransport}. See
 * `RelataClient.queryGrpc()` for the wired-up convenience method.
 */
export function createGrpcQueryTransport(opts?: GrpcQueryTransportOptions): GrpcQueryTransport {
  return new GrpcQueryTransport(opts);
}
