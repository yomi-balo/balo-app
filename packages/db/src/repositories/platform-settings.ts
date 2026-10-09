import { and, eq, isNull } from 'drizzle-orm';
import { createLogger } from '@balo/shared/logging';
import {
  parsePlatformSetting,
  type PlatformSettingKey,
  type PlatformSettingValues,
} from '@balo/shared/platform-settings';
import { db } from '../client';
import { platformSettings } from '../schema';
import type { DbExecutor } from './_shared/db-executor';

const log = createLogger('platform-settings-repository');

/**
 * Where a setting's value came from. `default_missing`: no live row. `default_invalid`: a live
 * row whose value the registry rejected. Both fall back to the registry's code default.
 */
export type PlatformSettingSource = 'stored' | 'default_missing' | 'default_invalid';

export interface PlatformSettingRead<K extends PlatformSettingKey> {
  value: PlatformSettingValues[K];
  source: PlatformSettingSource;
}

export const platformSettingsRepository = {
  /**
   * Read one runtime setting at CALL TIME, typed and parsed by `@balo/shared/platform-settings`.
   * Never throws for a bad or absent value: it returns the registry default and logs a warning
   * naming the key and the source, never the raw value.
   *
   * Takes an optional executor so a caller can read the setting inside its own transaction (the
   * reapply cooldown is read under `reopenApplication`'s profile lock).
   */
  async get<K extends PlatformSettingKey>(
    key: K,
    executor?: DbExecutor
  ): Promise<PlatformSettingRead<K>> {
    const exec = executor ?? db;
    const [row] = await exec
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(and(eq(platformSettings.key, key), isNull(platformSettings.deletedAt)))
      .limit(1);

    if (row === undefined) {
      const fallback = parsePlatformSetting(key, undefined);
      log.warn({ key, source: 'default_missing' }, 'Platform setting missing; using default');
      return { value: fallback.value, source: 'default_missing' };
    }

    const parsed = parsePlatformSetting(key, row.value);
    if (!parsed.valid) {
      log.warn({ key, source: 'default_invalid' }, 'Platform setting invalid; using default');
      return { value: parsed.value, source: 'default_invalid' };
    }
    return { value: parsed.value, source: 'stored' };
  },
};
