import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { expertReferralInvites } from '../schema';
import { userFactory, expertDraftFactory } from '../test/factories';
import { expertReferralInvitesRepository } from './expert-referral-invites';

describe('expertReferralInvitesRepository.claim', () => {
  it('inserts and returns the row with all fields set', async () => {
    const expert = await expertDraftFactory();
    const inviter = await userFactory();

    const row = await expertReferralInvitesRepository.claim({
      expertProfileId: expert.id,
      email: 'peer@example.com',
      invitedByUserId: inviter.id,
    });

    expect(row).toBeDefined();
    if (row === undefined) throw new Error('expected claim to create a row');
    expect(row.id).toBeDefined();
    expect(row.expertProfileId).toBe(expert.id);
    expect(row.email).toBe('peer@example.com');
    expect(row.invitedByUserId).toBe(inviter.id);
    expect(row.invitedAt).toBeInstanceOf(Date);
    expect(row.deletedAt).toBeNull();
  });

  it('is idempotent — a duplicate LIVE (profile, email) claim returns undefined and keeps one live row', async () => {
    const expert = await expertDraftFactory();
    const inviter = await userFactory();

    const first = await expertReferralInvitesRepository.claim({
      expertProfileId: expert.id,
      email: 'peer@example.com',
      invitedByUserId: inviter.id,
    });
    expect(first).toBeDefined();

    // The partial unique index is the ON CONFLICT arbiter → DO NOTHING → undefined.
    const dup = await expertReferralInvitesRepository.claim({
      expertProfileId: expert.id,
      email: 'peer@example.com',
      invitedByUserId: inviter.id,
    });
    expect(dup).toBeUndefined();

    const live = await expertReferralInvitesRepository.listByExpertProfile(expert.id);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(first?.id);
  });

  it('re-claims a withdrawn (soft-deleted) invite as a fresh live row (partial index frees the slot)', async () => {
    const expert = await expertDraftFactory();
    const inviter = await userFactory();

    const first = await expertReferralInvitesRepository.claim({
      expertProfileId: expert.id,
      email: 'peer@example.com',
      invitedByUserId: inviter.id,
    });
    if (first === undefined) throw new Error('expected first claim to create a row');

    // Withdraw (soft-delete) the invite.
    await db
      .update(expertReferralInvites)
      .set({ deletedAt: new Date() })
      .where(eq(expertReferralInvites.id, first.id));

    // Same (profile, email) again — the soft-deleted row is outside the partial
    // unique index, so this inserts a fresh row rather than conflicting.
    const reclaimed = await expertReferralInvitesRepository.claim({
      expertProfileId: expert.id,
      email: 'peer@example.com',
      invitedByUserId: inviter.id,
    });

    expect(reclaimed).toBeDefined();
    expect(reclaimed?.id).not.toBe(first.id);
    expect(reclaimed?.deletedAt).toBeNull();

    // Exactly one LIVE row (the new one); the withdrawn row is excluded.
    const live = await expertReferralInvitesRepository.listByExpertProfile(expert.id);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(reclaimed?.id);
  });

  it('allows two different emails under the same profile', async () => {
    const expert = await expertDraftFactory();
    const inviter = await userFactory();

    const a = await expertReferralInvitesRepository.claim({
      expertProfileId: expert.id,
      email: 'a@example.com',
      invitedByUserId: inviter.id,
    });
    const b = await expertReferralInvitesRepository.claim({
      expertProfileId: expert.id,
      email: 'b@example.com',
      invitedByUserId: inviter.id,
    });

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a?.id).not.toBe(b?.id);

    const live = await expertReferralInvitesRepository.listByExpertProfile(expert.id);
    expect(live).toHaveLength(2);
  });

  it('allows the same email under two different profiles', async () => {
    const expertOne = await expertDraftFactory();
    const expertTwo = await expertDraftFactory();
    const inviter = await userFactory();

    const one = await expertReferralInvitesRepository.claim({
      expertProfileId: expertOne.id,
      email: 'peer@example.com',
      invitedByUserId: inviter.id,
    });
    const two = await expertReferralInvitesRepository.claim({
      expertProfileId: expertTwo.id,
      email: 'peer@example.com',
      invitedByUserId: inviter.id,
    });

    expect(one).toBeDefined();
    expect(two).toBeDefined();
    expect(one?.id).not.toBe(two?.id);
    await expect(
      expertReferralInvitesRepository.listByExpertProfile(expertOne.id)
    ).resolves.toHaveLength(1);
    await expect(
      expertReferralInvitesRepository.listByExpertProfile(expertTwo.id)
    ).resolves.toHaveLength(1);
  });

  it('throws on an unknown expertProfileId (FK violation)', async () => {
    const inviter = await userFactory();

    await expect(
      expertReferralInvitesRepository.claim({
        expertProfileId: randomUUID(),
        email: 'peer@example.com',
        invitedByUserId: inviter.id,
      })
    ).rejects.toThrow();
  });
});

describe('expertReferralInvitesRepository.listByExpertProfile', () => {
  it('returns live rows in invitedAt order and excludes soft-deleted', async () => {
    const expert = await expertDraftFactory();
    const inviter = await userFactory();

    // Three live invites with explicit ascending invitedAt, plus one soft-deleted.
    const [older] = await db
      .insert(expertReferralInvites)
      .values({
        expertProfileId: expert.id,
        email: 'older@example.com',
        invitedByUserId: inviter.id,
        invitedAt: new Date('2026-01-01T00:00:00Z'),
      })
      .returning();
    const [middle] = await db
      .insert(expertReferralInvites)
      .values({
        expertProfileId: expert.id,
        email: 'middle@example.com',
        invitedByUserId: inviter.id,
        invitedAt: new Date('2026-02-01T00:00:00Z'),
      })
      .returning();
    const [newer] = await db
      .insert(expertReferralInvites)
      .values({
        expertProfileId: expert.id,
        email: 'newer@example.com',
        invitedByUserId: inviter.id,
        invitedAt: new Date('2026-03-01T00:00:00Z'),
      })
      .returning();
    const [gone] = await db
      .insert(expertReferralInvites)
      .values({
        expertProfileId: expert.id,
        email: 'gone@example.com',
        invitedByUserId: inviter.id,
        invitedAt: new Date('2026-04-01T00:00:00Z'),
        deletedAt: new Date(),
      })
      .returning();

    const rows = await expertReferralInvitesRepository.listByExpertProfile(expert.id);
    const ids = rows.map((r) => r.id);

    expect(ids).toEqual([older?.id, middle?.id, newer?.id]);
    // The soft-deleted row is excluded — assert on its id (ids are row UUIDs, not
    // emails), otherwise the check is trivially true and proves nothing.
    expect(ids).not.toContain(gone?.id);
    // Ascending invitedAt — every row's invitedAt <= the next. Destructure + guard
    // instead of index-position `!` (house convention under noUncheckedIndexedAccess).
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      if (prev && cur) {
        expect(prev.invitedAt.getTime()).toBeLessThanOrEqual(cur.invitedAt.getTime());
      }
    }
  });

  it('returns an empty array for a profile with no invites', async () => {
    const expert = await expertDraftFactory();
    const rows = await expertReferralInvitesRepository.listByExpertProfile(expert.id);
    expect(rows).toEqual([]);
  });
});
