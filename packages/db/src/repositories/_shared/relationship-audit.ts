import { auditEventsRepository } from '../audit-events';
import type { DbExecutor } from './db-executor';
import type { RelationshipDeclineReason, RequestExpertRelationship } from '../../schema';

/** Per-expert relationship status. Re-derived from the schema, NOT imported from
 *  `repositories/request-expert-relationships.ts` — that module imports THIS one. */
type RelationshipStatus = RequestExpertRelationship['status'];

/**
 * The per-expert-relationship audit vocabulary (BAL-540 / ADR-1030, orchestrator D3).
 * Modelled line-for-line on `_shared/request-file-audit.ts` and `_shared/meeting-audit.ts`: a
 * typed action union keeping OUR emitted taxonomy typo-safe at compile time (`audit_events.action`
 * / `.entityType` are open `text`, so nothing else would catch `relationship.decliend`), plus ONE
 * recording helper so the `metadata` shape cannot drift between call sites — and so five copies
 * of the same `record()` literal do not trip Sonar's new-code duplication gate.
 *
 * ⚠⚠ THIS PAYLOAD CONTRACT IS UNRECOVERABLE IF WRONG. `audit_events` is APPEND-ONLY — no
 * `updated_at`, no `deleted_at`, no backfill (`schema/audit-events.ts`). Adding a new `action`
 * later is additive and safe; CHANGING an existing action's `metadata` shape is not. The shape
 * below is asserted key-by-key in `request-track-decline.integration.test.ts`.
 *
 * ⚠ WHY EVERY TRANSITION IS AUDITED, NOT JUST `declined`. ADR-1030's criterion is "every
 * mutation writes attribution + audit in one transaction", and `advanceRelationshipStatus` is
 * the ONE writer of this column — auditing only the branch BAL-540 happens to need would leave
 * the other four transitions as the exact gap the ADR names. The cost is one INSERT per
 * transition on paths that were already inside a transaction.
 *
 * ⚠ `actorUserId` IS REQUIRED AND NON-NULLABLE HERE. Unlike `meeting.ended` (whose four
 * lifecycle-sweep paths take the ADR-1030 system-actor exemption), every relationship
 * transition has a human: the expert submitting an EOI or a proposal, the client requesting or
 * accepting one, Balo staff acting on the client's behalf, or the actor who closed the request.
 * A `null` here would be a bug, so the type does not permit one.
 */
export type RelationshipAuditAction =
  | 'request_expert_relationship.eoi_submitted'
  | 'request_expert_relationship.proposal_requested'
  | 'request_expert_relationship.proposal_submitted'
  | 'request_expert_relationship.accepted'
  | 'request_expert_relationship.declined';

export type RelationshipAuditEntityType = 'request_expert_relationship';

/**
 * ONE audit action per destination status. Exhaustive over `RelationshipStatus` MINUS
 * `invited` — a relationship is BORN `invited` (`invite()`'s insert), never transitioned INTO
 * it, so there is no `→ invited` edge in `RELATIONSHIP_STATUS_TRANSITIONS` and an
 * `request_expert_relationship.invited` action would have no writer.
 *
 * Typed as an exhaustive `Record` on purpose: a sixth relationship status forces a decision
 * here at compile time rather than silently emitting nothing.
 */
const ACTION_BY_DESTINATION: Record<
  Exclude<RelationshipStatus, 'invited'>,
  RelationshipAuditAction
> = {
  eoi_submitted: 'request_expert_relationship.eoi_submitted',
  proposal_requested: 'request_expert_relationship.proposal_requested',
  proposal_submitted: 'request_expert_relationship.proposal_submitted',
  accepted: 'request_expert_relationship.accepted',
  declined: 'request_expert_relationship.declined',
};

export interface RecordRelationshipTransitionInput {
  actorUserId: string;
  relationshipId: string;
  /** Denormalised so a "history of this request" read needs no join back to the relationship. */
  projectRequestId: string;
  from: RelationshipStatus;
  to: RelationshipStatus;
  /** Present iff `to === 'declined'` — the same value written to `decline_reason`. */
  declineReason?: RelationshipDeclineReason;
}

/**
 * Record ONE relationship transition inside the CALLER'S transaction (pass the `tx` handle — it
 * satisfies `DbExecutor`). `auditEventsRepository.record`'s second positional argument is
 * REQUIRED and is the same-transaction seam (ADR-1030): the audit row and the status change it
 * records commit or roll back together.
 *
 * `entityType` is always `'request_expert_relationship'` and `entityId` is always the
 * RELATIONSHIP id — the entity whose state moved. The request id rides in `metadata`.
 *
 * ⚠ RETURNS THE AUDIT ROW ID, AND THAT IS LOAD-BEARING FOR `declined` RATHER THAN A
 * CONVENIENCE. `audit_events` is append-only, so the id is UNIQUE PER SUCCESSFUL TRANSITION,
 * and BAL-540's `project.track_declined` fan-out keys its BullMQ jobId off it. A
 * `relationshipId`-derived key would be unique per RELATIONSHIP, not per WRITE, and BullMQ
 * silently no-ops an `add` whose jobId is already in the retained completed set (memory
 * `reference_bullmq_jobid_must_be_per_write_not_per_state`). It is also colon-free (a uuid),
 * which `engine/dispatcher.ts` requires because it builds the per-channel jobId from the RAW
 * correlationId.
 *
 * ⚠ A `→ invited` TRANSITION CANNOT REACH HERE. `RELATIONSHIP_STATUS_TRANSITIONS` has no edge
 * into `invited`, and `advanceRelationshipStatus` validates against that map BEFORE calling
 * this — so the narrowing below is a total function over what can actually arrive, and the
 * `throw` is a structural impossibility guard, not a runtime branch anyone hits.
 */
export async function recordRelationshipTransition(
  exec: DbExecutor,
  input: RecordRelationshipTransitionInput
): Promise<string> {
  if (input.to === 'invited') {
    throw new Error(
      `No audit action for a transition INTO 'invited' (relationship ${input.relationshipId}): a relationship is born invited, never transitioned into it.`
    );
  }
  const entityType: RelationshipAuditEntityType = 'request_expert_relationship';
  const row = await auditEventsRepository.record(
    {
      actorUserId: input.actorUserId,
      action: ACTION_BY_DESTINATION[input.to],
      entityType,
      entityId: input.relationshipId,
      metadata: {
        projectRequestId: input.projectRequestId,
        from: input.from,
        to: input.to,
        ...(input.declineReason === undefined ? {} : { declineReason: input.declineReason }),
      },
    },
    exec
  );
  return row.id;
}
