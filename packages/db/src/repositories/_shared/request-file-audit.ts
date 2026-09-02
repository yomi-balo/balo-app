import type { ResolvedRequestFileAudienceEntry } from '@balo/shared/authz';
import { auditEventsRepository } from '../audit-events';
import type { DbExecutor } from './db-executor';
import type { RequestFileAudience, RequestFileSide } from '../../schema';

/**
 * The request-file audit vocabulary (BAL-431 / ADR-1048 §7, Ruling 4). Follows
 * `_shared/delivery-audit.ts`: a typed union keeping the emitted taxonomy typo-safe at compile
 * time (`audit_events.action` / `.entityType` are open `text`), plus ONE recording helper so
 * the metadata shape cannot drift between call sites — and so four copies of the same
 * `record()` literal do not trip Sonar's new-code duplication gate.
 *
 * ⚠⚠ THIS PAYLOAD CONTRACT IS UNRECOVERABLE IF WRONG. `audit_events` is APPEND-ONLY — no
 * `updated_at`, no `deleted_at`, no backfill (`schema/audit-events.ts:16-21`). Adding a new
 * `action` later is additive and safe; CHANGING an existing action's `metadata` shape is not.
 * Ruling 4 fixes the four shapes below and they are asserted key-by-key in
 * `request-shared-files.integration.test.ts`.
 *
 * ⚠ AUDIT METADATA MUST NEVER REACH A NON-ADMIN SERIALIZER. It is audience-shaped by
 * construction, so leaking it would defeat ADR-1048 §3's concealment invariant. The expert
 * serializer emits no audit data at all, and the client-facing Access-history strip is
 * DEFERRED (Ruling 4).
 *
 * ⚠ DELIBERATELY NOT AUDITED: an expert's own-track upload. It is not an access-boundary
 * DECISION — the row itself (`side`, `expert_relationship_id`, `uploaded_by_user_id`,
 * `created_at`) is the complete record, and the audience is structurally fixed by the
 * `request_shared_file_side_shape` CHECK. Ruling 4 names four events and this is not one.
 */
export type RequestFileAuditAction =
  | 'request_shared_file.shared_all_tracks'
  | 'request_shared_file.grant_added'
  | 'request_shared_file.grant_revoked'
  | 'request_shared_file.deleted';

export type RequestFileAuditEntityType = 'request_shared_file';

/**
 * The COMMON `metadata` keys carried by all four actions (Ruling 4: "file id + name, and the
 * actor"). The file id is `entityId` and the actor is `actorUserId` — both are columns, not
 * metadata.
 */
export interface RequestFileAuditCommon {
  projectRequestId: string;
  fileName: string;
  side: RequestFileSide;
  audience: RequestFileAudience;
}

/**
 * ⚠ THE AUDIENCE-SNAPSHOT ENTRY SHAPE, AS STORED. `via` is carried on the DELETE snapshot
 * only; `shared_all_tracks` records the live SET, whose `via` is `all_live_tracks` for every
 * member by construction and would be pure noise.
 *
 * ⚠ `expertProfileId` IS CARRIED ALONGSIDE `relationshipId` DELIBERATELY. A relationship row
 * is hard-deletable by a request/expert cascade (`request-origination.ts:63-68`), so the
 * profile id is what keeps "who had access" resolvable after the relationship is gone.
 */
export interface RequestFileAuditTrackRef {
  relationshipId: string;
  expertProfileId: string;
}

/** The delete snapshot additionally records HOW each track could see the file. */
export type RequestFileAuditAudienceEntry = RequestFileAuditTrackRef & {
  via: ResolvedRequestFileAudienceEntry['via'];
};

/**
 * The four payloads, as a discriminated union. This is the contract — a compile error here is
 * the intended cost of changing it.
 */
export type RequestFileAuditPayload =
  | {
      action: 'request_shared_file.shared_all_tracks';
      /** THE RESOLVED LIVE SET AT SHARE TIME, computed INSIDE the share transaction. */
      resolvedLiveTracks: RequestFileAuditTrackRef[];
    }
  | {
      action: 'request_shared_file.grant_added';
      relationshipId: string;
      expertProfileId: string;
    }
  | {
      action: 'request_shared_file.grant_revoked';
      relationshipId: string;
      expertProfileId: string;
      grantId: string;
      grantedAtIso: string;
    }
  | {
      action: 'request_shared_file.deleted';
      /**
       * THE RESOLVED AUDIENCE AT DELETE TIME (Ruling 1). Produced by
       * `resolveRequestFileAudience` — the SAME function the read path uses — so the snapshot
       * cannot drift from the rule it is recording.
       */
      resolvedAudienceAtDelete: RequestFileAuditAudienceEntry[];
      /**
       * ⚠ RULING 1'S ENTIRE JUSTIFICATION. With the bytes deleted from R2, "who had access to
       * what, when" is answered from this row plus the tombstone and NEVER from the object.
       * `r2Key` is included because it is the only remaining pointer to what was there.
       */
      contentType: string;
      sizeBytes: number;
      r2Key: string;
      uploadedByUserId: string;
      createdAtIso: string;
    };

/**
 * Record ONE request-file audit event inside the CALLER'S transaction (pass the `tx` handle —
 * it satisfies `DbExecutor`). `auditEventsRepository.record`'s second positional argument is
 * REQUIRED and is the same-transaction seam (ADR-1030 / ADR-1048 §7): the audit row and the
 * access-boundary change it records commit or roll back together.
 *
 * `entityType` is always `'request_shared_file'` and `entityId` is always THE FILE ID — for
 * all four actions, including the grant pair. The file is the entity whose access boundary
 * moved; a grant row is the mechanism, not the subject. `actorUserId` is the acting human and
 * is never null: every one of these four paths has one (no ADR-1030 system exemption applies).
 */
export async function recordRequestFileAudit(
  exec: DbExecutor,
  input: {
    actorUserId: string;
    fileId: string;
    common: RequestFileAuditCommon;
    payload: RequestFileAuditPayload;
  }
): Promise<void> {
  const { action, ...rest } = input.payload;
  const entityType: RequestFileAuditEntityType = 'request_shared_file';
  await auditEventsRepository.record(
    {
      actorUserId: input.actorUserId,
      action,
      entityType,
      entityId: input.fileId,
      metadata: { ...input.common, ...rest },
    },
    exec
  );
}
