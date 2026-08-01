/**
 * Governance SDK — rules, retention, breakglass, alerts, DSAR (#74).
 *
 * A thin governed wrapper over the server's HTTP surface so a TypeScript
 * operator can:
 * - Define and manage detection rules (including Sigma rule ingestion).
 * - Place and lift legal holds; configure WORM retention per object type.
 * - Request and approve emergency HUMINT breakglass access (4h, two-person).
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
 * const rule = await gov.createRule({ name: "big-transfer", object_type: "Transaction", condition: "amount_usd > 1000000", action: "alert" });
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
 * Governance surface — rules / retention / breakglass / alerts / DSAR.
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
   * Wraps `GET /rules`.
   */
  async listRules(
    opts: { objectType?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    const path = `/rules${qs({ object_type: opts.objectType })}`;
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
   * Create a detection rule. The `rule` shape matches the server's
   * `RuleSpec` (`name`, `object_type`, `condition`, `action`, ...).
   * Wraps `POST /rules?purpose=<p>`. Returns the created rule record
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
    return this._post(`/rules${qs({ purpose })}`, rule);
  }

  /**
   * Disable (logically delete) a rule by id.
   * Wraps `DELETE /rules/:id`.
   */
  async disableRule(ruleId: string): Promise<Record<string, unknown>> {
    return this._delete(`/rules/${encodeURIComponent(ruleId)}`);
  }

  /**
   * Import a Sigma rule (YAML string).
   * Wraps `POST /rules/sigma?purpose=<p>`. Returns the import summary
   * (`rules_imported`, `rules_skipped`, `errors`).
   *
   * The server requires `purpose` as a query param and the raw YAML text as
   * the request body — not a JSON envelope.
   */
  async importSigma(
    sigmaYaml: string,
    opts: { purpose?: string } = {},
  ): Promise<Record<string, unknown>> {
    const purpose = this.#effectivePurpose(opts.purpose);
    return this._sendRaw(
      "POST",
      `/rules/sigma${qs({ purpose })}`,
      sigmaYaml,
      "application/x-yaml",
    );
  }

  /** Temporarily disable a rule for `durationSecs` (#967). */
  async snoozeRule(
    ruleId: string,
    durationSecs: number,
  ): Promise<Record<string, unknown>> {
    return this._post(`/rules/${encodeURIComponent(ruleId)}/snooze`, {
      duration_secs: durationSecs,
    });
  }

  /**
   * Permanently suppress future matches of the rule for a specific entity
   * (#967). `condition` is an optional informational note.
   */
  async suppressRule(
    ruleId: string,
    entityId: string,
    opts: { condition?: string } = {},
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { entity_id: entityId };
    if (opts.condition !== undefined) body["condition"] = opts.condition;
    return this._post(`/rules/${encodeURIComponent(ruleId)}/suppress`, body);
  }

  /** Add an exception entry so specific matches are ignored (#967). */
  async addRuleException(
    ruleId: string,
    exception: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this._post(`/rules/${encodeURIComponent(ruleId)}/exceptions`, exception);
  }

  /** Retrieve tuning state (snoozes, suppressions, exceptions) (#967). */
  async getRuleTuning(ruleId: string): Promise<Record<string, unknown>> {
    return this._get(`/rules/${encodeURIComponent(ruleId)}/tuning`);
  }

  // -------------------------------------------------------------------------
  // Retention (#74)
  // -------------------------------------------------------------------------

  /**
   * List configured retention policies.
   * Wraps `GET /retention/policies`.
   */
  async listRetentionPolicies(): Promise<Record<string, unknown>[]> {
    const data = await this._get<Record<string, unknown>>("/retention/policies");
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
   * Wraps `GET /retention/holds`.
   */
  async listLegalHolds(): Promise<Record<string, unknown>[]> {
    const data = await this._get<Record<string, unknown>>("/retention/holds");
    const holds =
      typeof data === "object" && data !== null && Array.isArray(data["holds"])
        ? data["holds"]
        : Array.isArray(data)
          ? data
          : [];
    return holds as Record<string, unknown>[];
  }

  /**
   * Place a legal hold on `objectType` (optionally on a specific row).
   * Wraps `POST /retention/holds`.
   *
   * @param caseId   Caller-supplied case identifier (becomes the hold id).
   * @param objectType Type to hold.
   * @param objectId Optional specific row id; omit for type-wide hold.
   * @param reason   Optional human-friendly reason.
   */
  async placeLegalHold(
    caseId: string,
    objectType: string,
    opts: {
      objectId?: string;
      reason?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      case_id: caseId,
      object_type: objectType,
    };
    if (opts.objectId !== undefined) payload["object_id"] = opts.objectId;
    if (opts.reason !== undefined) payload["reason"] = opts.reason;
    return this._post("/retention/holds", payload);
  }

  /**
   * Lift (remove) a legal hold by case id.
   * Wraps `DELETE /retention/holds/:caseId`.
   */
  async liftLegalHold(
    caseId: string,
  ): Promise<Record<string, unknown>> {
    return this._delete(`/retention/holds/${encodeURIComponent(caseId)}`);
  }

  /**
   * List WORM (write-once-read-many) retention policies.
   * Wraps `GET /retention/worm`.
   */
  async listWormPolicies(): Promise<Record<string, unknown>[]> {
    const data = await this._get<Record<string, unknown>>("/retention/worm");
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
   * Wraps `POST /retention/worm/:objectType`.
   */
  async setWormPolicy(
    objectType: string,
    retentionSecs: number,
  ): Promise<Record<string, unknown>> {
    return this._post(
      `/retention/worm/${encodeURIComponent(objectType)}`,
      { retention_secs: retentionSecs },
    );
  }

  // -------------------------------------------------------------------------
  // Breakglass (#74)
  // -------------------------------------------------------------------------

  /**
   * Request emergency HUMINT breakglass access (default 4h).
   * Wraps `POST /humint/breakglass/request`. Returns the request record
   * including `request_id` and `status`. Approval requires two distinct
   * officers ({@link approveBreakglass}).
   */
  async requestBreakglass(
    reason: string,
    opts: {
      scope?: string;
      durationSecs?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      reason,
      duration_secs: opts.durationSecs ?? 4 * 60 * 60,
    };
    if (opts.scope !== undefined) payload["scope"] = opts.scope;
    return this._post("/humint/breakglass/request", payload);
  }

  /**
   * Approve a breakglass request (second-officer sign-off).
   * Wraps `POST /humint/breakglass/approve`. The server enforces: requester
   * cannot approve their own request, the approver must belong to the same
   * tenant, and two distinct approvals are required before access is granted.
   */
  async approveBreakglass(
    requestId: string,
    opts: { approverNote?: string } = {},
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { request_id: requestId };
    if (opts.approverNote !== undefined) payload["note"] = opts.approverNote;
    return this._post("/humint/breakglass/approve", payload);
  }

  /**
   * Look up the status of a breakglass request.
   * Wraps `GET /humint/breakglass/status/:requestId`.
   */
  async breakglassStatus(
    requestId: string,
  ): Promise<Record<string, unknown>> {
    return this._get(
      `/humint/breakglass/status/${encodeURIComponent(requestId)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Alerts (#74)
  // -------------------------------------------------------------------------

  /**
   * List alerts, optionally filtered by severity / since-cursor.
   * Wraps `GET /alerts/list`.
   */
  async listAlerts(
    opts: {
      severity?: string;
      sinceNs?: number;
      limit?: number;
    } = {},
  ): Promise<Record<string, unknown>[]> {
    const path = `/alerts/list${qs({
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
   * Wraps `PATCH /alerts/update/:alertId`.
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
      `/alerts/update/${encodeURIComponent(alertId)}`,
      payload,
    );
  }

  // -------------------------------------------------------------------------
  // DSAR (#74, #79)
  // -------------------------------------------------------------------------

  /**
   * File a GDPR Data Subject Access Request.
   * Wraps `GET /gdpr/dsar`.
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
    const path = `/gdpr/dsar${qs({
      subject_identity: subjectIdentity,
      reason,
      scope: opts.scope,
    })}`;
    return this._get(path);
  }
}
