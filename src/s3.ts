/**
 * S3 protocol-door client (#81) — thin native-fetch wrapper around
 * RelataDB's built-in S3-compatible server.
 *
 * The Python SDK ships three flavours: `boto3()` (SigV4-signed), `httpx()`
 * (zero-dep HTTP), and `aio()` (async aiobotocore). `boto3`/`aiobotocore`
 * are Python-only; this TypeScript port ships **only** the native-fetch
 * equivalent — a zero-runtime-dependency `http()` method that issues
 * standard S3 REST verbs (`GET /<bucket>`, `PUT /<bucket>/<key>`, etc.)
 * against the door endpoint, with the bearer token sent as both
 * `Authorization: Bearer <token>` and `X-Relata-Tenant-Id` (when a tenant is
 * set).
 *
 * The server ships a working S3 door at `crates/relata-cli/src/s3_server.rs`
 * with `ListBuckets`, `CreateBucket`, `PutObject`, `GetObject`, and
 * `DeleteObject`.
 *
 * Bucket/key mapping: RelataDB stores each object as a typed `S3Object` row
 * plus an optional content-addressed blob (when the body is at/above
 * `RELATA_S3_BLOB_THRESHOLD_MB`, default 4 MiB). ETag is SHA-256 of the body.
 * Multipart parts are in-memory only today (lost on restart — open #37).
 */

import { RelataClient } from "./client.ts";
import { assertNotRedirected } from "./errors.ts";

// ---------------------------------------------------------------------------
// S3Client
// ---------------------------------------------------------------------------

/** Options for constructing an {@link S3Client}. */
export interface S3ClientOptions {
  /** Optional bearer token (also sent as `Authorization: Bearer <token>`). */
  bearerToken?: string;
  /** Optional tenant sent as `X-Relata-Tenant-Id`. */
  tenant?: string;
  /** Optional `X-Acting-As` delegation principal (#3213). */
  actingAs?: string;
  /** Optional `X-Delegated-By` delegation root (#3213). */
  delegatedBy?: string;
  /**
   * Optional caller header bag overlaid on every request; a pinned
   * `X-Request-ID` wins over the auto-generated per-request one (#3213).
   */
  headers?: Record<string, string>;
  /** Optional region tag (the door is region-agnostic; defaults to `us-east-1`). */
  region?: string;
  /** Override `fetch` (testing / observability). Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** Response returned by `S3Client.http`. */
export interface S3HttpResponse {
  /** HTTP status code returned by the server. */
  status: number;
  /** All response headers (lower-cased keys). */
  headers: Record<string, string>;
  /** Raw response body as bytes. */
  body: Uint8Array;
}

/**
 * Native-fetch wrapper around RelataDB's S3-compatible door.
 *
 * Use `fromClient(relata)` to inherit the parent client's endpoint, bearer
 * token, and tenant.
 *
 * ```typescript
 * import { createClient, S3Client } from "@zysec-ai/relata-sdk";
 * const relata = createClient("http://localhost:9090", { bearerToken: tok });
 * const s3 = S3Client.fromClient(relata);
 *
 * // Create a bucket
 * await s3.http("PUT", "/acme-intel");
 * // Put an object
 * await s3.http("PUT", "/acme-intel/report.pdf", { body: pdfBytes });
 * // Get it back
 * const obj = await s3.http("GET", "/acme-intel/report.pdf");
 * console.log(obj.body); // Uint8Array
 * ```
 */
export class S3Client {
  readonly #endpointUrl: string;
  readonly #bearerToken: string | undefined;
  readonly #tenant: string | undefined;
  readonly #actingAs: string | undefined;
  readonly #delegatedBy: string | undefined;
  readonly #headers: Record<string, string>;
  readonly #region: string;
  readonly #fetch: typeof globalThis.fetch;

  /**
   * Construct an S3 door client. Most callers should use
   * {@link S3Client.fromClient} instead.
   */
  constructor(endpointUrl: string, opts: S3ClientOptions = {}) {
    this.#endpointUrl = endpointUrl.replace(/\/+$/, "");
    this.#bearerToken = opts.bearerToken;
    this.#tenant = opts.tenant;
    this.#actingAs = opts.actingAs;
    this.#delegatedBy = opts.delegatedBy;
    this.#headers = opts.headers !== undefined ? { ...opts.headers } : {};
    this.#region = opts.region ?? "us-east-1";
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Inherit the parent client's endpoint, bearer token, tenant, delegation
   * scope (#3213), and fetch override.
   */
  static fromClient(client: RelataClient): S3Client {
    const opts: S3ClientOptions = { fetch: client.fetchImpl };
    if (client.bearerToken !== undefined) opts.bearerToken = client.bearerToken;
    if (client.tenant !== undefined) opts.tenant = client.tenant;
    if (client.actingAs !== undefined) opts.actingAs = client.actingAs;
    if (client.delegatedBy !== undefined) opts.delegatedBy = client.delegatedBy;
    return new S3Client(client.baseUrl, opts);
  }

  /** Door endpoint URL (trailing slash stripped). */
  get endpointUrl(): string {
    return this.#endpointUrl;
  }

  /** Region tag (the door is region-agnostic). */
  get region(): string {
    return this.#region;
  }

  /**
   * Issue a raw S3 REST verb against the door. The caller is responsible for
   * the path shape — RelataDB uses path-style addressing
   * (`/<bucket>/<key>`).
   *
   * @param method  HTTP verb (`GET`, `PUT`, `DELETE`, `HEAD`).
   * @param path    Path beginning with `/<bucket>`; append `/<key>` for an
   *                object operation.
   * @param body    Optional request body (bytes or string).
   * @param headers Optional extra headers (Content-Type, Content-MD5, …).
   * @returns The decoded response: `status`, `headers` (lower-cased),
   *          `body` (bytes).
   */
  async http(
    method: string,
    path: string,
    opts: {
      body?: Uint8Array | string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<S3HttpResponse> {
    // Normalise the path so callers can pass either "/bucket" or "bucket".
    const normalisedPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${this.#endpointUrl}${normalisedPath}`;

    const headers: Record<string, string> = {};
    if (this.#bearerToken !== undefined) {
      headers["Authorization"] = `Bearer ${this.#bearerToken}`;
    }
    if (this.#tenant !== undefined) {
      headers["X-Relata-Tenant-Id"] = this.#tenant;
    }
    if (this.#actingAs !== undefined) {
      headers["X-Acting-As"] = this.#actingAs;
    }
    if (this.#delegatedBy !== undefined) {
      headers["X-Delegated-By"] = this.#delegatedBy;
    }
    // Caller-supplied headers win over the SDK defaults (including a pinned
    // X-Request-ID, which we then do not override) (#3213).
    for (const [k, v] of Object.entries(this.#headers)) headers[k] = v;
    if (opts.headers !== undefined) {
      for (const [k, v] of Object.entries(opts.headers)) headers[k] = v;
    }
    const hasRequestId = Object.keys(headers).some((k) => k.toLowerCase() === "x-request-id");
    if (!hasRequestId && typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      headers["X-Request-ID"] = crypto.randomUUID();
    }

    const init: RequestInit = { method, headers, redirect: "manual" };
    if (opts.body !== undefined) {
      // `fetch` accepts `Uint8Array | string | Buffer` as BodyInit. Cast to
      // satisfy the TS lib's narrower union (which omits `Uint8Array<ArrayBuffer>`).
      init["body"] =
        typeof opts.body === "string"
          ? opts.body
          : (opts.body as unknown as BodyInit);
    }

    const response = await this.#fetch(url, init);
    assertNotRedirected(response, url);
    const buf = await response.arrayBuffer();
    const respHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v;
    });
    return {
      status: response.status,
      headers: respHeaders,
      body: new Uint8Array(buf),
    };
  }

  // -------------------------------------------------------------------------
  // Convenience wrappers for the most common S3 verbs
  // -------------------------------------------------------------------------

  /**
   * `GET /` — list buckets. Returns the raw XML body (the server's
   * `ListBucketsResult`).
   */
  async listBuckets(): Promise<S3HttpResponse> {
    return this.http("GET", "/");
  }

  /**
   * `PUT /<bucket>` — create a bucket.
   */
  async createBucket(bucket: string): Promise<S3HttpResponse> {
    return this.http("PUT", `/${bucket}`);
  }

  /**
   * `PUT /<bucket>/<key>` — upload an object. Returns the response (ETag
   * is in `headers["etag"]`).
   */
  async putObject(
    bucket: string,
    key: string,
    body: Uint8Array | string,
    opts: { contentType?: string } = {},
  ): Promise<S3HttpResponse> {
    const headers: Record<string, string> = {};
    if (opts.contentType !== undefined) headers["Content-Type"] = opts.contentType;
    return this.http("PUT", `/${bucket}/${key}`, { body, headers });
  }

  /**
   * `GET /<bucket>/<key>` — download an object. Body is on `.body` (bytes).
   */
  async getObject(bucket: string, key: string): Promise<S3HttpResponse> {
    return this.http("GET", `/${bucket}/${key}`);
  }

  /**
   * `DELETE /<bucket>/<key>` — delete an object.
   */
  async deleteObject(bucket: string, key: string): Promise<S3HttpResponse> {
    return this.http("DELETE", `/${bucket}/${key}`);
  }
}
