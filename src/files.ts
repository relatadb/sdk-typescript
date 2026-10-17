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

export interface FileContent {
  data: Uint8Array;
  etag: string | null;
  contentType: string | null;
  size: number;
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

  /** Acknowledge exact HTTP 204; uncertain deletes are never retried. */
  async delete(key: string, opts: FilesOptions = {}): Promise<void> {
    const response = await this._sendBytes("DELETE", this.path(key, opts));
    this.expectStatus(response.status, 204, "DELETE");
  }

  private path(key: string, opts: FilesOptions): string {
    return `/files/content${qs({ key, bucket: opts.bucket })}`;
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
