import { auditEventsRepository } from '../audit-events';
import type { DbExecutor } from './db-executor';

/**
 * The per-proposal audit vocabulary (BAL-432 / ADR-1030). Modelled STRUCTURALLY on
 * `_shared/relationship-audit.ts`: a typed action union keeping OUR emitted taxonomy typo-safe
 * at compile time (`audit_events.action` / `.entityType` are open `text` —
 * `schema/audit-events.ts:85,89` — so nothing else would catch `proposal.acceptd`), plus ONE
 * recording helper so the `metadata` shape cannot drift between call sites.
 *
 * ⚠⚠ THIS PAYLOAD CONTRACT IS UNRECOVERABLE IF WRONG. `audit_events` is APPEND-ONLY — no
 * `updated_at`, no `deleted_at`, no backfill (`schema/audit-events.ts`). Adding a NEW `action`
 * later is additive and safe; CHANGING this action's `metadata` shape is not. The shape is
 * asserted key-by-key, with set-equality, in `proposals.accept-audit.test.ts` (unit) and
 * `proposals.integration.test.ts` (integration).
 *
 * ⚠ WHY EXACTLY ONE MEMBER — the counter-argument, and why its premise does not transfer.
 * `relationship-audit.ts` argues the OPPOSITE for its own table ("WHY EVERY TRANSITION IS
 * AUDITED, NOT JUST `declined`"), resting entirely on `advanceRelationshipStatus` being the ONE
 * writer of that column. Proposals have no such choke point: `advanceProposalStatus` has SIX
 * production callers (`promoteToSubmit`, `accept`, `transitionStatus`, `requestChanges`,
 * `requestExpertRelationshipsRepository.declineTrack`, `projectRequestsRepository.close`), and
 * `resubmit` bypasses it entirely with a direct `tx.update`. Of the six, only `transitionStatus`
 * has NO actor at all. The blocker is the other shape: two of them (`declineTrack`, `close`) are
 * REQUEST-GRAIN FAN-OUTS — they do carry an actor, but it is the closer/decliner acting on the
 * whole request, not a per-proposal human, and it fans out over N proposals. A widened vocabulary
 * would attribute each cascaded proposal to that one actor, which asserts something stronger and
 * different from "this person accepted this proposal" — the claim `actorUserId` (below) makes.
 * Those two branches are already in the audit stream at REQUEST grain — BAL-540's
 * `project_request.closed` row names the actor and carries `counts.proposalsWithdrawn` plus
 * `declinedRelationshipIds` (`project-requests.ts`). ⚠ It records HOW MANY proposals were
 * withdrawn, not WHICH: `withdrawnProposalIds` exists only on `close()`'s RETURN value, never
 * on the audit row. So proposal-grain attribution for those branches is not missing — the actor
 * is recorded at the grain where the actor actually exists — but it is coarser than a
 * per-proposal row would be. A future ticket weighing whether to widen this vocabulary should
 * weigh that honestly rather than assume the ids are already on record.
 *
 * ⚠ `actorUserId` IS REQUIRED AND NON-NULLABLE HERE. The sole writer is `accept`, whose only
 * production caller already holds the accepting client's id from `requireOnboardedUser()`
 * (`apps/web/src/app/(dashboard)/projects/[requestId]/_actions/accept-proposal.ts`). There is
 * NO system-actor exemption on this path — unlike `meeting.ended`'s lifecycle sweeps. A `null`
 * here would be a bug, so the type does not permit one.
 *
 * ⚠ NO MONEY FIELDS. EVER. No `priceCents`, no `depositCents`, no `rateCents`, and ABSOLUTELY NO
 * `baloFeeBps` — Balo's service margin is concealed from both the client and the expert lens,
 * and an audit row is not a relaxed surface (admin is the sole relaxed surface). This ban has a
 * MECHANICAL BACKSTOP as of BAL-432: the metadata key set is asserted with set-equality (not
 * `not.toHaveProperty`) in `proposals.accept-audit.test.ts` and `proposals.integration.test.ts`,
 * so a fifth key of any name fails CI. The pre-existing fee-concealment invariant
 * (`invariants/admin-alert-facts-are-not-fee-concealed.test.ts`) CANNOT see this file — it
 * pre-filters on the literal `adminalert` and inspects only `facts:` arrays — so it is not a
 * backstop here and must not be mistaken for one.
 *
 * ⚠ CROSS-REGISTRY NAMESPACE NOTE. The `proposal.` prefix is now live in TWO unrelated
 * registries: `'proposal.accepted'` here is an `audit_events.action`, while `'proposal.shared'`
 * is a NOTIFICATION EVENT name (`apps/web/src/lib/notifications/types.ts:232`). They are
 * different taxonomies that happen to share a prefix — a reader grepping `'proposal.` will hit
 * both, and must not assume a match in one registry implies a member of the other.
 *
 * Executor contract: `auditEventsRepository.record`'s second positional argument is REQUIRED
 * and is the same-transaction seam (ADR-1030) — the audit row and the state change it records
 * commit or roll back together. Pass the caller's `tx`. A real database CANNOT distinguish
 * `record(…, tx)` from `record(…, db)` on the happy path, nor under the integration harness
 * (where `db` *is* the per-test transaction) — only the executor-identity assertion in the unit
 * test catches it (`proposals.accept-audit.test.ts`, `expect(exec).toBe(capturedTx)`).
 *
 * Entity contract: `entityType` is always `'proposal'` and `entityId` is always the PROPOSAL id
 * — the entity whose state moved. The relationship id, request id and expert id ride in
 * `metadata`.
 *
 * Return value, honestly scoped: returns the audit row id, mirroring
 * `recordRelationshipTransition`. Unlike that one, this id is NOT load-bearing today — it keys
 * no BullMQ job and has no consumer; `accept` discards it. It is returned for symmetry and
 * because a future fan-out would need a per-WRITE (not per-entity) correlation id.
 */
export type ProposalAuditAction = 'proposal.accepted';

export type ProposalAuditEntityType = 'proposal';

export interface RecordProposalAcceptedInput {
  /** The accepting client. REQUIRED and non-nullable — see the docblock. */
  actorUserId: string;
  /** The entity whose state moved; becomes `audit_events.entity_id`. */
  proposalId: string;
  relationshipId: string;
  /** Denormalised so a "history of this request" read needs no join back to the proposal. */
  projectRequestId: string;
  expertProfileId: string;
  /** The LOCKED row's `version` at acceptance — not the post-flip re-read. */
  proposalVersion: number;
}

/**
 * Record the ONE proposal acceptance audit action inside the CALLER'S transaction (pass the
 * `tx` handle — it satisfies `DbExecutor`). See the file docblock for the executor contract.
 *
 * ⚠ No `throw` guard. `relationship-audit.ts` has one only because it narrows a `Record` over a
 * status union and `→ invited` is structurally unreachable. There is no narrowing here — a
 * single-member vocabulary has nothing to be unreachable. Do not invent a guard to mirror the
 * shape; an unreachable `throw` would be an uncoverable line under the SonarCloud new-code gate.
 *
 * ⚠ No import from `../proposals`. `proposals.ts` imports *this* module, so importing back
 * would be circular. This file needs no status type at all (that is the whole benefit of the
 * single-member vocabulary), so unlike `relationship-audit.ts` it does not even need the
 * schema-type re-derivation workaround. Keep it that way.
 *
 * ⚠ Call `auditEventsRepository.record(...)` as a property access, never destructured
 * (`const { record } = auditEventsRepository`). The integration rollback test installs a
 * `vi.spyOn` on that property; a destructured reference captured at import time would not see
 * it.
 */
export async function recordProposalAccepted(
  exec: DbExecutor,
  input: RecordProposalAcceptedInput
): Promise<string> {
  const action: ProposalAuditAction = 'proposal.accepted';
  const entityType: ProposalAuditEntityType = 'proposal';
  const row = await auditEventsRepository.record(
    {
      actorUserId: input.actorUserId,
      action,
      entityType,
      entityId: input.proposalId,
      metadata: {
        relationshipId: input.relationshipId,
        projectRequestId: input.projectRequestId,
        expertProfileId: input.expertProfileId,
        proposalVersion: input.proposalVersion,
      },
    },
    exec
  );
  return row.id;
}
