/**
 * Governance SDK — rules, retention, alerts, DSAR (#74).
 *
 * A thin governed wrapper over the server's HTTP surface so a TypeScript
 * operator can:
 * - Define and manage prepared detection rules.
 * - Place and lift legal holds; configure WORM retention per object type.
 * - List and ack alerts.
 * - File a GDPR Data Subject Access Request.
 *
 * Every call carries the caller's tenant header (inherited from the parent
 * `RelataClient` via `fromClient`); governance is on by default.
 *
 * ```typescript
 * import { createClient, GovernanceClient } from "@zysec-ai/relata-sdk";
 *
 * const relata = createClient("http://localhost:9090", {
 *   bearerToken: process.env.RELATA_TOKEN!,
 *   defaultPurpose: "compliance",
 *   tenant: "acme",
 * });
 * const gov = GovernanceClient.fromClient(relata);
 * const rule = await gov.createRule({ name: "big-transfer", condition_sql: "amount_usd > 1000000", target_type: "Transaction", severity: "high" });
 * const hold = await gov.placeLegalHold("case-42", "Person");
 * ```
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase, qs } from "./_typed-http.ts";
import { PurposeError } from "./errors.ts";

// ---------------------------------------------------------------------------
// GovernanceClient
// ---------------------------------------------------------------------------

/** Options inherited from the parent client. */
export interface GovernanceClientCtor extends TypedClientCtor {
  /** Default purpose attached to calls that require one, when not overridden per-call. */
  purpose?: string;
}

/**
 * Governance surface — rules / retention / alerts / DSAR.
 * Construct via `GovernanceClient.fromClient(relata)` to inherit the parent
 * client's auth + tenant context.
 */
export class GovernanceClient extends TypedClientBase {
  readonly #purpose: string | undefined;

  /**
   * Construct a governance client directly. Most callers should use
   * {@link GovernanceClient.fromClient} instead.
   */
  constructor(opts: GovernanceClientCtor) {
    super(opts);
    this.#purpose = opts.purpose;
  }

  /** Inherit the parent client's auth, tenant, purpose, and headers. */
  static fromClient(client: RelataClient): GovernanceClient {
    const ctor = TypedClientBase.clientToCtor(client);
    const govCtor: GovernanceClientCtor = { ...ctor };
    if (client.defaultPurpose !== undefined) govCtor.purpose = client.defaultPurpose;
    return new GovernanceClient(govCtor);
  }

  /** @internal Resolve the effective purpose or throw. */
  #effectivePurpose(purpose: string | undefined): string {
    const eff = purpose ?? this.#purpose;
    if (!eff) {
      throw new PurposeError(
        undefined,
        "This governance call requires a purpose. Pass `purpose` to the " +
          "call or set `defaultPurpose` on the RelataClient.",
      );
    }
    return eff;
  }

  // -------------------------------------------------------------------------
  // Rules (#74)
  // -------------------------------------------------------------------------

  /**
   * List detection rules. Optional `objectType` filter.
   * Wraps `GET /v1/rules`.
   */
  async listRules(
    opts: { objectType?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    const path = `/v1/rules${qs({ object_type: opts.objectType })}`;
    const data = await this._get<Record<string, unknown>>(path);
    const rules =
      typeof data === "object" && data !== null && Array.isArray(data["rules"])
        ? data["rules"]
        : Array.isArray(data)
          ? data
          : [];
    return rules as Record<string, unknown>[];
  }

  /**
   * Create a prepared detection rule. The server requires `name`,
   * `condition_sql`, and `target_type`; it accepts optional `severity`,
   * `mitre_technique`, `trigger`, and `action` fields.
   * Wraps `POST /v1/rules?purpose=<p>`. Returns the created rule record
   * including its server-assigned `id`.
   *
   * `purpose` is mandatory server-side — pass it here or via the client
   * default.
   */
  async createRule(
    rule: Record<string, unknown>,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const purpose = this.#effectivePurpose(opts.purpose);
    return this._post(`/v1/rules${qs({ purpose })}`, rule);
  }

  /**
   * Disable (logically delete) a rule by id.
   * Wraps `DELETE /v1/rules/:id`.
   */
  async disableRule(ruleId: string): Promise<Record<string, unknown>> {
    return this._delete(`/v1/rules/${encodeURIComponent(ruleId)}`);
  }

  /** Temporarily disable a rule for `durationSecs` (#967). */
  async snoozeRule(
    ruleId: string,
    durationSecs: number,
  ): Promise<Record<string, unknown>> {
    return this._post(`/v1/rules/${encodeURIComponent(ruleId)}/snooze`, {
      duration_secs: durationSecs,
    });
  }

  /**
   * Suppress future matches of the rule for one entity, for `durationSecs`
   * (admin-only; the server answers 400 without a positive `duration_secs`
   * because suppressions expire, #3197). `reason` is recorded with the audit
   * entry; `condition` is an optional informational note.
   */
  async suppressRule(
    ruleId: string,
    entityId: string,
    opts: { condition?: string; durationSecs?: number; reason?: string } = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { entity_id: entityId };
    if (opts.condition !== undefined) body["condition"] = opts.condition;
    if (opts.durationSecs !== undefined) body["duration_secs"] = opts.durationSecs;
    if (opts.reason !== undefined) body["reason"] = opts.reason;
    return this._post(`/v1/rules/${encodeURIComponent(ruleId)}/suppress`, body);
  }

  /** Add an exception entry so specific matches are ignored (#967). */
  async addRuleException(
    ruleId: string,
    exception: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._post(`/v1/rules/${encodeURIComponent(ruleId)}/exceptions`, exception);
  }

  /** Retrieve tuning state (snoozes, suppressions, exceptions) (#967). */
  async getRuleTuning(ruleId: string): Promise<Record<string, unknown>> {
    return this._get(`/v1/rules/${encodeURIComponent(ruleId)}/tuning`);
  }

  /** Fetch one detection rule by id (`GET /v1/rules/:id`). */
  async getRule(ruleId: string): Promise<Record<string, unknown>> {
    return this._get(`/v1/rules/${encodeURIComponent(ruleId)}`);
  }

  /** Remove a tuning exception (`DELETE /v1/rules/:id/exceptions/:eid`). */
  async removeRuleException(
    ruleId: string,
    exceptionId: string,
  ): Promise<Record<string, unknown>> {
    return this._delete(
      `/v1/rules/${encodeURIComponent(ruleId)}/exceptions/${encodeURIComponent(exceptionId)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Retention (#74)
  // -------------------------------------------------------------------------

  /**
   * Set a retention policy for a type (`POST /v1/retention/policies`).
   * `action` is `"delete"` (default) or `"tier:cold"`.
   */
  async setRetentionPolicy(
    objectType: string,
    maxAgeDays: number,
    action = "delete",
  ): Promise<Record<string, unknown>> {
    return this._post("/v1/retention/policies", {
      object_type: objectType,
      max_age_days: maxAgeDays,
      action,
    });
  }

  /**
   * List configured retention policies.
   * Wraps `GET /v1/retention/policies`.
   */
  async listRetentionPolicies(): Promise<Record<string, unknown>[]> {
    const data = await this._get<Record<string, unknown>>("/v1/retention/policies");
    // Live shape: `{worm_types: ["TypeA", ...], total}`; older shape `{policies: [...]}`.
    if (typeof data === "object" && data !== null && Array.isArray(data["worm_types"])) {
      return (data["worm_types"] as unknown[]).map((t) =>
        typeof t === "string" ? { type_name: t } : (t as Record<string, unknown>),
      );
    }
    const policies =
      typeof data === "object" && data !== null && Array.isArray(data["policies"])
        ? data["policies"]
        : Array.isArray(data)
          ? data
          : [];
    return policies as Record<string, unknown>[];
  }

  /**
   * List active legal holds.
   * Wraps `GET /v1/retention/holds`.
   */
  async listLegalHolds(): Promise<Record<string, unknown>[]> {
    const data = await this._get<Record<string, unknown>>("/v1/retention/holds");
    const holds =
      typeof data === "object" && data !== null && Array.isArray(data["holds"])
        ? data["holds"]
        : Array.isArray(data)
          ? data
          : [];
    return holds as Record<string, unknown>[];
  }

  /**
   * Place a legal hold on `objectType` (optionally scoped to rows where
   * `field` equals `value`). Wraps `POST /v1/retention/holds`.
   *
   * @param caseId   Caller-supplied case identifier (becomes the hold id).
   * @param objectType Type to hold.
   * @param field    Optional column name to scope the hold to; pass both
   *                 `field` and `value` together, or omit both for a
   *                 type-wide hold. The server only reads
   *                 `case_id`/`object_type`/`field`/`value` — any other key
   *                 is silently ignored (#2465).
   * @param value    Column value to match when `field` is set.
   */
  async placeLegalHold(
    caseId: string,
    objectType: string,
    opts: {
      field?: string;
      value?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      case_id: caseId,
      object_type: objectType,
    };
    if (opts.field !== undefined) payload["field"] = opts.field;
    if (opts.value !== undefined) payload["value"] = opts.value;
    return this._post("/v1/retention/holds", payload);
  }

  /**
   * Lift (remove) a legal hold by case id.
   * Wraps `DELETE /v1/retention/holds/:caseId`.
   */
  async liftLegalHold(
    caseId: string,
  ): Promise<Record<string, unknown>> {
    return this._delete(`/v1/retention/holds/${encodeURIComponent(caseId)}`);
  }

  /**
   * List WORM (write-once-read-many) retention policies.
   * Wraps `GET /v1/retention/worm`.
   */
  async listWormPolicies(): Promise<Record<string, unknown>[]> {
    const data = await this._get<Record<string, unknown>>("/v1/retention/worm");
    // Live shape: `{worm_types: ["TypeA", ...], total}`; older shape `{policies: [...]}`.
    if (typeof data === "object" && data !== null && Array.isArray(data["worm_types"])) {
      return (data["worm_types"] as unknown[]).map((t) =>
        typeof t === "string" ? { type_name: t } : (t as Record<string, unknown>),
      );
    }
    const policies =
      typeof data === "object" && data !== null && Array.isArray(data["policies"])
        ? data["policies"]
        : Array.isArray(data)
          ? data
          : [];
    return policies as Record<string, unknown>[];
  }

  /**
   * Set WORM retention for `objectType`. Rows cannot be mutated or purged
   * until `retentionSecs` elapses from their `system_from`.
   * Wraps `POST /v1/retention/worm/:objectType`.
   */
  async setWormPolicy(
    objectType: string,
    retentionSecs: number,
  ): Promise<Record<string, unknown>> {
    return this._post(
      `/v1/retention/worm/${encodeURIComponent(objectType)}`,
      { retention_secs: retentionSecs },
    );
  }

  // -------------------------------------------------------------------------
  // Alerts (#74)
  // -------------------------------------------------------------------------

  /**
   * List alerts, optionally filtered by severity / since-cursor.
   * Wraps `GET /v1/alerts`.
   */
  async listAlerts(
    opts: {
      severity?: string;
      sinceNs?: number;
      limit?: number;
    } = {},
  ): Promise<Record<string, unknown>[]> {
    const path = `/v1/alerts${qs({
      severity: opts.severity,
      since_ns: opts.sinceNs,
      limit: opts.limit ?? 100,
    })}`;
    const data = await this._get<Record<string, unknown>>(path);
    const alerts =
      typeof data === "object" && data !== null && Array.isArray(data["alerts"])
        ? data["alerts"]
        : Array.isArray(data)
          ? data
          : [];
    return alerts as Record<string, unknown>[];
  }

  /**
   * Update an alert (ack, assign, close, add a note).
   * Wraps `PATCH /v1/alerts/:alertId`.
   */
  async updateAlert(
    alertId: string,
    opts: {
      status?: string;
      assignee?: string;
      note?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {};
    if (opts.status !== undefined) payload["status"] = opts.status;
    if (opts.assignee !== undefined) payload["assignee"] = opts.assignee;
    if (opts.note !== undefined) payload["note"] = opts.note;
    return this._patch(
      `/v1/alerts/${encodeURIComponent(alertId)}`,
      payload,
    );
  }

  // -------------------------------------------------------------------------
  // DSAR (#74, #79)
  // -------------------------------------------------------------------------

  /**
   * File a GDPR Data Subject Access Request.
   * Wraps `GET /v1/gdpr/dsar`.
   *
   * @param subjectIdentity Canonical identifier of the subject
   *        (email, phone, national id, ...).
   * @param reason   Grounds for the request (`"gdpr-art-15"`, `"court-order"`, ...).
   * @param scope    Optional scope filter (`"email"`, `"financial"`, ...).
   */
  async submitDsar(
    subjectIdentity: string,
    reason: string,
    opts: { scope?: string } = {},
  ): Promise<Record<string, unknown>> {
    const path = `/v1/gdpr/dsar${qs({
      // The server's `GET /v1/gdpr/dsar` reads the subject from `subject`.
      subject: subjectIdentity,
      reason,
      scope: opts.scope,
    })}`;
    return this._get(path);
  }

  /**
   * File a GDPR erasure for `subjectId`. Wraps `POST /v1/gdpr/erase` and
   * returns the receipt / operation response.
   *
   * @param opts.reason   Recorded on the erasure receipt.
   * @param opts.tenantId Tenant to erase from (unscoped admin callers only).
   * @param opts.physical Request physical erasure in addition to the logical tombstone.
   */
  async erase(
    subjectId: string,
    opts: { reason?: string; tenantId?: string; physical?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { subject_id: subjectId };
    if (opts.reason) payload["reason"] = opts.reason;
    if (opts.tenantId) payload["tenant_id"] = opts.tenantId;
    if (opts.physical) payload["physical"] = true;
    return this._post("/v1/gdpr/erase", payload);
  }

  /** Progress of a deletion operation. Wraps `GET /v1/gdpr/deletions/:operationId`. */
  async deletionStatus(operationId: string): Promise<Record<string, unknown>> {
    return this._get(`/v1/gdpr/deletions/${encodeURIComponent(operationId)}`);
  }

  /**
   * Verify a signed erasure receipt. Wraps `POST /v1/gdpr/verify-receipt`.
   * `receipt` carries `receipt_id`, `subject`, `erased_at`, `rows_shredded`
   * and `receipt_signature` exactly as returned by {@link erase}.
   */
  async verifyReceipt(receipt: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._post("/v1/gdpr/verify-receipt", receipt);
  }
}
