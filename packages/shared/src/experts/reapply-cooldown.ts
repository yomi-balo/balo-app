/**
 * experts/reapply-cooldown — when a declined applicant may start a new application.
 *
 * The cooldown length is runtime configuration (`platform_settings`
 * `expert_reapply_cooldown_days`, read through `@balo/shared/platform-settings`); these helpers
 * take it as a parameter so the enforcement (`expertsRepository.reopenApplication`), the
 * wizard's declined state and the decline email all derive the date the same way.
 *
 * PURE. No I/O; the clock is a parameter, never `Date.now()`.
 *
 * ⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Earliest UTC offset anywhere in use (UTC+14). Opening the gate this far ahead of
 * `availableAt` guarantees every local clock has already turned over to the calendar date the
 * copy shows, in every timezone.
 */
const UTC_PLUS_14_OFFSET_MS = 14 * 60 * 60 * 1000;

/**
 * The instant a new application may be started: 00:00Z of the UTC calendar date that is
 * `cooldownDays` whole days after `decidedAt`. Midnight UTC keeps this an exact match for the
 * calendar date every surface displays via `formatLongUtc`. `null` when `decidedAt` is null — a
 * legacy or imported `rejected` row carries no decision timestamp, so there is no cooldown to
 * wait out.
 */
export function reapplyAvailableAt(decidedAt: Date | null, cooldownDays: number): Date | null {
  if (decidedAt === null) return null;
  const shifted = new Date(decidedAt.getTime() + cooldownDays * MS_PER_DAY);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/**
 * True while `now` is strictly before `reapplyAvailableAt(decidedAt, cooldownDays) − 14h`, so the
 * gate opens early enough that an applicant in any timezone is already on the calendar date the
 * copy promised, never after it.
 */
export function isReapplyCooldownActive(
  decidedAt: Date | null,
  cooldownDays: number,
  now: Date
): boolean {
  const availableAt = reapplyAvailableAt(decidedAt, cooldownDays);
  if (availableAt === null) return false;
  return now.getTime() < availableAt.getTime() - UTC_PLUS_14_OFFSET_MS;
}
