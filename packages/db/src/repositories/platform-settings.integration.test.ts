import { describe, it, expect } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { platformSettings } from '../schema';
import { platformSettingsRepository } from './platform-settings';

const KEY = 'expert_reapply_cooldown_days';

/** Overwrite the seeded live row's raw jsonb value (rolled back with the test). */
async function setStoredValue(value: unknown): Promise<void> {
  await db
    .update(platformSettings)
    .set({ value })
    .where(and(eq(platformSettings.key, KEY), isNull(platformSettings.deletedAt)));
}

describe('platformSettingsRepository.get', () => {
  it('reads the value the migration seeded', async () => {
    await expect(platformSettingsRepository.get(KEY)).resolves.toEqual({
      value: 60,
      source: 'stored',
    });
  });

  it('reads a changed value at call time', async () => {
    await setStoredValue(7);

    await expect(platformSettingsRepository.get(KEY)).resolves.toEqual({
      value: 7,
      source: 'stored',
    });
  });

  it('reads on a caller-supplied transaction', async () => {
    const read = await db.transaction(async (tx) => {
      await tx
        .update(platformSettings)
        .set({ value: 12 })
        .where(and(eq(platformSettings.key, KEY), isNull(platformSettings.deletedAt)));
      return platformSettingsRepository.get(KEY, tx);
    });

    expect(read).toEqual({ value: 12, source: 'stored' });
  });

  it.each([
    ['a string', 'abc'],
    ['a negative number', -3],
    ['a fractional number', 2.5],
    ['an object', { days: 10 }],
  ])('falls back to the default for %s', async (_label, raw) => {
    await setStoredValue(raw);

    await expect(platformSettingsRepository.get(KEY)).resolves.toEqual({
      value: 60,
      source: 'default_invalid',
    });
  });

  it('falls back to the default when the only row is soft-deleted', async () => {
    await db
      .update(platformSettings)
      .set({ value: 5, deletedAt: new Date() })
      .where(eq(platformSettings.key, KEY));

    await expect(platformSettingsRepository.get(KEY)).resolves.toEqual({
      value: 60,
      source: 'default_missing',
    });
  });

  it('allows a replacement live row once the old one is soft-deleted, and reads it', async () => {
    await db
      .update(platformSettings)
      .set({ deletedAt: new Date() })
      .where(eq(platformSettings.key, KEY));
    await db.insert(platformSettings).values({ key: KEY, value: 30 });

    await expect(platformSettingsRepository.get(KEY)).resolves.toEqual({
      value: 30,
      source: 'stored',
    });
  });

  it('refuses a second live row for the same key', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(platformSettings).values({ key: KEY, value: 30 });
      })
    ).rejects.toThrow();
  });
});
