import { and, count, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { agencies, agencyMembers } from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import { auditEventsRepository } from './audit-events';
import { partyDomainsRepository } from './party-domains';
import { partyMembershipsRepository } from './party-memberships';
import { expertsRepository } from './experts';

/**
 * agencies (BAL-356 / ADR-1034) — the expert→agency resolution write layer. Every
 * expert ends the apply wizard's agency step with exactly one `agencyId`, the
 * payout entity of record (earnings: expert → agency → payout). A "freelancer" is
 * simply an agency of one (owner = self), so there is no `isSolo` flag — solo-ness
 * is derived at the UI/result layer from the resolve outcome, never from schema.
 *
 * Ownership is DERIVED from the `role='owner'` membership row (agencies has no
 * owner column); the partial unique `agency_owner_unique_idx` enforces one live
 * owner per agency, making `transferOwnership` a role swap rather than membership
 * churn.
 *
 * `@balo/db` NEVER emits analytics/notifications — the `apps/web` caller maps the
 * structured result to PostHog / the notification engine AFTER the transaction
 * commits. This repo only writes DB rows + immutable audit rows.
 */

/** Thrown by `provision` when a concurrent provision won the domain between the
 * advisory resolve and the authoritative write (`capture.outcome !== 'captured'`).
 * Rolls the whole provision tx back — the web caller returns a retryable error, and
 * on retry resolve sees `partyType==='agency'` → JOIN (self-healing race). Exported
 * so callers can classify it. */
export class AgencyDomainCaptureConflictError extends Error {
  constructor(
    public readonly domain: string,
    public readonly captureOutcome: string
  ) {
    super(`Agency domain capture conflict for "${domain}" (capture outcome: ${captureOutcome})`);
    this.name = 'AgencyDomainCaptureConflictError';
  }
}

export interface AgencySummary {
  id: string;
  name: string;
  memberCount: number;
}

export interface JoinExistingInput {
  agencyId: string;
  userId: string;
  expertProfileId: string;
  /** The actor recorded on the audit rows (the joining user in v1). */
  actorUserId: string;
}

export type JoinExistingResult = {
  outcome: 'joined' | 'already_member';
  membershipId: string;
  agencyId: string;
};

export interface ProvisionInput {
  name: string;
  domain: string;
  userId: string;
  expertProfileId: string;
  actorUserId: string;
}

export interface ProvisionSoloInput {
  name: string;
  userId: string;
  expertProfileId: string;
  actorUserId: string;
}

export interface ProvisionResult {
  agencyId: string;
  ownerMembershipId: string;
}

export interface TransferOwnershipInput {
  agencyId: string;
  fromUserId: string;
  toUserId: string;
  actorUserId: string;
}

/**
 * INSERT a fresh agency + its founding owner membership (role `owner`, joinMethod
 * `owner`, no inviter) + an immutable `agency.created` audit row — all on the
 * caller's tx executor so provision / provisionSolo compose it inside ONE
 * transaction. Returns the new agency id + owner membership id.
 */
async function createOwnerAgency(
  tx: DbExecutor,
  input: { name: string; ownerUserId: string; actorUserId: string }
): Promise<ProvisionResult> {
  const [agency] = await tx
    .insert(agencies)
    .values({ name: input.name })
    .returning({ id: agencies.id });
  if (agency === undefined) {
    throw new Error('createOwnerAgency: agency insert returned no row');
  }

  const [member] = await tx
    .insert(agencyMembers)
    .values({
      agencyId: agency.id,
      userId: input.ownerUserId,
      role: 'owner',
      joinMethod: 'owner',
      invitedById: null,
    })
    .returning({ id: agencyMembers.id });
  if (member === undefined) {
    throw new Error('createOwnerAgency: owner membership insert returned no row');
  }

  await auditEventsRepository.record(
    {
      actorUserId: input.actorUserId,
      action: 'agency.created',
      entityType: 'agency',
      entityId: agency.id,
      metadata: { ownerUserId: input.ownerUserId, ownerMembershipId: member.id },
    },
    tx
  );

  return { agencyId: agency.id, ownerMembershipId: member.id };
}

export const agenciesRepository = {
  /**
   * Read-only summary for the resolve/join UI: `{ id, name, memberCount }` where
   * `memberCount` is the count of LIVE `agency_members` (excludes soft-removed).
   * Returns `undefined` when the agency row is absent (resolver falls back to
   * provision).
   */
  getSummaryById: async (agencyId: string): Promise<AgencySummary | undefined> => {
    const [agency] = await db
      .select({ id: agencies.id, name: agencies.name })
      .from(agencies)
      .where(eq(agencies.id, agencyId))
      .limit(1);
    if (agency === undefined) return undefined;

    const [countRow] = await db
      .select({ value: count() })
      .from(agencyMembers)
      .where(and(eq(agencyMembers.agencyId, agencyId), isNull(agencyMembers.deletedAt)));

    return { id: agency.id, name: agency.name, memberCount: countRow?.value ?? 0 };
  },

  /**
   * JOIN — the signed-in expert joins an agency that already owns their email
   * domain. One tx: idempotent `findOrCreateDomainMembership` (writes
   * `agency_members` role `expert`, joinMethod `domain_match`, ON CONFLICT DO
   * NOTHING) + `linkAgency`. No `party_domains` capture — the agency already owns
   * the domain. `outcome` is `joined` on a fresh membership, `already_member` on a
   * resume / double-click (still (re)links `agencyId`, which is idempotent).
   */
  joinExisting: async (input: JoinExistingInput): Promise<JoinExistingResult> => {
    return db.transaction(async (tx) => {
      const membership = await partyMembershipsRepository.findOrCreateDomainMembership(
        {
          partyType: 'agency',
          partyId: input.agencyId,
          userId: input.userId,
          actorUserId: input.actorUserId,
        },
        tx
      );
      await expertsRepository.linkAgency(input.expertProfileId, input.agencyId, tx);
      return {
        outcome: membership.outcome,
        membershipId: membership.membershipId,
        agencyId: input.agencyId,
      };
    });
  },

  /**
   * PROVISION — a corporate domain with no agency yet: the signer becomes owner of
   * a NEW agency and the domain is captured for it. One tx: `createOwnerAgency` →
   * `partyDomainsRepository.capture` (partyType `agency`, source `auto_captured`) →
   * if `capture.outcome !== 'captured'` THROW `AgencyDomainCaptureConflictError`
   * (rolls back — a concurrent provision won the domain; retry re-resolves to JOIN)
   * → `linkAgency`. Capture is therefore mandatory (self-healing race).
   */
  provision: async (input: ProvisionInput): Promise<ProvisionResult> => {
    return db.transaction(async (tx) => {
      const created = await createOwnerAgency(tx, {
        name: input.name,
        ownerUserId: input.userId,
        actorUserId: input.actorUserId,
      });

      const capture = await partyDomainsRepository.capture(
        {
          partyType: 'agency',
          partyId: created.agencyId,
          domain: input.domain,
          actorUserId: input.actorUserId,
          source: 'auto_captured',
        },
        tx
      );
      if (capture.outcome !== 'captured') {
        throw new AgencyDomainCaptureConflictError(input.domain, capture.outcome);
      }

      await expertsRepository.linkAgency(input.expertProfileId, created.agencyId, tx);
      return created;
    });
  },

  /**
   * SOLO — a freemail / blocked / company-owned domain: the expert gets an
   * independent agency-of-one (owner = self). One tx: `createOwnerAgency` →
   * `linkAgency`. NO `party_domains` capture (a solo domain is never registered to
   * an agency). The name is an internal payout-entity label only — the UI never
   * surfaces it to the solo expert as "your agency".
   */
  provisionSolo: async (input: ProvisionSoloInput): Promise<ProvisionResult> => {
    return db.transaction(async (tx) => {
      const created = await createOwnerAgency(tx, {
        name: input.name,
        ownerUserId: input.userId,
        actorUserId: input.actorUserId,
      });
      await expertsRepository.linkAgency(input.expertProfileId, created.agencyId, tx);
      return created;
    });
  },

  /**
   * Transfer ownership as a role swap (forward-safety for ADR-1034's "transferable"
   * requirement; no UI this ticket). One tx: demote the current owner → `admin`
   * FIRST (frees the single-owner slot so the promote doesn't trip
   * `agency_owner_unique_idx`, checked at statement end), then promote the target →
   * `owner`, then audit `agency.ownership_transferred`. Role UPDATEs, not deletes —
   * so the agency_members v1 soft-delete/RESTRICT caveat does not apply. Throws if
   * there is no live owner to demote or no live target membership to promote.
   */
  transferOwnership: async (input: TransferOwnershipInput, exec?: DbExecutor): Promise<void> => {
    const run = async (tx: DbExecutor): Promise<void> => {
      const [demoted] = await tx
        .update(agencyMembers)
        .set({ role: 'admin' })
        .where(
          and(
            eq(agencyMembers.agencyId, input.agencyId),
            eq(agencyMembers.userId, input.fromUserId),
            eq(agencyMembers.role, 'owner'),
            isNull(agencyMembers.deletedAt)
          )
        )
        .returning({ id: agencyMembers.id });
      if (demoted === undefined) {
        throw new Error(
          `transferOwnership: no live owner membership for user ${input.fromUserId} in agency ${input.agencyId}`
        );
      }

      const [promoted] = await tx
        .update(agencyMembers)
        .set({ role: 'owner' })
        .where(
          and(
            eq(agencyMembers.agencyId, input.agencyId),
            eq(agencyMembers.userId, input.toUserId),
            isNull(agencyMembers.deletedAt)
          )
        )
        .returning({ id: agencyMembers.id });
      if (promoted === undefined) {
        throw new Error(
          `transferOwnership: no live membership for target user ${input.toUserId} in agency ${input.agencyId}`
        );
      }

      await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'agency.ownership_transferred',
          entityType: 'agency',
          entityId: input.agencyId,
          metadata: { fromUserId: input.fromUserId, toUserId: input.toUserId },
        },
        tx
      );
    };
    return exec ? run(exec) : db.transaction(run);
  },
};
