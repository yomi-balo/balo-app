import { eq } from 'drizzle-orm';
import { db } from '../client';
import { platformConfig, type PlatformConfig } from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/**
 * platform_config repository (BAL-398 / ADR-1044) — data access for the SINGLETON
 * platform-config row (id = 1). The migration seeds the row, so `get()` always finds it
 * on a migrated DB; `setMinConsultationMinutes` upserts on the constant PK so the row is
 * self-healing even if the seed were ever missing.
 *
 * No `<15` app-level guard lives here: the DB CHECK (`platform_config_min_ge_floor`) is the
 * structural money-floor backstop, and the caller's Zod (`isValidMinConsultationMinutes`)
 * is the friendly guard. This layer is pure persistence.
 */
export const platformConfigRepository = {
  /**
   * The singleton platform-config row (id = 1), or `undefined` if it has never been seeded.
   * TX-COMPOSABLE: pass a `tx` to read under a parent transaction (e.g. to read the current
   * minimum in the SAME snapshot as a dependent write), or omit `exec` to read on the base
   * `db`.
   */
  async get(exec: DbExecutor = db): Promise<PlatformConfig | undefined> {
    const [row] = await exec.select().from(platformConfig).where(eq(platformConfig.id, 1)).limit(1);
    return row;
  },

  /**
   * Set the platform minimum consultation length (whole minutes) — an UPSERT on the constant
   * singleton PK: inserts the row if it is somehow absent, else updates it in place. Records
   * `updatedBy` = the acting admin and stamps `updated_at` explicitly in the conflict set —
   * `$onUpdateFn` does NOT fire on the `onConflictDoUpdate` path, so we set the timestamp by
   * hand (mirrors the established upsert pattern in `fx-display-rates.ts` / `calendar.ts`).
   * TX-COMPOSABLE via `exec`. Values below the billing floor are rejected by the DB CHECK
   * (the caller's Zod is the friendly pre-check). Throws if the upsert returns no row (a true
   * fault).
   */
  async setMinConsultationMinutes(
    minutes: number,
    actorUserId: string,
    exec: DbExecutor = db
  ): Promise<PlatformConfig> {
    const [row] = await exec
      .insert(platformConfig)
      .values({ id: 1, minConsultationMinutes: minutes, updatedBy: actorUserId })
      .onConflictDoUpdate({
        target: platformConfig.id,
        set: { minConsultationMinutes: minutes, updatedBy: actorUserId, updatedAt: new Date() },
      })
      .returning();
    if (row === undefined) {
      throw new Error('Failed to upsert platform_config');
    }
    return row;
  },
};
