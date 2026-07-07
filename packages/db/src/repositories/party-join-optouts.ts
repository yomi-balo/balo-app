import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { partyJoinOptouts, type PartyType } from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import { auditEventsRepository } from './audit-events';

/**
 * party-join-optouts (BAL-345) — the durable per-user "engine, do not auto-join /
 * auto-request me into this party" marker. Written by the escape hatch (inside the
 * §2.6 orchestrator's single tx); read by the match engine's short-circuit.
 */

export interface OptOutInput {
  partyType: PartyType;
  partyId: string;
  userId: string;
  /** Audit actor — equals `userId` in v1 (self-opt-out); kept for audit symmetry. */
  actorUserId: string;
}

export type OptOutResult = { outcome: 'created' } | { outcome: 'already_opted_out' };

export const partyJoinOptoutsRepository = {
  /**
   * Idempotently record a LIVE opt-out. `INSERT ... ON CONFLICT DO NOTHING` on the
   * `party_join_optouts_unique_idx` arbiter (predicate `deleted_at IS NULL` —
   * mirrors the index verbatim): a returned row → audit `party_join.opted_out` →
   * `created`; a conflict (already opted out) → `already_opted_out`, no double
   * audit. Composes in the caller's tx when `exec` is supplied.
   */
  optOut: async (input: OptOutInput, exec?: DbExecutor): Promise<OptOutResult> => {
    const run = async (tx: DbExecutor): Promise<OptOutResult> => {
      const [inserted] = await tx
        .insert(partyJoinOptouts)
        .values({ partyType: input.partyType, partyId: input.partyId, userId: input.userId })
        .onConflictDoNothing({
          target: [partyJoinOptouts.partyType, partyJoinOptouts.partyId, partyJoinOptouts.userId],
          where: isNull(partyJoinOptouts.deletedAt),
        })
        .returning();

      if (inserted !== undefined) {
        await auditEventsRepository.record(
          {
            actorUserId: input.actorUserId,
            action: 'party_join.opted_out',
            entityType: 'party_join_optout',
            entityId: inserted.id,
            metadata: {
              partyType: input.partyType,
              partyId: input.partyId,
              userId: input.userId,
            },
          },
          tx
        );
        return { outcome: 'created' };
      }
      return { outcome: 'already_opted_out' };
    };
    return exec ? run(exec) : db.transaction(run);
  },

  /** True when a LIVE opt-out exists for (party, user) — the engine's short-circuit. */
  exists: async (partyType: PartyType, partyId: string, userId: string): Promise<boolean> => {
    const [row] = await db
      .select({ id: partyJoinOptouts.id })
      .from(partyJoinOptouts)
      .where(
        and(
          eq(partyJoinOptouts.partyType, partyType),
          eq(partyJoinOptouts.partyId, partyId),
          eq(partyJoinOptouts.userId, userId),
          isNull(partyJoinOptouts.deletedAt)
        )
      )
      .limit(1);
    return row !== undefined;
  },
};
