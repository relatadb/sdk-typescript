/**
 * Backup / restore / PITR SDK (#88 — server routes now shipped).
 *
 * Wraps `POST /admin/backup`, `GET /admin/backups`,
 * `POST /admin/restore`, `GET /admin/restore/:id`. All routes require admin
 * auth.
 */

import { RelataClient } from "./client.ts";
import { type TypedClientCtor, TypedClientBase } from "./_typed-http.ts";

/** A backup snapshot reference. */
export interface BackupRef {
  snapshotId: string;
  kind: string;
  writtenAtNs: number;
  sizeBytes: number;
  sha256: string;
  rowCount: number;
  path: string;
}

/** Restore job status. */
export interface RestoreStatus {
  restoreId: string;
  snapshotId: string;
  status: string;
  rtoActualSecs: number;
  error: string | undefined;
}

/** Coerce a raw wire record into a `BackupRef`. */
function toBackupRef(raw: Record<string, unknown>): BackupRef {
  return {
    snapshotId: String(raw["snapshot_id"] ?? ""),
    kind: String(raw["kind"] ?? "full"),
    writtenAtNs: Number(raw["written_at_ns"] ?? 0),
    sizeBytes: Number(raw["size_bytes"] ?? 0),
    sha256: String(raw["sha256"] ?? ""),
    rowCount: Number(raw["row_count"] ?? 0),
    path: String(raw["path"] ?? ""),
  };
}

/** Coerce a raw wire record into a `RestoreStatus`. */
function toRestoreStatus(raw: Record<string, unknown>): RestoreStatus {
  return {
    restoreId: String(raw["restore_id"] ?? ""),
    snapshotId: String(raw["snapshot_id"] ?? ""),
    status: String(raw["status"] ?? "unknown"),
    rtoActualSecs: Number(raw["rto_actual_secs"] ?? 0),
    error:
      typeof raw["error"] === "string" ? raw["error"] : undefined,
  };
}

/** Backup / restore client (admin-auth required). */
export class BackupClient extends TypedClientBase {
  constructor(opts: TypedClientCtor) {
    super(opts);
  }

  /** Inherit the parent client's auth, tenant, and headers. */
  static fromClient(client: RelataClient): BackupClient {
    return new BackupClient(TypedClientBase.clientToCtor(client));
  }

  /**
   * Trigger a backup. `kind` is `"full"` (default) or `"incremental"`.
   * Wraps `POST /admin/backup`. Returns a {@link BackupRef}.
   */
  async create(
    opts: { kind?: string; tenant?: string } = {},
  ): Promise<BackupRef> {
    const payload: Record<string, unknown> = { kind: opts.kind ?? "full" };
    if (opts.tenant !== undefined) payload["tenant"] = opts.tenant;
    const resp = await this._post<Record<string, unknown>>("/admin/backup", payload);
    return toBackupRef(resp);
  }

  /** List all backup snapshots. Wraps `GET /admin/backups`. */
  async list(): Promise<BackupRef[]> {
    const resp = await this._get<Record<string, unknown>>("/admin/backups");
    const rawList =
      typeof resp === "object" && resp !== null && Array.isArray(resp["backups"])
        ? resp["backups"]
        : Array.isArray(resp)
          ? resp
          : [];
    return (rawList as Record<string, unknown>[]).map(toBackupRef);
  }

  /**
   * Trigger a restore from `snapshotId`.
   * Wraps `POST /admin/restore`. Returns the `restoreId` (job runs
   * asynchronously; poll via {@link restoreStatus}).
   */
  async restore(
    snapshotId: string,
    opts: { tenant?: string; pointInTimeNs?: number } = {},
  ): Promise<string> {
    const payload: Record<string, unknown> = { snapshot_id: snapshotId };
    if (opts.tenant !== undefined) payload["tenant"] = opts.tenant;
    if (opts.pointInTimeNs !== undefined) payload["point_in_time_ns"] = opts.pointInTimeNs;
    const resp = await this._post<Record<string, unknown>>("/admin/restore", payload);
    return String(resp["restore_id"] ?? "");
  }

  /** Poll restore job status. Wraps `GET /admin/restore/:restoreId`. */
  async restoreStatus(restoreId: string): Promise<RestoreStatus> {
    const resp = await this._get<Record<string, unknown>>(
      `/admin/restore/${encodeURIComponent(restoreId)}`,
    );
    return toRestoreStatus(resp);
  }

  /** Trigger background compaction of the row store (#967). */
  async compact(): Promise<Record<string, unknown>> {
    return this._post("/admin/compact", {});
  }

  /**
   * Block until the restore completes or fails. Rejects with `Error` if
   * `timeoutMs` elapses.
   *
   * @param restoreId The id returned by {@link restore}.
   * @param opts      `timeoutMs` (default 300_000 = 5 min),
   *                  `pollIntervalMs` (default 2_000).
   */
  async waitForRestore(
    restoreId: string,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<RestoreStatus> {
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    const intervalMs = opts.pollIntervalMs ?? 2_000;
    for (;;) {
      const status = await this.restoreStatus(restoreId);
      if (status.status === "completed" || status.status === "failed") {
        return status;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Restore ${restoreId} did not complete within ${opts.timeoutMs ?? 300_000}ms`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
