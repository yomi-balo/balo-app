import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { expertReferralInvites, type ExpertReferralInvite } from '../schema';

export const expertReferralInvitesRepository = {
  /**
   * An approved expert refers a peer by email → creates one referral-invite row.
   *
   * Returns `undefined` when a LIVE invite for this (expert, email) already
   * exists: the partial unique index
   * (`expert_referral_invite_unique_idx WHERE deleted_at IS NULL`) is the
   * `ON CONFLICT` arbiter, so a live duplicate is a clean DO-NOTHING no-op (an
   * idempotent skip) rather than a thrown 23505 — a genuine failure (FK /
   * connection) still throws and is never masked. A previously withdrawn
   * (soft-deleted) invite is outside the partial index, so re-inviting the same
   * email inserts a fresh row.
   *
   * CALLER CONTRACT: the caller lowercases `email` before calling (this layer
   * never normalises input) and publishes the referral-invite domain event ONLY
   * when a new row is returned (a `undefined` result is a duplicate — no event).
   */
  async claim(input: {
    expertProfileId: string;
    email: string;
    invitedByUserId: string;
  }): Promise<ExpertReferralInvite | undefined> {
    const [row] = await db
      .insert(expertReferralInvites)
      .values({
        expertProfileId: input.expertProfileId,
        email: input.email,
        invitedByUserId: input.invitedByUserId,
      })
      .onConflictDoNothing({
        target: [expertReferralInvites.expertProfileId, expertReferralInvites.email],
        // The arbiter is the PARTIAL unique index, so its predicate must be given.
        where: isNull(expertReferralInvites.deletedAt),
      })
      .returning();
    return row;
  },

  /** All live invites for an expert profile, oldest-invited first. */
  async listByExpertProfile(expertProfileId: string): Promise<ExpertReferralInvite[]> {
    return db
      .select()
      .from(expertReferralInvites)
      .where(
        and(
          eq(expertReferralInvites.expertProfileId, expertProfileId),
          isNull(expertReferralInvites.deletedAt)
        )
      )
      .orderBy(asc(expertReferralInvites.invitedAt));
  },
};
