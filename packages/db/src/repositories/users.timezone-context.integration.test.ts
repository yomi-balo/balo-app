import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { availabilityRules, expertProfiles, users } from '../schema';
import { expertDraftFactory, expertFactory, userFactory } from '../test/factories';
import { availabilityRulesRepository } from './availability-rules';
import { usersRepository } from './users';

const WEEKDAY_RULES = [
  { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
  { dayOfWeek: 2, startTime: '09:00', endTime: '17:00' },
];

describe('usersRepository.findTimezoneContext', () => {
  it('returns the saved zone with no expert for a client', async () => {
    const user = await userFactory({ timezone: 'Europe/London' });

    const result = await usersRepository.findTimezoneContext(user.id, undefined);

    expect(result).toEqual({ savedTimezone: 'Europe/London', expert: null });
  });

  it('returns a null saved zone when the user has none', async () => {
    const user = await userFactory({ timezone: null });

    const result = await usersRepository.findTimezoneContext(user.id, undefined);

    expect(result).toEqual({ savedTimezone: null, expert: null });
  });

  it('returns expert: null for a profile another user owns', async () => {
    const viewer = await userFactory({ timezone: 'Europe/London' });
    const other = await expertFactory();
    await availabilityRulesRepository.replaceForExpert(other.id, WEEKDAY_RULES);

    const result = await usersRepository.findTimezoneContext(viewer.id, other.id);

    expect(result).toEqual({ savedTimezone: 'Europe/London', expert: null });
  });

  it('returns the schedule zone, flags and rules for an approved expert', async () => {
    const profile = await expertFactory();
    await db
      .update(expertProfiles)
      .set({ timezone: 'Australia/Sydney' })
      .where(eq(expertProfiles.id, profile.id));
    await availabilityRulesRepository.replaceForExpert(profile.id, WEEKDAY_RULES);

    const result = await usersRepository.findTimezoneContext(profile.userId, profile.id);

    expect(result?.expert).toEqual({
      expertProfileId: profile.id,
      timezone: 'Australia/Sydney',
      approved: true,
      availableForWork: true,
      rules: WEEKDAY_RULES.map((rule) => ({
        ...rule,
        startTime: expect.stringMatching(/^09:00/),
        endTime: expect.stringMatching(/^17:00/),
      })),
    });
  });

  it('returns approved: false and no rules for a pending expert', async () => {
    const profile = await expertDraftFactory();
    await availabilityRulesRepository.replaceForExpert(profile.id, WEEKDAY_RULES);

    const result = await usersRepository.findTimezoneContext(profile.userId, profile.id);

    expect(result?.expert).toMatchObject({
      expertProfileId: profile.id,
      approved: false,
      rules: [],
    });
  });

  it('returns availableForWork: false for a paused expert', async () => {
    const profile = await expertFactory();
    await db
      .update(expertProfiles)
      .set({ availableForWork: false })
      .where(eq(expertProfiles.id, profile.id));

    const result = await usersRepository.findTimezoneContext(profile.userId, profile.id);

    expect(result?.expert).toMatchObject({ approved: true, availableForWork: false });
  });

  it('excludes soft-deleted rules', async () => {
    const profile = await expertFactory();
    const [firstRule] = WEEKDAY_RULES;
    if (firstRule === undefined) throw new Error('WEEKDAY_RULES is empty');
    await availabilityRulesRepository.replaceForExpert(profile.id, WEEKDAY_RULES);
    await availabilityRulesRepository.replaceForExpert(profile.id, [firstRule]);

    const softDeleted = await db
      .select({ id: availabilityRules.id })
      .from(availabilityRules)
      .where(eq(availabilityRules.expertProfileId, profile.id));
    expect(softDeleted.length).toBeGreaterThan(1);

    const result = await usersRepository.findTimezoneContext(profile.userId, profile.id);

    expect(result?.expert?.rules).toHaveLength(1);
    expect(result?.expert?.rules[0]?.dayOfWeek).toBe(1);
  });

  it('returns null for a soft-deleted user', async () => {
    const user = await userFactory();
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, user.id));

    const result = await usersRepository.findTimezoneContext(user.id, undefined);

    expect(result).toBeNull();
  });

  it('returns null for an unknown user', async () => {
    const result = await usersRepository.findTimezoneContext(
      '00000000-0000-4000-8000-000000000000',
      undefined
    );

    expect(result).toBeNull();
  });
});
