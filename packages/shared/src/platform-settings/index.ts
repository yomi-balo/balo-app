/**
 * platform-settings — the typed key registry for the `platform_settings` table: runtime
 * configuration that can change without a build (BAL-557).
 *
 * The table is a generic `key text` / `value jsonb` store; THIS module owns every key's type,
 * its parse and its code default. `@balo/db`'s repository reads the live row and runs
 * `parsePlatformSetting`; every reader (server logic AND copy) goes through that one read, so
 * the enforced value and the displayed value cannot disagree.
 *
 * PURE. No I/O, no logging, no clock. The caller decides what to log when a value is invalid.
 *
 * ⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER.
 */

/** Every registered key and the type its value parses to. */
export interface PlatformSettingValues {
  /**
   * Whole days after an expert application is declined before the applicant may start a new
   * application. Enforced server-side at call time by `expertsRepository.reopenApplication`;
   * the wizard's declined state and the decline email read the same value.
   */
  expert_reapply_cooldown_days: number;
}

export type PlatformSettingKey = keyof PlatformSettingValues;

/** One registry entry: how to read a stored jsonb value, and what to use when it can't be read. */
export interface PlatformSettingDefinition<T> {
  /** `undefined` when the raw value is not a valid `T`. */
  parse: (raw: unknown) => T | undefined;
  defaultValue: T;
}

/** The upper bound for the reapply cooldown — a year. A larger stored value is invalid. */
export const EXPERT_REAPPLY_COOLDOWN_DAYS_MAX = 365;

function parseCooldownDays(raw: unknown): number | undefined {
  if (
    typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= 0 &&
    raw <= EXPERT_REAPPLY_COOLDOWN_DAYS_MAX
  ) {
    return raw;
  }
  return undefined;
}

export const PLATFORM_SETTINGS: {
  readonly [K in PlatformSettingKey]: PlatformSettingDefinition<PlatformSettingValues[K]>;
} = {
  expert_reapply_cooldown_days: { parse: parseCooldownDays, defaultValue: 60 },
};

/** The result of parsing one stored value: `valid: false` means `value` is the code default. */
export interface ParsedPlatformSetting<T> {
  value: T;
  valid: boolean;
}

/**
 * Parse a stored jsonb value for `key`. An invalid value never throws: it falls back to the
 * registry default with `valid: false`, so a bad `UPDATE` degrades to the default rather than
 * breaking every page that reads it.
 */
export function parsePlatformSetting<K extends PlatformSettingKey>(
  key: K,
  raw: unknown
): ParsedPlatformSetting<PlatformSettingValues[K]> {
  const definition: PlatformSettingDefinition<PlatformSettingValues[K]> = PLATFORM_SETTINGS[key];
  const parsed = definition.parse(raw);
  if (parsed === undefined) return { value: definition.defaultValue, valid: false };
  return { value: parsed, valid: true };
}
