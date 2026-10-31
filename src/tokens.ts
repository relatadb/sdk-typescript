/**
 * Tenant self-service API-token SDK.
 *
 * Wraps `GET /v1/auth/tokens/self`, `GET /v1/auth/tokens/self/audit`,
 * `POST /v1/auth/tokens/self/rotate` and `DELETE /v1/auth/tokens/self/:id`.
 * (The legacy dedup-token routes under `/tokens` were removed.)
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

/** Tenant self-service token client. */
export class TokenClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): TokenClient {
    return new TokenClient(TypedClientBase.clientToCtor(client));
  }

  /** List the caller's own tokens. Wraps `GET /v1/auth/tokens/self`. */
  async listSelf(): Promise<Record<string, unknown>> {
    return this._get("/v1/auth/tokens/self");
  }

  /** Audit trail of the caller's own tokens. Wraps `GET /v1/auth/tokens/self/audit`. */
  async selfAudit(): Promise<Record<string, unknown>> {
    return this._get("/v1/auth/tokens/self/audit");
  }

  /**
   * Rotate the caller's token, returning the replacement secret.
   * Wraps `POST /v1/auth/tokens/self/rotate`.
   */
  async rotateSelf(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this._post("/v1/auth/tokens/self/rotate", body);
  }

  /** Revoke one of the caller's own tokens. Wraps `DELETE /v1/auth/tokens/self/:id`. */
  async revokeSelf(tokenId: string): Promise<Record<string, unknown>> {
    return this._delete(`/v1/auth/tokens/self/${encodeURIComponent(tokenId)}`);
  }
}
