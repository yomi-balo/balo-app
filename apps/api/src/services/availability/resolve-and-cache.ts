import {
  availabilityRulesRepository,
  calendarRepository,
  consultationsRepository,
  expertsRepository,
  platformConfigRepository,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { BILLING_FLOOR_MINUTES } from '@balo/shared/pricing';
import { resolve } from './resolver.js';
import type { BusyBlock } from './types.js';

const log = createLogger('availability-resolve-and-cache');

const DEFAULT_HORIZON_DAYS = 14;

export interface ResolveAndCacheOptions {
  /** Vendor free/busy windows. Defaults to `[]` until BAL-194/195 wires Cronofy. */
  busyBlocks?: BusyBlock[];
  /** UTC instant; injected for testability. Defaults to `new Date()`. */
  now?: Date;
  /** Days to look ahead. Defaults to `RESOLVER_HORIZON_DAYS` env or 14. */
  horizonDays?: number;
  /** Discard sub-windows shorter than this. Defaults to the `platform_config` minimum
   *  consultation length (falling back to `BILLING_FLOOR_MINUTES`). */
  minMinutes?: number;
}

/**
 * Loads everything the resolver needs for one expert, runs the pure resolver,
 * and writes the result to `availability_cache`. This is the impure adapter —
 * the resolver itself stays I/O-free.
 *
 * If the expert profile is missing (or has no timezone), this is a no-op: we
 * log a warning and return null. The BullMQ worker shouldn't blow up on a
 * deleted profile and the cache row is left untouched.
 *
 * Analytics emission stays in the worker (plan §5.2 recommendation), not here.
 */
export async function resolveAndCacheAvailability(
  expertProfileId: string,
  options: ResolveAndCacheOptions = {}
): Promise<{ earliestAvailableAt: Date | null }> {
  const now = options.now ?? new Date();
  // Resolve env-or-default once, then guard, so `horizonEnd` and the resolver
  // input both see the same finite number. A malformed env var (e.g.
  // RESOLVER_HORIZON_DAYS='abc') would otherwise make `horizonEnd` an Invalid
  // Date and silently skip subtracting any consultations.
  const horizonDays = guardedNumber(
    options.horizonDays ?? Number.parseInt(process.env.RESOLVER_HORIZON_DAYS ?? '14', 10),
    DEFAULT_HORIZON_DAYS
  );
  const busyBlocks = options.busyBlocks ?? [];

  const timezone = await expertsRepository.findTimezone(expertProfileId);
  if (!timezone) {
    log.warn(
      { expertProfileId },
      'Skipping availability cache rebuild — expert profile or timezone not found'
    );
    return { earliestAvailableAt: null };
  }

  const horizonEnd = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  const [rules, baloConsultations, config] = await Promise.all([
    availabilityRulesRepository.listByExpertProfileId(expertProfileId),
    consultationsRepository.listConfirmedInRange(expertProfileId, now, horizonEnd),
    platformConfigRepository.get(),
  ]);
  // Minimum bookable window comes from the platform-config singleton (BAL-398), with
  // an explicit option override for testability and a `BILLING_FLOOR_MINUTES` fallback
  // for the impossible "no seeded row" case (defense-in-depth).
  const minMinutes = guardedNumber(
    options.minMinutes ?? config?.minConsultationMinutes ?? BILLING_FLOOR_MINUTES,
    BILLING_FLOOR_MINUTES
  );

  const result = resolve({
    rules: rules.map((r) => ({
      dayOfWeek: r.dayOfWeek,
      startTime: r.startTime,
      endTime: r.endTime,
    })),
    baloConsultations: baloConsultations.map((c) => ({
      startAt: c.startAt,
      endAt: c.endAt,
    })),
    busyBlocks,
    timezone,
    now,
    horizonDays,
    minMinutes,
  });

  await calendarRepository.upsertAvailabilityCache(expertProfileId, result.earliestAvailableAt);

  log.info(
    {
      expertProfileId,
      earliestAvailableAt: result.earliestAvailableAt?.toISOString() ?? null,
      ruleCount: rules.length,
      consultationCount: baloConsultations.length,
      busyBlockCount: busyBlocks.length,
    },
    'Availability cache rebuilt'
  );

  return { earliestAvailableAt: result.earliestAvailableAt };
}

function guardedNumber(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}
