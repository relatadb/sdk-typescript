import type { RelataClient } from "./client.ts";
import { TypedClientBase, type TypedClientCtor, qs } from "./_typed-http.ts";
import { RelataError } from "./errors.ts";

export interface FilesOptions {
  /** Defaults to the authenticated tenant; strict tenant mode requires a match. */
  bucket?: string;
}

export interface FilePutOptions extends FilesOptions {
  contentType?: string;
}

/** Current file metadata. The content ETag is not an immutable version handle. */
export interface FileMetadata {
  bucket: string;
  key: string;
  row_id: string | null;
  size: number;
  etag: string;
  content_type: string;
  modified_ns: number;
  is_folder: boolean;
  download_url: string;
}

/** Server view of a resumable upload; `offset` is the next byte the server expects. */
export interface UploadSession {
  upload_id: string;
  bucket: string;
  key: string;
  size: number;
  offset: number;
  complete: boolean;
  sha256: string | null;
  expires_ns: number;
  max_chunk_bytes?: number;
}

/** Random-access source for `upload`, so only one chunk is ever held in memory. */
export interface UploadSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface UploadOptions extends FilePutOptions {
  /** Bytes per chunk; also capped by the server's `max_chunk_bytes` (default 8 MiB). */
  chunkSize?: number;
  /** Consecutive retryable failures tolerated before giving up (default 5). */
  maxAttempts?: number;
  /** Continue an existing session instead of starting one. */
  uploadId?: string;
  /** Whole-file SHA-256 (hex). Computed automatically for `Uint8Array` sources. */
  sha256?: string;
}

export interface FileContent {
  data: Uint8Array;
  etag: string | null;
  contentType: string | null;
  size: number;
}

const DEFAULT_CHUNK = 8 * 1024 * 1024;
const RESUMABLE = new Set([409, 422, 429, 502, 503, 504]);

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(data));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

/** Tenant-owned bytes through the core Files API, with inherited auth and limits. */
export class FilesClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) { super(opts); }

  static fromClient(client: RelataClient): FilesClient {
    return new FilesClient(TypedClientBase.clientToCtor(client));
  }

  /** Upload exact bytes (server limit 128 MiB). Uncertain writes are never retried. */
  async put(key: string, data: Uint8Array, opts: FilePutOptions = {}): Promise<FileMetadata> {
    const response = await this._sendBytes("PUT", this.path(key, opts), data, opts.contentType);
    this.expectStatus(response.status, 201, "PUT");
    return JSON.parse(new TextDecoder().decode(response.data)) as FileMetadata;
  }

  /** Create a folder marker (`POST /v1/files/folders`); resolves with 201 metadata (`is_folder` true). */
  async createFolder(key: string, opts: { bucket?: string } = {}): Promise<FileMetadata> {
    const body: Record<string, string> = { key };
    if (opts.bucket !== undefined) body["bucket"] = opts.bucket;
    const response = await this._sendBytes(
      "POST", "/v1/files/folders", new TextEncoder().encode(JSON.stringify(body)), "application/json",
    );
    this.expectStatus(response.status, 201, "POST folder");
    return JSON.parse(new TextDecoder().decode(response.data)) as FileMetadata;
  }

  /** Read bytes within the inherited response cap (64 MiB by default). */
  async get(key: string, opts: FilesOptions = {}): Promise<FileContent> {
    const response = await this._sendBytes("GET", this.path(key, opts));
    this.expectStatus(response.status, 200, "GET");
    return {
      data: response.data,
      etag: response.headers.get("etag"),
      contentType: response.headers.get("content-type"),
      size: response.data.byteLength,
    };
  }

  /**
   * Existence / metadata check (`HEAD /v1/files/content`). Resolves with the
   * response headers' view of the object, or `null` on 404.
   */
  async head(key: string, opts: FilesOptions = {}): Promise<FileContent | null> {
    let response: { data: Uint8Array; status: number; headers: Headers };
    try {
      response = await this._sendBytes("HEAD", this.path(key, opts));
    } catch (error) {
      if (error instanceof RelataError && error.statusCode === 404) return null;
      throw error;
    }
    this.expectStatus(response.status, 200, "HEAD");
    const length = response.headers.get("content-length");
    return {
      data: new Uint8Array(0),
      etag: response.headers.get("etag"),
      contentType: response.headers.get("content-type"),
      size: length !== null ? Number(length) : 0,
    };
  }

  /**
   * List objects (`GET /v1/files`), optionally under `prefix`, paginated with
   * `cursor`/`limit`. Returns the server's JSON page.
   */
  async list(
    opts: FilesOptions & { prefix?: string; cursor?: string; limit?: number } = {},
  ): Promise<Record<string, unknown>> {
    const response = await this._sendBytes(
      "GET",
      `/v1/files${qs({ bucket: opts.bucket, prefix: opts.prefix, cursor: opts.cursor, limit: opts.limit })}`,
      undefined,
      undefined,
      { Accept: "application/json" },
    );
    this.expectStatus(response.status, 200, "GET list");
    return JSON.parse(new TextDecoder().decode(response.data)) as Record<string, unknown>;
  }

  /**
   * Offloaded bytes of a stored media row (`GET /v1/media/:rowId/content`),
   * read within the inherited response cap.
   */
  async mediaContent(rowId: string): Promise<FileContent> {
    const response = await this._sendBytes("GET", `/v1/media/${encodeURIComponent(rowId)}/content`);
    this.expectStatus(response.status, 200, "GET media content");
    return {
      data: response.data,
      etag: response.headers.get("etag"),
      contentType: response.headers.get("content-type"),
      size: response.data.byteLength,
    };
  }

  /** Acknowledge exact HTTP 204; uncertain deletes are never retried. */
  async delete(key: string, opts: FilesOptions = {}): Promise<void> {
    const response = await this._sendBytes("DELETE", this.path(key, opts));
    this.expectStatus(response.status, 204, "DELETE");
  }

  /** Open a resumable upload; nothing is visible until `completeUpload`. */
  async startUpload(key: string, size: number, opts: FilePutOptions & { sha256?: string } = {}): Promise<UploadSession> {
    const body = new TextEncoder().encode(JSON.stringify({
      key, size, bucket: opts.bucket, content_type: opts.contentType, sha256: opts.sha256,
    }));
    const response = await this._sendBytes("POST", "/v1/files/uploads", body, "application/json");
    this.expectStatus(response.status, 201, "POST upload");
    return JSON.parse(new TextDecoder().decode(response.data)) as UploadSession;
  }

  /** Append a chunk at `offset` (digest-checked by the server); a wrong offset is a typed 409. */
  async uploadChunk(uploadId: string, offset: number, data: Uint8Array): Promise<UploadSession> {
    const response = await this._sendBytes(
      "PUT", `/v1/files/uploads/${encodeURIComponent(uploadId)}${qs({ offset })}`, data, undefined,
      { "X-Relata-Chunk-Sha256": await sha256Hex(data) },
    );
    this.expectStatus(response.status, 200, "PUT upload chunk");
    return JSON.parse(new TextDecoder().decode(response.data)) as UploadSession;
  }

  /** Durable next-expected offset of an upload (survives server restarts). */
  async uploadStatus(uploadId: string): Promise<UploadSession> {
    const response = await this._sendBytes("GET", `/v1/files/uploads/${encodeURIComponent(uploadId)}`);
    this.expectStatus(response.status, 200, "GET upload");
    return JSON.parse(new TextDecoder().decode(response.data)) as UploadSession;
  }

  /** Verify and commit staged bytes; never retried automatically. */
  async completeUpload(uploadId: string): Promise<FileMetadata> {
    const response = await this._sendBytes("POST", `/v1/files/uploads/${encodeURIComponent(uploadId)}/complete`);
    this.expectStatus(response.status, 201, "POST upload complete");
    return JSON.parse(new TextDecoder().decode(response.data)) as FileMetadata;
  }

  /** Discard an upload and its staged data (idempotent). */
  async abortUpload(uploadId: string): Promise<void> {
    const response = await this._sendBytes("DELETE", `/v1/files/uploads/${encodeURIComponent(uploadId)}`);
    this.expectStatus(response.status, 204, "DELETE upload");
  }

  /**
   * Resumable chunked upload with one chunk in memory. After a retryable failure
   * (409/422/429/5xx) the server offset is re-read and the upload continues from
   * there; after `maxAttempts` consecutive failures the session is left in place
   * (pass its id as `uploadId` to continue) and the error is rethrown.
   */
  async upload(key: string, source: Uint8Array | UploadSource, opts: UploadOptions = {}): Promise<FileMetadata> {
    const src: UploadSource = source instanceof Uint8Array
      ? { size: source.byteLength, read: async (o, n) => source.subarray(o, o + n) }
      : source;
    const sha256 = opts.sha256 ?? (source instanceof Uint8Array ? await sha256Hex(source) : undefined);
    let session = opts.uploadId !== undefined
      ? await this.uploadStatus(opts.uploadId)
      : await this.startUpload(key, src.size, { ...opts, ...(sha256 !== undefined ? { sha256 } : {}) });
    const step = Math.min(opts.chunkSize ?? DEFAULT_CHUNK, session.max_chunk_bytes ?? DEFAULT_CHUNK);
    const maxAttempts = opts.maxAttempts ?? 5;
    let failures = 0;
    while (session.offset < src.size) {
      const piece = await src.read(session.offset, Math.min(step, src.size - session.offset));
      try {
        session = await this.uploadChunk(session.upload_id, session.offset, piece);
        failures = 0;
      } catch (error) {
        failures++;
        const status = error instanceof RelataError ? error.statusCode : 0;
        if (!RESUMABLE.has(status) || failures >= maxAttempts) throw error;
        session = await this.uploadStatus(session.upload_id);
      }
    }
    return this.completeUpload(session.upload_id);
  }

  private path(key: string, opts: FilesOptions): string {
    return `/v1/files/content${qs({ key, bucket: opts.bucket })}`;
  }

  private expectStatus(actual: number, expected: number, method: string): void {
    if (actual !== expected) {
      throw new RelataError(
        `Files ${method} expected HTTP ${expected}, got ${actual}; reconcile uncertain writes before retrying`,
        actual,
        `Unexpected Files ${method} response`,
      );
    }
  }
}
