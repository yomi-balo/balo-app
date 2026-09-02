import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  requestFileVisibleToTrack,
  resolveRequestFileAudience,
  resolveRequestTrackFileAccess,
  type RequestTrackRef,
  type ResolvedRequestFileAudienceEntry,
} from '@balo/shared/authz';
import { db } from '../client';
import {
  engagements,
  projectEngagements,
  requestExpertRelationships,
  requestFileGrants,
  requestSharedFiles,
} from '../schema';
import type {
  RequestFileAudience,
  RequestFileGrant,
  RequestFileSide,
  RequestSharedFile,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import {
  recordRequestFileAudit,
  type RequestFileAuditCommon,
  type RequestFileAuditTrackRef,
} from './_shared/request-file-audit';

/**
 * request_shared_files + request_file_grants (BAL-431 / ADR-1048) — the FIFTH file scope's
 * data access layer.
 *
 * ⚠ NO AUTHORIZATION LIVES HERE (ADR-1029). The scope gate
 * (`apps/web/src/lib/request-files/authorize-request-file-scope.ts`) runs in the caller and
 * hands this repository an already-proven `projectRequestId`, an already-resolved `side` and,
 * expert-side, an already-resolved `expertRelationshipId`. What DOES live here is the
 * CONTAINMENT half of the IDOR defence: every by-id read and every mutation takes the
 * `projectRequestId` alongside the `fileId`, as a term in the WHERE clause rather than a
 * post-filter, so a file on another request resolves `undefined` identically to a stale uuid.
 * That is the direct replacement for `listFiles(access.conversationId, …)`'s
 * containment-by-conversation, which a request-grain file dissolves.
 *
 * ⚠ TRANSACTION POSTURE — `exec?: DbExecutor` FROM THE FIRST LINE. Every mutating method
 * takes an optional executor and self-wraps `db.transaction(run)` when none is supplied (the
 * `conversationsRepository.ensureForContext` shape). That is what makes ADR-1048 §7's
 * same-transaction audit invariant satisfiable WITHOUT touching a single shipped signature —
 * `conversationsRepository.addFile` / `postMessage` are hard-bound to the module-level `db`,
 * and BAL-431 never calls them.
 *
 * ⚠ NO METHOD HERE CATCHES A RAW `23505` / `23514`. A caught unique-violation aborts the
 * surrounding transaction (`25P02`) and makes the repository untestable — nine of ten
 * downstream assertions then fail as noise (memory
 * `reference_caught_23505_aborts_test_transaction`). `share()` pre-empts what it can in
 * JavaScript and lets the rest surface; the ACTION layer maps a thrown `23505` to copy,
 * exactly as `confirm-case-file-upload.ts` does today.
 */

/** The named file is not a LIVE file of the gate-supplied request (or does not exist). */
export class RequestFileNotFoundError extends Error {
  constructor(fileId: string) {
    super(`Request shared file not found in request: ${fileId}`);
    this.name = 'RequestFileNotFoundError';
  }
}

/**
 * A grant target is CLOSED (declined / withdrawn / not-selected) or is not a track of this
 * request at all. Thrown IN-TRANSACTION, so the whole share rolls back — ADR-1048 §7's
 * "a closed track never gains new visibility", enforced rather than assumed.
 *
 * ⚠ ONE ERROR FOR BOTH CASES, DELIBERATELY. A caller probing with a foreign relationship id
 * learns nothing it did not already supply.
 */
export class RequestFileTrackNotLiveError extends Error {
  constructor(public readonly relationshipId: string) {
    super(`Request track is not live for files: ${relationshipId}`);
    this.name = 'RequestFileTrackNotLiveError';
  }
}

/** No LIVE grant joins this file to this track. */
export class RequestFileGrantNotFoundError extends Error {
  constructor(fileId: string, relationshipId: string) {
    super(`No live grant for file ${fileId} → track ${relationshipId}`);
    this.name = 'RequestFileGrantNotFoundError';
  }
}

/** The file is already a tombstone. Distinct from not-found so the caller can be idempotent. */
export class RequestFileAlreadyDeletedError extends Error {
  constructor(fileId: string) {
    super(`Request shared file already deleted: ${fileId}`);
    this.name = 'RequestFileAlreadyDeletedError';
  }
}

/** One file plus its LIVE grants (revoked grants are soft-deleted and never returned). */
export interface RequestFileWithGrants {
  file: RequestSharedFile;
  grants: RequestFileGrant[];
}

export interface ShareRequestFileInput {
  /** ⚠ THE GATE-VALIDATED request. Never a request-body value. */
  projectRequestId: string;
  /** ATTRIBUTION — who shared it. Survives their departure (`restrict`, ADR-1030). */
  uploadedByUserId: string;
  /** ⚠ THE GATE'S RESOLVED SIDE. The Zod input schema has no `side` key. */
  side: RequestFileSide;
  /** ⚠ DERIVED FROM THE GATE'S SIDE — `'own_track'` is forced for an expert upload. */
  audience: RequestFileAudience;
  /** ⚠ THE GATE'S RESOLVED TRACK for an expert upload; `null` client-side. */
  expertRelationshipId: string | null;
  /** Empty unless `audience === 'grants'`. De-duplicated here before insert. */
  grantRelationshipIds: readonly string[];
  r2Key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface ShareRequestFileResult {
  file: RequestSharedFile;
  grants: RequestFileGrant[];
  /**
   * WHO CAN SEE THIS FILE, resolved inside the share transaction — the set snapshotted into
   * the audit row, and what the caller notifies.
   *
   * ⚠ IT IS THE RESOLVED AUDIENCE FOR EVERY MODE, not only `all_live_tracks`: the live set
   * for `all_live_tracks`, the granted set for `grants`, the single own track for
   * `own_track`. All three come from ONE function (`resolveRequestFileAudience`), which is
   * exactly why the audit snapshot cannot drift from the read rule.
   */
  resolvedLiveTracks: ResolvedRequestFileAudienceEntry[];
}

export interface RevokeRequestFileGrantInput {
  fileId: string;
  /** ⚠ THE GATE-VALIDATED request — the containment term. */
  projectRequestId: string;
  relationshipId: string;
  actorUserId: string;
}

export interface SoftDeleteRequestFileInput {
  fileId: string;
  /** ⚠ THE GATE-VALIDATED request — the containment term. */
  projectRequestId: string;
  actorUserId: string;
}

export interface SoftDeleteRequestFileResult {
  file: RequestSharedFile;
  /**
   * Returned so the CALLER performs the best-effort, prefix-guarded R2 object delete AFTER
   * COMMIT. ⚠ The object delete must never happen inside the transaction: a rollback would
   * leave a live row pointing at deleted bytes.
   */
  r2Key: string;
  /** RULING 1's snapshot — the resolved audience as of the delete, for the audit row. */
  resolvedAudience: ResolvedRequestFileAudienceEntry[];
}

/**
 * ⚠ THE BOUND ON {@link requestSharedFilesRepository.listForRequest} — the
 * `MEETING_FILE_LIST_LIMIT` ruling, copied. A request's shared files are a handful of briefs
 * and specs, not a corpus; without a bound, one request accumulating thousands of rows would
 * pull every row AND EVERY `r2_key` into a Server Action's memory on each render.
 *
 * ⚠ IT IS A CAP, NOT PAGINATION, AND TRUNCATION MUST NEVER BE SILENT. The order is
 * oldest-first, so a truncated list drops the NEWEST files. THE CALLER MUST `log.warn` when
 * the returned count equals this cap (`list-meeting-files.ts` is the shipped precedent) —
 * that obligation is the loader's, and it matters most on the ADMIN lens, where silent
 * truncation of an oversight view would be a defect. When a real corpus arrives, add keyset
 * pagination on `request_shared_file_request_idx`, never a bigger number.
 */
export const REQUEST_SHARED_FILE_LIST_LIMIT = 200;

// ── Internal reads ─────────────────────────────────────────────────────

/**
 * Every LIVE track of a request, with its file-plane standing resolved through the ONE shared
 * predicate (`@balo/shared/authz`).
 *
 * ⚠ WITHDRAWN TRACKS NEVER APPEAR. Withdrawal is a soft delete, not a status, and this read
 * filters `deleted_at IS NULL` — so a withdrawn track is absent from the resolved audience
 * entirely rather than present-and-closed. `deleted_at` is still SELECTED so the row honestly
 * satisfies `RequestTrackFileStanding`; the predicate stays correct if the filter is ever
 * relaxed for an admin lens.
 */
async function loadTrackRefs(
  exec: DbExecutor,
  projectRequestId: string,
  opts?: { lockForShare?: boolean }
): Promise<RequestTrackRef[]> {
  const base = exec
    .select({
      relationshipId: requestExpertRelationships.id,
      expertProfileId: requestExpertRelationships.expertProfileId,
      status: requestExpertRelationships.status,
      declinedAt: requestExpertRelationships.declinedAt,
      deletedAt: requestExpertRelationships.deletedAt,
      notSelectedAt: requestExpertRelationships.notSelectedAt,
    })
    .from(requestExpertRelationships)
    .where(
      and(
        eq(requestExpertRelationships.projectRequestId, projectRequestId),
        isNull(requestExpertRelationships.deletedAt)
      )
    )
    // ⚠ DETERMINISTIC ORDER, and it is not cosmetic: this list's order IS the order of the
    // `resolvedLiveTracks` / `resolvedAudienceAtDelete` array written into `audit_events`,
    // which is APPEND-ONLY (Ruling 4). `invited_at` defaults to `now()` and is therefore
    // IDENTICAL for every track seeded in one transaction, so `id` is the real tiebreaker.
    .orderBy(asc(requestExpertRelationships.invitedAt), asc(requestExpertRelationships.id));

  /**
   * ⚠⚠ `SELECT … FOR SHARE` — THE CLOSED-TRACK INVARIANT IS A WRITE-SKEW TARGET WITHOUT IT.
   *
   * postgres-js runs `READ COMMITTED`. A plain `SELECT` here takes no lock, and the
   * `INSERT` into `request_file_grants` touches a DIFFERENT table from the one
   * `markNotSelectedByAward` / `advanceRelationshipStatus` update — so a share that
   * re-validated its targets as LIVE and a concurrent closure of one of those very tracks do
   * not conflict, and BOTH COMMIT. The result is a live grant created after its track closed,
   * which `requestFileVisibleToTrack` then honours UNCONDITIONALLY — precisely because "every
   * grant is pre-closure by construction". This lock is that construction.
   *
   * `FOR SHARE` (not `FOR UPDATE`): concurrent shares must not serialise against each other,
   * only against a writer of these rows. `UPDATE … SET declined_at/not_selected_at` takes a
   * conflicting row lock, so one side waits and then observes the other's committed state.
   *
   * Taken ONLY on the write paths (`share`, `softDelete` — whose audit snapshot is
   * append-only and unrecoverable if wrong, per Ruling 4). Read paths lock nothing.
   */
  const rows = await (opts?.lockForShare === true ? base.for('share') : base);

  return rows.map((row) => ({
    relationshipId: row.relationshipId,
    expertProfileId: row.expertProfileId,
    access: resolveRequestTrackFileAccess(row),
  }));
}

/** LIVE grants for a set of file ids, grouped by file id. */
async function loadLiveGrantsByFile(
  exec: DbExecutor,
  fileIds: readonly string[]
): Promise<Map<string, RequestFileGrant[]>> {
  const byFile = new Map<string, RequestFileGrant[]>();
  if (fileIds.length === 0) return byFile;

  const rows = await exec
    .select()
    .from(requestFileGrants)
    .where(
      and(inArray(requestFileGrants.fileId, [...fileIds]), isNull(requestFileGrants.deletedAt))
    )
    // `created_at` defaults to `now()`, which is the TRANSACTION timestamp — every grant
    // written by one `share()` shares it. `id` is the tiebreaker that makes the order stable.
    .orderBy(asc(requestFileGrants.createdAt), asc(requestFileGrants.id));

  for (const row of rows) {
    const bucket = byFile.get(row.fileId);
    if (bucket === undefined) byFile.set(row.fileId, [row]);
    else bucket.push(row);
  }
  return byFile;
}

/** The `metadata` keys every one of the four audit actions carries (Ruling 4). */
function auditCommonFor(file: RequestSharedFile): RequestFileAuditCommon {
  return {
    projectRequestId: file.projectRequestId,
    fileName: file.fileName,
    side: file.side,
    audience: file.audience,
  };
}

/**
 * ⚠ PRE-EMPTS THE `request_shared_file_side_shape` CHECK IN JAVASCRIPT — it does NOT replace
 * it. The database remains the enforcer; this throws BEFORE any statement runs so a
 * programming error cannot abort a CALLER-SUPPLIED ambient transaction with a raw `23514`
 * (memory `reference_caught_23505_aborts_test_transaction` — the same failure mode).
 */
function assertShareShape(input: ShareRequestFileInput): void {
  const expertShape =
    input.side === 'expert' &&
    input.audience === 'own_track' &&
    input.expertRelationshipId !== null;
  const clientShape =
    input.side === 'client' &&
    (input.audience === 'all_live_tracks' || input.audience === 'grants') &&
    input.expertRelationshipId === null;

  if (!expertShape && !clientShape) {
    throw new Error(
      `Incoherent request file share shape: side=${input.side} audience=${input.audience} ` +
        `expertRelationshipId=${input.expertRelationshipId === null ? 'null' : 'set'}`
    );
  }
  if (input.audience !== 'grants' && input.grantRelationshipIds.length > 0) {
    throw new Error(`grantRelationshipIds supplied for audience=${input.audience}`);
  }
}

export const requestSharedFilesRepository = {
  /**
   * THE SHARE WRITE. One transaction: insert the file, insert N grants, write the audit
   * row(s).
   *
   * ⚠ THE AUDIENCE SNAPSHOT IS TAKEN INSIDE THIS TRANSACTION, not passed in by the caller —
   * a caller-resolved set can drift between gate and commit, and Ruling 4 makes that snapshot
   * unrecoverable if wrong (`audit_events` is append-only).
   *
   * ⚠ `side`, `audience` and `expertRelationshipId` are the GATE's resolved values. There is
   * no code path from a request body to any of them (the `meeting_files.party` rule).
   *
   * Grant targets are re-validated IN-TRANSACTION against `requestTrackIsLiveForFiles`; a
   * closed (or foreign) target throws {@link RequestFileTrackNotLiveError} and rolls the whole
   * thing back — ADR-1048 §7: "a closed track never gains new visibility".
   *
   * Duplicate ids in `grantRelationshipIds` are DE-DUPLICATED rather than allowed to raise a
   * `23505` against the partial unique — see the class docblock on why nothing here catches
   * one.
   *
   * AUDIT (Ruling 4's contract, §5.7):
   *   · `all_live_tracks` → ONE `request_shared_file.shared_all_tracks` carrying the resolved
   *     live set at share time.
   *   · `grants`          → ONE `request_shared_file.grant_added` PER GRANT ROW.
   *   · `own_track`       → NONE, deliberately. An expert's own-track upload is not an
   *     access-boundary DECISION: the row itself is the complete record and the audience is
   *     structurally fixed by the CHECK. See `_shared/request-file-audit.ts`.
   */
  async share(input: ShareRequestFileInput, exec?: DbExecutor): Promise<ShareRequestFileResult> {
    assertShareShape(input);

    const targetIds = [...new Set(input.grantRelationshipIds)];
    if (input.audience === 'grants' && targetIds.length === 0) {
      throw new Error('audience=grants requires at least one grant target');
    }

    const run = async (tx: DbExecutor): Promise<ShareRequestFileResult> => {
      // ⚠ LOCKED. See `loadTrackRefs`'s `FOR SHARE` docblock — without the lock the
      // in-transaction re-validation below can be invalidated by a concurrent closure that
      // commits without conflicting.
      const tracks = await loadTrackRefs(tx, input.projectRequestId, { lockForShare: true });
      const trackById = new Map(tracks.map((t) => [t.relationshipId, t]));

      // ⚠ IN-TRANSACTION RE-VALIDATION. The picker lists live tracks only, but the gate ran
      // before this transaction opened; a track that closed in between must not gain access.
      for (const relationshipId of targetIds) {
        const target = trackById.get(relationshipId);
        if (target === undefined || target.access.kind !== 'live') {
          throw new RequestFileTrackNotLiveError(relationshipId);
        }
      }

      /**
       * ⚠⚠ THE SHARE INSTANT IS STAMPED EXPLICITLY, FROM THE APP CLOCK, AFTER THE STANDINGS
       * ARE READ — IT IS NOT LEFT TO `created_at`'s `defaultNow()`. THIS IS LOAD-BEARING.
       *
       * Historical-read (ADR-1048 §2) is a STRICT INEQUALITY between this instant and a
       * track's closure instant: `trackCanReadAllAudienceShare(access, file.createdAt)`. Every
       * closure instant on the other side of that comparison is an APP-CLOCK `new Date()` —
       * `advanceRelationshipStatus` writes `declinedAt`, `softDelete` writes `deletedAt`, and
       * `markNotSelectedByAward` writes `notSelectedAt`. `defaultNow()` is the DATABASE clock,
       * and specifically the TRANSACTION START timestamp, so leaving the default would compare
       * two different clocks and would date the share to before its own transaction's work.
       *
       * Both failure modes GRANT ACCESS THAT SHOULD BE DENIED: a track this transaction has
       * ALREADY OBSERVED AS CLOSED would satisfy `sharedAt < closedAt` and be handed a file
       * shared after it closed — precisely ADR-1048 §7's "a closed track never gains new
       * visibility". Taking the instant here, after `loadTrackRefs`, on the same clock the
       * closure writers use, makes the invariant hold by ORDERING rather than by luck.
       */
      const sharedAt = new Date();

      const [file] = await tx
        .insert(requestSharedFiles)
        .values({
          projectRequestId: input.projectRequestId,
          uploadedByUserId: input.uploadedByUserId,
          side: input.side,
          audience: input.audience,
          expertRelationshipId: input.expertRelationshipId,
          r2Key: input.r2Key,
          fileName: input.fileName,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          createdAt: sharedAt,
          updatedAt: sharedAt,
        })
        .returning();
      if (file === undefined) {
        throw new Error('Failed to create request shared file');
      }

      const grants =
        targetIds.length === 0
          ? []
          : await tx
              .insert(requestFileGrants)
              .values(
                targetIds.map((relationshipId) => ({
                  fileId: file.id,
                  relationshipId,
                  projectRequestId: input.projectRequestId,
                  grantedByUserId: input.uploadedByUserId,
                }))
              )
              .returning();

      // ⚠ ONE FUNCTION, THREE MODES. Computed from the PERSISTED row (its `created_at` is what
      // the historical-read inequality will be compared against later), never from the input.
      const resolvedLiveTracks = resolveRequestFileAudience(
        file,
        tracks,
        new Set(grants.map((g) => g.relationshipId))
      );

      const common = auditCommonFor(file);

      if (input.audience === 'all_live_tracks') {
        const resolved: RequestFileAuditTrackRef[] = resolvedLiveTracks.map((entry) => ({
          relationshipId: entry.relationshipId,
          expertProfileId: entry.expertProfileId,
        }));
        await recordRequestFileAudit(tx, {
          actorUserId: input.uploadedByUserId,
          fileId: file.id,
          common,
          payload: {
            action: 'request_shared_file.shared_all_tracks',
            resolvedLiveTracks: resolved,
          },
        });
      }

      for (const grant of grants) {
        const target = trackById.get(grant.relationshipId);
        if (target === undefined) {
          // Unreachable: every target was resolved above. Fail loudly rather than write an
          // audit row with a hole in it — Ruling 4 has no backfill.
          throw new RequestFileTrackNotLiveError(grant.relationshipId);
        }
        await recordRequestFileAudit(tx, {
          actorUserId: input.uploadedByUserId,
          fileId: file.id,
          common,
          payload: {
            action: 'request_shared_file.grant_added',
            relationshipId: grant.relationshipId,
            expertProfileId: target.expertProfileId,
          },
        });
      }

      return { file, grants, resolvedLiveTracks };
    };

    return exec === undefined ? db.transaction(run) : run(exec);
  },

  /**
   * A request's files, OLDEST FIRST, each with its LIVE grants.
   *
   * Served by `request_shared_file_request_idx` (project_request_id, created_at)
   * WHERE deleted_at IS NULL — and, when `includeDeleted` is set, by the NON-partial
   * `request_shared_file_request_all_idx`, which exists for exactly that read (and for the
   * `ON DELETE CASCADE` scan).
   *
   * ⚠ `includeDeleted` IS THE ADMIN LENS'S EXPLICITLY-NAMED PATH, never a relaxed predicate
   * elsewhere: tombstones are invisible to `requestFileVisibleToTrack` by construction.
   *
   * ⚠ BOUNDED AT {@link REQUEST_SHARED_FILE_LIST_LIMIT} — a cap, not pagination. See that
   * constant for the caller's `log.warn` obligation.
   *
   * TWO SELECTS, GROUPED IN MEMORY — not a join. A join would multiply file rows by their
   * grant count and force a de-duplication pass over rows carrying `r2_key`.
   */
  async listForRequest(
    projectRequestId: string,
    opts?: { includeDeleted?: boolean }
  ): Promise<RequestFileWithGrants[]> {
    const files = await db
      .select()
      .from(requestSharedFiles)
      .where(
        and(
          eq(requestSharedFiles.projectRequestId, projectRequestId),
          opts?.includeDeleted === true ? undefined : isNull(requestSharedFiles.deletedAt)
        )
      )
      // `id` tiebreaker: `created_at` is the transaction timestamp, so two files shared in
      // one transaction would otherwise come back in an arbitrary order.
      .orderBy(asc(requestSharedFiles.createdAt), asc(requestSharedFiles.id))
      .limit(REQUEST_SHARED_FILE_LIST_LIMIT);

    const grantsByFile = await loadLiveGrantsByFile(
      db,
      files.map((f) => f.id)
    );

    return files.map((file) => ({ file, grants: grantsByFile.get(file.id) ?? [] }));
  },

  /**
   * ⚠ THE CONTAINMENT READ — the direct replacement for `listFiles(conversationId)`'s
   * accidental IDOR defence, restored at request grain.
   *
   * `projectRequestId` MUST come from the GATE. It is a term in the WHERE clause, not a
   * post-filter, so a file on ANOTHER request resolves `undefined` identically to a missing
   * one and probing learns nothing. This is only HALF the defence: the caller must ALSO run
   * the per-file audience check (`requestFileVisibleToTrack`) for an expert viewer — once a
   * file is readable from more than one track, containment alone no longer separates
   * siblings.
   *
   * `includeDeleted` exists ONLY for the admin lens and the delete path's re-read.
   */
  async findByIdInRequest(
    fileId: string,
    projectRequestId: string,
    opts?: { includeDeleted?: boolean }
  ): Promise<RequestFileWithGrants | undefined> {
    const [file] = await db
      .select()
      .from(requestSharedFiles)
      .where(
        and(
          eq(requestSharedFiles.id, fileId),
          eq(requestSharedFiles.projectRequestId, projectRequestId),
          opts?.includeDeleted === true ? undefined : isNull(requestSharedFiles.deletedAt)
        )
      )
      .limit(1);

    if (file === undefined) return undefined;

    const grantsByFile = await loadLiveGrantsByFile(db, [file.id]);
    return { file, grants: grantsByFile.get(file.id) ?? [] };
  },

  /**
   * REVOKE — soft-delete ONE grant row + `request_shared_file.grant_revoked`, SAME TRANSACTION
   * (ADR-1030 / ADR-1048 §7).
   *
   * ⚠ SILENT BY DECISION (ADR-1048 §4): no notification is published anywhere, by this method
   * or by its caller. A toast is client-side UI feedback and is not the notification engine.
   *
   * ⚠ FORWARD-ONLY BY CONSTRUCTION. A presigned download URL already minted lives 300s and is
   * not revocable, so revoke ends future access, never past access. Stated so it is not
   * rediscovered as a bug.
   *
   * The grant row is SOFT-deleted, freeing its slot in the PARTIAL unique
   * `request_file_grant_unique_idx` so the same (file, track) pair can be granted again later.
   */
  async revokeGrant(
    input: RevokeRequestFileGrantInput,
    exec?: DbExecutor
  ): Promise<RequestFileGrant> {
    const run = async (tx: DbExecutor): Promise<RequestFileGrant> => {
      const [file] = await tx
        .select()
        .from(requestSharedFiles)
        .where(
          and(
            eq(requestSharedFiles.id, input.fileId),
            eq(requestSharedFiles.projectRequestId, input.projectRequestId),
            isNull(requestSharedFiles.deletedAt)
          )
        )
        .limit(1);
      if (file === undefined) {
        throw new RequestFileNotFoundError(input.fileId);
      }

      const [existing] = await tx
        .select({
          grant: requestFileGrants,
          expertProfileId: requestExpertRelationships.expertProfileId,
        })
        .from(requestFileGrants)
        .innerJoin(
          requestExpertRelationships,
          eq(requestExpertRelationships.id, requestFileGrants.relationshipId)
        )
        .where(
          and(
            eq(requestFileGrants.fileId, input.fileId),
            eq(requestFileGrants.relationshipId, input.relationshipId),
            isNull(requestFileGrants.deletedAt)
          )
        )
        .limit(1);
      if (existing === undefined) {
        throw new RequestFileGrantNotFoundError(input.fileId, input.relationshipId);
      }

      const now = new Date();
      const [revoked] = await tx
        .update(requestFileGrants)
        .set({ deletedAt: now, revokedByUserId: input.actorUserId, updatedAt: now })
        .where(
          and(eq(requestFileGrants.id, existing.grant.id), isNull(requestFileGrants.deletedAt))
        )
        .returning();
      if (revoked === undefined) {
        throw new RequestFileGrantNotFoundError(input.fileId, input.relationshipId);
      }

      await recordRequestFileAudit(tx, {
        actorUserId: input.actorUserId,
        fileId: file.id,
        common: auditCommonFor(file),
        payload: {
          action: 'request_shared_file.grant_revoked',
          relationshipId: input.relationshipId,
          expertProfileId: existing.expertProfileId,
          grantId: existing.grant.id,
          grantedAtIso: existing.grant.createdAt.toISOString(),
        },
      });

      return revoked;
    };

    return exec === undefined ? db.transaction(run) : run(exec);
  },

  /**
   * DELETE — tombstone + `request_shared_file.deleted` carrying the RESOLVED AUDIENCE SNAPSHOT
   * (Ruling 1), SAME TRANSACTION.
   *
   * ⚠ THE SNAPSHOT IS THE WHOLE POINT OF RULING 1. The R2 object IS deleted (the house rule at
   * `schema/meeting-files.ts:22-31` beats ADR-1048 §4's "object retained"), so with the bytes
   * gone "who had access to what, when" is answerable ONLY from this audit row plus the
   * tombstone. It is computed by `resolveRequestFileAudience` — the SAME function the read
   * path uses — and BEFORE the tombstone is written, because a tombstone is invisible to that
   * rule by design.
   *
   * ⚠ RETURNS the `r2Key` so the CALLER performs the best-effort, prefix-guarded object delete
   * AFTER COMMIT. The object delete must NEVER happen inside the transaction: a rollback would
   * leave a live row pointing at deleted bytes. A repository does not reach R2.
   *
   * ⚠ LIVE GRANTS ARE LEFT UNTOUCHED. The file's own `deleted_at` closes visibility (the
   * audience rule short-circuits on a tombstone), and the grant rows stay as history. The
   * audit snapshot is the record of record.
   *
   * ⚠ NO AUTHORIZATION HERE. Ruling 3 makes delete rights PARTY-LEVEL on both sides (delete
   * right ≡ upload right on that side, no `uploaded_by_user_id === actor` check); that
   * decision belongs to the caller's gate. `actorUserId` is recorded, never consulted.
   */
  async softDelete(
    input: SoftDeleteRequestFileInput,
    exec?: DbExecutor
  ): Promise<SoftDeleteRequestFileResult> {
    const run = async (tx: DbExecutor): Promise<SoftDeleteRequestFileResult> => {
      const [file] = await tx
        .select()
        .from(requestSharedFiles)
        .where(
          and(
            eq(requestSharedFiles.id, input.fileId),
            eq(requestSharedFiles.projectRequestId, input.projectRequestId)
          )
        )
        .limit(1);
      if (file === undefined) {
        throw new RequestFileNotFoundError(input.fileId);
      }
      if (file.deletedAt !== null) {
        throw new RequestFileAlreadyDeletedError(input.fileId);
      }

      // ⚠ LOCKED for the same reason: the resolved-audience snapshot written below is
      // append-only (Ruling 4) and has no backfill, so it must not race a closure.
      const tracks = await loadTrackRefs(tx, input.projectRequestId, { lockForShare: true });
      const grantsByFile = await loadLiveGrantsByFile(tx, [file.id]);
      const grantedIds = new Set((grantsByFile.get(file.id) ?? []).map((g) => g.relationshipId));

      // ⚠ BEFORE the tombstone — `requestFileVisibleToTrack` returns false for a deleted file.
      const resolvedAudience = resolveRequestFileAudience(file, tracks, grantedIds);

      const now = new Date();
      const [tombstoned] = await tx
        .update(requestSharedFiles)
        .set({ deletedAt: now, deletedByUserId: input.actorUserId, updatedAt: now })
        .where(and(eq(requestSharedFiles.id, file.id), isNull(requestSharedFiles.deletedAt)))
        .returning();
      if (tombstoned === undefined) {
        throw new RequestFileAlreadyDeletedError(input.fileId);
      }

      await recordRequestFileAudit(tx, {
        actorUserId: input.actorUserId,
        fileId: file.id,
        common: auditCommonFor(file),
        payload: {
          action: 'request_shared_file.deleted',
          resolvedAudienceAtDelete: resolvedAudience.map((entry) => ({
            relationshipId: entry.relationshipId,
            expertProfileId: entry.expertProfileId,
            via: entry.via,
          })),
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          r2Key: file.r2Key,
          uploadedByUserId: file.uploadedByUserId,
          createdAtIso: file.createdAt.toISOString(),
        },
      });

      return { file: tombstoned, r2Key: file.r2Key, resolvedAudience };
    };

    return exec === undefined ? db.transaction(run) : run(exec);
  },

  /**
   * BAL-431 / ADR-1048 §5 PROMOTION LINEAGE — the WINNER-VISIBLE request files of a
   * materialised engagement.
   *
   * ⚠ A READ-SIDE JOIN, NOT A COPY. Copying rows at kickoff would duplicate the artifact, fork
   * the `r2_key` namespace, freeze the audience at kickoff (re-introducing the snapshotted
   * audience ADR-1048 rejected), and need an explicit "skip tombstones" filter someone must
   * remember. Resolving `project_engagements.project_request_id` + `.relationship_id` and
   * re-applying the SAME audience rule gets all of it for free.
   *
   * ✅ "DELETED FILES NEVER FOLLOW PROMOTION LINEAGE" (ADR-1048 §7) HOLDS BY CONSTRUCTION —
   * `requestFileVisibleToTrack` returns false for a tombstone. Nothing to remember, nothing
   * to skip.
   *
   * FAILS CLOSED to `[]` when the engagement is missing/soft-deleted, when either lineage
   * column is NULL (both are `ON DELETE SET NULL`), or when the originating relationship has
   * since been hard-deleted or withdrawn.
   *
   * ⚠ SHIPS WITH NO UI CONSUMER (`/engagements/[id]` has no files surface today) — the
   * house-sanctioned "inert with a named consumer" shape. It is covered by its integration
   * tests, not by a page.
   *
   * ⚠⚠ `subject` IS THE GATE-SUPPLIED CONTAINMENT TERM, AND IT IS REQUIRED. Every sibling
   * method on this repository takes its containment alongside the id (`findByIdInRequest`,
   * `revokeGrant`, `softDelete` — all take `projectRequestId`); this one used to resolve the
   * lineage from a bare `engagements.id` and return whole rows INCLUDING `r2Key`. That is the
   * exact shape ADR-1029's containment discipline exists to forbid: the first consumer that
   * forgot a gate would hand every request file of the originating request to anyone holding an
   * engagement uuid, and this class's own "NO AUTHORIZATION LIVES HERE" banner would make it
   * look correct. Making the term a REQUIRED parameter makes the obligation structural rather
   * than a comment someone has to read.
   *
   * It is a UNION over the two parties `engagements` actually carries — mirroring
   * `hasCapability(actor, cap, { companyId } | { agencyId })` — because both future consumers
   * are real: the client company viewing its own engagement, and the winning expert viewing
   * theirs. Whichever party the caller's gate proved, it passes; a caller that proved neither
   * cannot call this at all. The term is a WHERE clause on `engagements`, not a post-filter, so
   * a foreign engagement resolves `[]` identically to a stale uuid.
   */
  async listForEngagement(
    engagementId: string,
    subject: { companyId: string } | { expertProfileId: string }
  ): Promise<RequestFileWithGrants[]> {
    const containment =
      'companyId' in subject
        ? eq(engagements.companyId, subject.companyId)
        : eq(engagements.expertProfileId, subject.expertProfileId);

    const [lineage] = await db
      .select({
        projectRequestId: projectEngagements.projectRequestId,
        relationshipId: projectEngagements.relationshipId,
      })
      .from(projectEngagements)
      .innerJoin(engagements, eq(engagements.id, projectEngagements.engagementId))
      .where(
        and(
          eq(projectEngagements.engagementId, engagementId),
          isNull(engagements.deletedAt),
          containment
        )
      )
      .limit(1);

    const projectRequestId = lineage?.projectRequestId;
    const relationshipId = lineage?.relationshipId;
    if (
      projectRequestId === undefined ||
      projectRequestId === null ||
      relationshipId === undefined ||
      relationshipId === null
    ) {
      return [];
    }

    const tracks = await loadTrackRefs(db, projectRequestId);
    const viewer = tracks.find((t) => t.relationshipId === relationshipId);
    if (viewer === undefined) return [];

    const candidates = await requestSharedFilesRepository.listForRequest(projectRequestId);
    return candidates.filter(({ file, grants }) =>
      requestFileVisibleToTrack(file, viewer, new Set(grants.map((g) => g.relationshipId)))
    );
  },
};
