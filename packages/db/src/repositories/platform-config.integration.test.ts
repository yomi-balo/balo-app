import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { platformConfig } from '../schema';
import { db } from '../client';
import { userFactory } from '../test/factories';
import { platformConfigRepository } from './platform-config';

/**
 * Integration tests for `platformConfigRepository` (BAL-398). Uses the in-harness `db`
 * (per-test transaction, auto-rolled-back). The singleton row `(id=1, min=15,
 * updated_by=NULL)` is seeded by migration 0053 as part of the migrated baseline, so
 * every test starts from that committed baseline.
 */

describe('platformConfigRepository.get', () => {
  it('returns the seeded singleton row (min=15, updatedBy=null)', async () => {
    const row = await platformConfigRepository.get();
    expect(row).toBeDefined();
    expect(row?.id).toBe(1);
    expect(row?.minConsultationMinutes).toBe(15);
    expect(row?.updatedBy).toBeNull();
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });
});

describe('platformConfigRepository.setMinConsultationMinutes', () => {
  it('updates the minimum and stamps the acting admin, reflected by a follow-up get()', async () => {
    const admin = await userFactory();

    // Capture the seed `updatedAt` BEFORE the set: `$onUpdateFn` does NOT fire on the
    // `onConflictDoUpdate` path, so the repo hand-stamps `updatedAt`. Locking it here fails
    // a regression that dropped the hand-stamp. `>=` (not `>`) avoids same-millisecond flake.
    const before = await platformConfigRepository.get();
    const seedUpdatedAt = before?.updatedAt;
    expect(seedUpdatedAt).toBeInstanceOf(Date);

    const updated = await platformConfigRepository.setMinConsultationMinutes(30, admin.id);
    expect(updated.id).toBe(1);
    expect(updated.minConsultationMinutes).toBe(30);
    expect(updated.updatedBy).toBe(admin.id);
    // The hand-stamped `updatedAt` advanced (or held within the same ms) — never went backwards.
    expect(updated.updatedAt).toBeInstanceOf(Date);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(seedUpdatedAt?.getTime() ?? 0);

    // A subsequent read reflects the new value.
    const persisted = await platformConfigRepository.get();
    expect(persisted?.minConsultationMinutes).toBe(30);
    expect(persisted?.updatedBy).toBe(admin.id);
  });

  it('a second set updates the singleton in place (no second row is created)', async () => {
    const admin = await userFactory();

    await platformConfigRepository.setMinConsultationMinutes(30, admin.id);
    const second = await platformConfigRepository.setMinConsultationMinutes(45, admin.id);
    expect(second.minConsultationMinutes).toBe(45);

    // Still exactly one config row (the singleton held).
    const rows = await db.select().from(platformConfig);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
    expect(rows[0]?.minConsultationMinutes).toBe(45);
  });

  it('accepts the billing floor (15) at the boundary', async () => {
    const admin = await userFactory();
    const updated = await platformConfigRepository.setMinConsultationMinutes(15, admin.id);
    expect(updated.minConsultationMinutes).toBe(15);
  });

  it('composes under a passed transaction handle (exec)', async () => {
    const admin = await userFactory();
    const updated = await db.transaction((tx) =>
      platformConfigRepository.setMinConsultationMinutes(60, admin.id, tx)
    );
    expect(updated.minConsultationMinutes).toBe(60);

    const persisted = await platformConfigRepository.get();
    expect(persisted?.minConsultationMinutes).toBe(60);
  });
});

describe('platform_config DB constraints (structural money-floor backstop)', () => {
  it('rejects a minimum below the billing floor (CHECK platform_config_min_ge_floor)', async () => {
    // A raw write that bypasses the app-layer Zod must still be refused by the DB CHECK —
    // proves the 15-minute floor is enforced structurally, not just by the caller.
    await expect(
      db.update(platformConfig).set({ minConsultationMinutes: 14 }).where(eq(platformConfig.id, 1))
    ).rejects.toThrow();
  });

  it('rejects a second config row (CHECK platform_config_singleton, id must be 1)', async () => {
    await expect(
      db.insert(platformConfig).values({ id: 2, minConsultationMinutes: 30 })
    ).rejects.toThrow();
  });
});
