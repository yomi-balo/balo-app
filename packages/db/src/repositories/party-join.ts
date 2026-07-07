import { db } from '../client';
import type { PartyType } from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import { partyJoinRequestsRepository } from './party-join-requests';
import { partyMembershipsRepository } from './party-memberships';
import { partyJoinOptoutsRepository } from './party-join-optouts';

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
 */

export interface LeaveDomainPartyInput {
  partyType: PartyType;
  partyId: string;
  userId: string;
}

export type LeaveDomainPartyResult = {
  path: 'auto' | 'request';
  /** false on a no-op double-submit (nothing was withdrawn/removed). */
  changed: boolean;
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
   */
  leaveDomainParty: async (
    input: LeaveDomainPartyInput,
    exec?: DbExecutor
  ): Promise<LeaveDomainPartyResult> => {
    const run = async (tx: DbExecutor): Promise<LeaveDomainPartyResult> => {
      // 1. Prefer the request path: a LIVE pending request for this (user, party)?
      const pending = await partyJoinRequestsRepository.findPendingByUserAndParty(
        input.partyType,
        input.partyId,
        input.userId,
        tx
      );
      if (pending !== undefined) {
        await partyJoinRequestsRepository.withdraw(
          { requestId: pending.id, actorUserId: input.userId },
          tx
        );
        await partyJoinOptoutsRepository.optOut({ ...input, actorUserId: input.userId }, tx);
        return { path: 'request', changed: true };
      }

      // 2. Else the auto path: soft-remove the live domain_match membership (no-op
      //    if none), then record the opt-out (idempotent).
      const removed = await partyMembershipsRepository.softRemoveDomainMembership(
        { ...input, actorUserId: input.userId },
        tx
      );
      await partyJoinOptoutsRepository.optOut({ ...input, actorUserId: input.userId }, tx);
      return { path: 'auto', changed: removed.outcome === 'removed' };
    };
    return exec ? run(exec) : db.transaction(run);
  },
};
