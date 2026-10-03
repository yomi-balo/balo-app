import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  db,
  eq,
  expertProfiles,
  expertsRepository,
  referenceDataRepository,
  users,
  usersRepository,
} from '@balo/db';
import { BOOKABLE_CONTEXT_TYPES } from '@balo/shared/meetings';
import { checkExpertBookingEligibility } from './expert-booking-eligibility.js';

/**
 * BAL-591 — the eligibility guard against a real Postgres: `findNewWorkEligibility` reads
 * real `users` + `expert_profiles` rows, and the guard's refuse/pass split is asserted on
 * every bookable context. The graph is built through the `@balo/db` barrel (see
 * `booking-availability.integration.test.ts` for why test factories are not importable here).
 */

async function seedExpert(): Promise<{ expertProfileId: string; userId: string }> {
  const marker = randomUUID();
  const user = await usersRepository.create({
    workosId: `bal591_${marker}`,
    email: `bal591-${marker}@test.local`,
    firstName: 'Eligibility',
    lastName: 'Expert',
  });
  const vertical = await referenceDataRepository.getSalesforceVertical();
  const profile = await expertsRepository.createDraft({
    userId: user.id,
    verticalId: vertical.id,
    type: 'freelancer',
    firstName: 'Eligibility',
    lastName: 'Expert',
  });
  await db
    .update(expertProfiles)
    .set({ approvedAt: new Date(), searchable: true })
    .where(eq(expertProfiles.id, profile.id));
  return { expertProfileId: profile.id, userId: user.id };
}

async function verdictsFor(
  expertProfileId: string
): Promise<Array<{ ok: boolean; reason?: string }>> {
  const verdicts: Array<{ ok: boolean; reason?: string }> = [];
  for (const contextType of BOOKABLE_CONTEXT_TYPES) {
    verdicts.push(await checkExpertBookingEligibility({ contextType, expertProfileId }));
  }
  return verdicts;
}

describe('checkExpertBookingEligibility (real Postgres)', () => {
  it('passes a live, approved, searchable, available expert on all five contexts', async () => {
    const { expertProfileId } = await seedExpert();

    const verdicts = await verdictsFor(expertProfileId);

    expect(verdicts).toHaveLength(BOOKABLE_CONTEXT_TYPES.length);
    expect(verdicts.every((v) => v.ok)).toBe(true);
  });

  it('passes a PAUSED expert on all five contexts, including an attach to an open case', async () => {
    const { expertProfileId } = await seedExpert();
    await expertsRepository.setAvailableForWork({
      expertProfileId,
      availableForWork: false,
      actorUserId: null,
    });
    expect(await expertsRepository.findNewWorkEligibility(expertProfileId)).toEqual({
      eligible: false,
      reason: 'not_available',
    });

    const verdicts = await verdictsFor(expertProfileId);

    expect(verdicts).toHaveLength(BOOKABLE_CONTEXT_TYPES.length);
    expect(verdicts.every((v) => v.ok)).toBe(true);
  });

  it.each(['suspended', 'inactive'] as const)(
    'refuses an expert whose owner is %s on all five contexts',
    async (status) => {
      const { expertProfileId, userId } = await seedExpert();
      await db.update(users).set({ status }).where(eq(users.id, userId));

      const verdicts = await verdictsFor(expertProfileId);

      expect(verdicts).toHaveLength(BOOKABLE_CONTEXT_TYPES.length);
      expect(verdicts).toEqual(
        BOOKABLE_CONTEXT_TYPES.map(() => ({ ok: false, reason: 'owner_not_live' }))
      );
    }
  );

  it('refuses an expert whose owner is soft-deleted on all five contexts', async () => {
    const { expertProfileId, userId } = await seedExpert();
    await usersRepository.softDelete(userId);

    const verdicts = await verdictsFor(expertProfileId);

    expect(verdicts).toEqual(
      BOOKABLE_CONTEXT_TYPES.map(() => ({ ok: false, reason: 'owner_not_live' }))
    );
  });

  it('refuses a suspended AND paused expert as owner_not_live, not as a pause', async () => {
    const { expertProfileId, userId } = await seedExpert();
    await expertsRepository.setAvailableForWork({
      expertProfileId,
      availableForWork: false,
      actorUserId: null,
    });
    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, userId));

    const [first] = await verdictsFor(expertProfileId);

    expect(first).toEqual({ ok: false, reason: 'owner_not_live' });
  });

  it('refuses a suspended expert who is also not searchable on a non-case context', async () => {
    const { expertProfileId, userId } = await seedExpert();
    await db
      .update(expertProfiles)
      .set({ searchable: false })
      .where(eq(expertProfiles.id, expertProfileId));
    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, userId));

    expect(
      await checkExpertBookingEligibility({
        contextType: 'project_discovery',
        expertProfileId,
      })
    ).toEqual({ ok: false, reason: 'owner_not_live' });
  });

  it('refuses an unknown expert profile as not_found on all five contexts', async () => {
    const verdicts = await verdictsFor(randomUUID());

    expect(verdicts).toEqual(
      BOOKABLE_CONTEXT_TYPES.map(() => ({ ok: false, reason: 'not_found' }))
    );
  });
});
