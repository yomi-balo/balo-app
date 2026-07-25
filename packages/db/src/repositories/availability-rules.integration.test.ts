import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../client';
import { availabilityRules } from '../schema';
import { expertDraftFactory } from '../test/factories';
import { availabilityRulesRepository, type WeeklyRuleInput } from './availability-rules';

/** Count rows for an expert, split by active vs soft-deleted, straight from the table. */
async function countRules(expertProfileId: string): Promise<{ active: number; deleted: number }> {
  const active = await db.query.availabilityRules.findMany({
    where: and(
      eq(availabilityRules.expertProfileId, expertProfileId),
      isNull(availabilityRules.deletedAt)
    ),
  });
  const deleted = await db.query.availabilityRules.findMany({
    where: and(
      eq(availabilityRules.expertProfileId, expertProfileId),
      isNotNull(availabilityRules.deletedAt)
    ),
  });
  return { active: active.length, deleted: deleted.length };
}

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

// ── replaceForExpert ────────────────────────────────────────────────

describe('availabilityRulesRepository.replaceForExpert', () => {
  const monWedFri: WeeklyRuleInput[] = [
    { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
    { dayOfWeek: 3, startTime: '13:00', endTime: '17:00' },
    { dayOfWeek: 5, startTime: '10:00', endTime: '16:00' },
  ];

  it('inserts the incoming set as active rows (HH:mm coerced to HH:mm:ss)', async () => {
    const draft = await expertDraftFactory();

    await availabilityRulesRepository.replaceForExpert(draft.id, monWedFri);

    const rules = await availabilityRulesRepository.listByExpertProfileId(draft.id);
    expect(rules).toHaveLength(3);
    expect(rules[0]?.dayOfWeek).toBe(1);
    // Postgres `time` stores seconds even though the editor writes 'HH:mm'.
    expect(rules[0]?.startTime).toBe('09:00:00');
    expect(rules[0]?.endTime).toBe('12:00:00');

    const counts = await countRules(draft.id);
    expect(counts).toEqual({ active: 3, deleted: 0 });
  });

  it('re-saving the same set leaves exactly N active rows and soft-deletes the old ones', async () => {
    const draft = await expertDraftFactory();

    await availabilityRulesRepository.replaceForExpert(draft.id, monWedFri);
    await availabilityRulesRepository.replaceForExpert(draft.id, monWedFri);

    // No duplication: still exactly 3 ACTIVE rows…
    const active = await availabilityRulesRepository.listByExpertProfileId(draft.id);
    expect(active).toHaveLength(3);

    // …and the first generation is soft-deleted, preserving audit history.
    const counts = await countRules(draft.id);
    expect(counts).toEqual({ active: 3, deleted: 3 });
  });

  it('preserves split-day windows (two ranges on the same dayOfWeek)', async () => {
    const draft = await expertDraftFactory();

    await availabilityRulesRepository.replaceForExpert(draft.id, [
      { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
      { dayOfWeek: 1, startTime: '14:00', endTime: '18:00' },
    ]);

    const rules = await availabilityRulesRepository.listByExpertProfileId(draft.id);
    expect(rules).toHaveLength(2);
    expect(rules[0]?.dayOfWeek).toBe(1);
    expect(rules[0]?.startTime).toBe('09:00:00');
    expect(rules[1]?.dayOfWeek).toBe(1);
    expect(rules[1]?.startTime).toBe('14:00:00');
  });

  it('an empty set clears the schedule (soft-deletes all, inserts nothing)', async () => {
    const draft = await expertDraftFactory();
    await availabilityRulesRepository.replaceForExpert(draft.id, monWedFri);

    await availabilityRulesRepository.replaceForExpert(draft.id, []);

    expect(await availabilityRulesRepository.listByExpertProfileId(draft.id)).toEqual([]);
    expect(await countRules(draft.id)).toEqual({ active: 0, deleted: 3 });
  });

  it('composes inside a caller transaction via the executor param', async () => {
    const draft = await expertDraftFactory();

    await db.transaction(async (tx) => {
      await availabilityRulesRepository.replaceForExpert(draft.id, monWedFri, tx);
    });

    expect(await availabilityRulesRepository.listByExpertProfileId(draft.id)).toHaveLength(3);
  });

  it('rolls back the replace when the enclosing transaction throws', async () => {
    const draft = await expertDraftFactory();
    // Seed a committed baseline.
    await availabilityRulesRepository.replaceForExpert(draft.id, [
      { dayOfWeek: 2, startTime: '08:00', endTime: '10:00' },
    ]);

    await expect(
      db.transaction(async (tx) => {
        await availabilityRulesRepository.replaceForExpert(draft.id, monWedFri, tx);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // The baseline survives untouched: the soft-delete + re-insert both rolled back.
    const rules = await availabilityRulesRepository.listByExpertProfileId(draft.id);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.dayOfWeek).toBe(2);
    expect(await countRules(draft.id)).toEqual({ active: 1, deleted: 0 });
  });

  it('isolates the replace to the target expert', async () => {
    const alice = await expertDraftFactory();
    const bob = await expertDraftFactory();
    await availabilityRulesRepository.replaceForExpert(bob.id, [
      { dayOfWeek: 4, startTime: '09:00', endTime: '17:00' },
    ]);

    await availabilityRulesRepository.replaceForExpert(alice.id, monWedFri);

    expect(await availabilityRulesRepository.listByExpertProfileId(bob.id)).toHaveLength(1);
    expect(await availabilityRulesRepository.listByExpertProfileId(alice.id)).toHaveLength(3);
  });
});

// ── deleteAllForExpert ──────────────────────────────────────────────

describe('availabilityRulesRepository.deleteAllForExpert', () => {
  it('soft-deletes every active rule; list returns []', async () => {
    const draft = await expertDraftFactory();
    await availabilityRulesRepository.replaceForExpert(draft.id, [
      { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
      { dayOfWeek: 2, startTime: '09:00', endTime: '12:00' },
    ]);

    await availabilityRulesRepository.deleteAllForExpert(draft.id);

    expect(await availabilityRulesRepository.listByExpertProfileId(draft.id)).toEqual([]);
    expect(await countRules(draft.id)).toEqual({ active: 0, deleted: 2 });
  });

  it('is a no-op for an expert with no active rules', async () => {
    const draft = await expertDraftFactory();

    await availabilityRulesRepository.deleteAllForExpert(draft.id);

    expect(await countRules(draft.id)).toEqual({ active: 0, deleted: 0 });
  });
});

// ── hasActiveRules ──────────────────────────────────────────────────

describe('availabilityRulesRepository.hasActiveRules', () => {
  it('is true when the expert has at least one active rule', async () => {
    const draft = await expertDraftFactory();
    await availabilityRulesRepository.replaceForExpert(draft.id, [
      { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
    ]);

    expect(await availabilityRulesRepository.hasActiveRules(draft.id)).toBe(true);
  });

  it('is false after the schedule is cleared', async () => {
    const draft = await expertDraftFactory();
    await availabilityRulesRepository.replaceForExpert(draft.id, [
      { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
    ]);
    await availabilityRulesRepository.deleteAllForExpert(draft.id);

    expect(await availabilityRulesRepository.hasActiveRules(draft.id)).toBe(false);
  });

  it('is false for an unknown expert id', async () => {
    expect(await availabilityRulesRepository.hasActiveRules(randomUUID())).toBe(false);
  });
});
