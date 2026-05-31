import { describe, it, expect } from 'vitest';
import { db } from '../client';
import { availabilityRules } from '../schema';
import { expertDraftFactory } from '../test/factories';
import { availabilityRulesRepository } from './availability-rules';

// ── listByExpertProfileId ───────────────────────────────────────────

describe('availabilityRulesRepository.listByExpertProfileId', () => {
  it('returns rules ordered by dayOfWeek then startTime', async () => {
    const draft = await expertDraftFactory();

    // Insert in a deliberately jumbled order to confirm ORDER BY does the work.
    await db.insert(availabilityRules).values([
      {
        expertProfileId: draft.id,
        dayOfWeek: 3, // Wednesday
        startTime: '13:00:00',
        endTime: '17:00:00',
      },
      {
        expertProfileId: draft.id,
        dayOfWeek: 1, // Monday
        startTime: '09:00:00',
        endTime: '12:00:00',
      },
      {
        expertProfileId: draft.id,
        dayOfWeek: 1, // Monday — second window same day
        startTime: '14:00:00',
        endTime: '18:00:00',
      },
    ]);

    const rules = await availabilityRulesRepository.listByExpertProfileId(draft.id);

    expect(rules).toHaveLength(3);
    expect(rules[0]?.dayOfWeek).toBe(1);
    expect(rules[0]?.startTime).toBe('09:00:00');
    expect(rules[1]?.dayOfWeek).toBe(1);
    expect(rules[1]?.startTime).toBe('14:00:00');
    expect(rules[2]?.dayOfWeek).toBe(3);
    expect(rules[2]?.startTime).toBe('13:00:00');
  });

  it('excludes soft-deleted rules', async () => {
    const draft = await expertDraftFactory();

    await db.insert(availabilityRules).values([
      {
        expertProfileId: draft.id,
        dayOfWeek: 1,
        startTime: '09:00:00',
        endTime: '12:00:00',
      },
      {
        expertProfileId: draft.id,
        dayOfWeek: 2,
        startTime: '09:00:00',
        endTime: '12:00:00',
        deletedAt: new Date(),
      },
    ]);

    const rules = await availabilityRulesRepository.listByExpertProfileId(draft.id);

    expect(rules).toHaveLength(1);
    expect(rules[0]?.dayOfWeek).toBe(1);
  });

  it('isolates rules between experts', async () => {
    const alice = await expertDraftFactory();
    const bob = await expertDraftFactory();

    await db.insert(availabilityRules).values([
      {
        expertProfileId: alice.id,
        dayOfWeek: 1,
        startTime: '09:00:00',
        endTime: '12:00:00',
      },
      {
        expertProfileId: bob.id,
        dayOfWeek: 2,
        startTime: '14:00:00',
        endTime: '17:00:00',
      },
    ]);

    const aliceRules = await availabilityRulesRepository.listByExpertProfileId(alice.id);
    const bobRules = await availabilityRulesRepository.listByExpertProfileId(bob.id);

    expect(aliceRules).toHaveLength(1);
    expect(aliceRules[0]?.expertProfileId).toBe(alice.id);
    expect(aliceRules[0]?.dayOfWeek).toBe(1);

    expect(bobRules).toHaveLength(1);
    expect(bobRules[0]?.expertProfileId).toBe(bob.id);
    expect(bobRules[0]?.dayOfWeek).toBe(2);
  });

  it('returns an empty array for an expert with no rules', async () => {
    const draft = await expertDraftFactory();

    const rules = await availabilityRulesRepository.listByExpertProfileId(draft.id);

    expect(rules).toEqual([]);
  });
});
