import { db } from '../client';
import type { PartyType } from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import { partyJoinRequestsRepository } from './party-join-requests';
import { partyMembershipsRepository } from './party-memberships';
import { partyJoinOptoutsRepository } from './party-join-optouts';
import { agenciesRepository } from './agencies';
import { expertsRepository } from './experts';

/**
 * party-join (BAL-345 §2.6) — the escape-hatch orchestrator. Mutates up to three
 * tables (request/membership + opt-out) and MUST be atomic: a crash between the
 * soft-remove/withdraw and the opt-out would leave the two out of sync. So it
 * opens ONE `db.transaction` and threads `tx` into every write (it CANNOT be
 * three sequential self-wrapping repo calls). It also owns auto-vs-request branch
 * selection and idempotency.
 *
 * `requestId` is NEVER client-supplied — the live pending request is resolved
 * server-side via `findPendingByUserAndParty(..., userId)` inside the same tx.
 *
 * Leaving an AGENCY also moves the leaver's expert profile off it: when the removed membership
 * was the agency their profile links, the same tx provisions them a fresh agency-of-one and
 * repoints `expert_profiles.agency_id` to it, so engagements created afterwards are not pinned to
 * the agency they left.
 */

export interface LeaveDomainPartyInput {
  partyType: PartyType;
  partyId: string;
  userId: string;
  /**
   * The name for the agency-of-one created when an expert leaves the agency their profile
   * links. The web caller builds it; required only on that path (a leave that needs it and
   * lacks it throws, rolling the leave back).
   */
  soloAgencyName?: string;
}

export type LeaveDomainPartyResult = {
  path: 'auto' | 'request';
  /** false on a no-op double-submit (nothing was withdrawn/removed). */
  changed: boolean;
  /** The agency-of-one the leaver's expert profile now links, or null when none was created. */
  soloAgencyId: string | null;
};

export const partyJoinRepository = {
  /**
   * Leave a domain-driven party and record the durable opt-out, atomically:
   *  - a LIVE pending request exists → withdraw it + opt-out (`path: 'request'`)
   *  - else → soft-remove the live `domain_match` membership + opt-out (`path:
   *    'auto'`; `changed` reflects whether a membership was actually removed)
   * All writes commit or roll back together. Idempotent: a double-submit finds no
   * pending request and no live domain_match membership → opt-out DO-NOTHINGs →
   * `changed: false` (the caller skips duplicate analytics on `!changed`).
   *
   * An APPROVED request is terminal (not pending) with a live domain_match
   * membership → the auto path runs and reports `path: 'auto'`. Acceptable in v1.
   *
   * The auto path creates an agency-of-one (`soloAgencyId`) only when ALL hold: the party is an
   * agency, a membership was actually removed, and the leaver's expert profile still links that
   * agency (read `FOR UPDATE`, so a concurrent link or repoint is serialised). Otherwise nothing
   * is created and `soloAgencyId` is null. Only `domain_match` memberships are removable, so the
   * leaver is never the agency's owner.
   */
  leaveDomainParty: async (
    input: LeaveDomainPartyInput,
    exec?: DbExecutor
  ): Promise<LeaveDomainPartyResult> => {
    const { soloAgencyName, ...party } = input;
    const actor = { ...party, actorUserId: party.userId };
    const run = async (tx: DbExecutor): Promise<LeaveDomainPartyResult> => {
      // 1. Prefer the request path: a LIVE pending request for this (user, party)?
      const pending = await partyJoinRequestsRepository.findPendingByUserAndParty(
        party.partyType,
        party.partyId,
        party.userId,
        tx
      );
      if (pending !== undefined) {
        await partyJoinRequestsRepository.withdraw(
          { requestId: pending.id, actorUserId: party.userId },
          tx
        );
        await partyJoinOptoutsRepository.optOut(actor, tx);
        return { path: 'request', changed: true, soloAgencyId: null };
      }

      // 2. Else the auto path: soft-remove the live domain_match membership (no-op
      //    if none), then record the opt-out (idempotent).
      const removed = await partyMembershipsRepository.softRemoveDomainMembership(actor, tx);
      await partyJoinOptoutsRepository.optOut(actor, tx);
      const changed = removed.outcome === 'removed';
      if (party.partyType !== 'agency' || !changed) {
        return { path: 'auto', changed, soloAgencyId: null };
      }

      // 3. Leaving the agency the expert profile links: repoint it to a fresh agency-of-one.
      const expertProfileId = await expertsRepository.findProfileIdLinkedToAgencyForUpdate(
        party.userId,
        party.partyId,
        tx
      );
      if (expertProfileId === undefined) {
        return { path: 'auto', changed, soloAgencyId: null };
      }
      if (soloAgencyName === undefined) {
        throw new Error(
          `leaveDomainParty: soloAgencyName is required to repoint expert profile ${expertProfileId} off agency ${party.partyId}`
        );
      }
      const solo = await agenciesRepository.provisionSolo(
        {
          name: soloAgencyName,
          userId: party.userId,
          actorUserId: party.userId,
          expertProfileId,
          replacesAgencyId: party.partyId,
        },
        tx
      );
      return { path: 'auto', changed, soloAgencyId: solo.agencyId };
    };
    return exec ? run(exec) : db.transaction(run);
  },
};
