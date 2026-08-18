import {
  availabilityOverridesRepository,
  availabilityRulesRepository,
  calendarRepository,
  consultationsRepository,
  expertsRepository,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  CONSULTATION_LOAD_PAD_MS,
  expandOverrideBlocks,
  toResolverConsultations,
  toResolverRules,
} from './resolver-inputs.js';
import { resolve } from './resolver.js';
import type { BusyBlock } from './types.js';
import { vendorBusyProvider, VendorBusyUnavailableError } from './vendor-busy.js';

const log = createLogger('availability-resolve-and-cache');

const DEFAULT_HORIZON_DAYS = 14;
const DEFAULT_MIN_MINUTES = 15;

/**
 * ⚠⚠ round-2 fix #11 — `status` distinguishes an ACTUAL rebuild from a SKIP (settings
 * missing, or the vendor busy read was untrustworthy — see the two `return` sites below).
 * `earliestAvailableAt: null` is ambiguous by itself: it is also the legitimate answer for an
 * expert who genuinely has no open slot. Callers (the BullMQ worker in
 * `jobs/availability-cache.ts`) MUST branch on `status`, not on whether `earliestAvailableAt`
 * is `null`, before reporting success or firing `AVAILABILITY_CACHE_REBUILT`.
 */
export interface ResolveAndCacheResult {
  status: 'completed' | 'skipped';
  /** Present only when `status === 'skipped'`. */
  skipReason?: 'expert_settings_not_found' | 'vendor_busy_unavailable' | 'vendor_read_error';
  earliestAvailableAt: Date | null;
}

export interface ResolveAndCacheOptions {
  /**
   * ⚠ A SEED/TEST-ONLY OVERRIDE OF VENDOR FREE/BUSY — **NOT** the production source, which is
   * `vendorBusyProvider` (`./vendor-busy.ts`) and is shared with the booking gate. When this is
   * supplied the provider is not consulted at all.
   *
   * ⚠ AND IT IS THE ONE PLACE ADVERTISE AND ACCEPT CAN STILL DIVERGE, deliberately and with a
   * named consequence: `apps/api/src/services/seed/seed-service.ts` passes SYNTHETIC busy
   * blocks here, so in a seeded environment the advertised `earliest_available_at` accounts for
   * them and `isWindowAvailableForExpert` does not. That is acceptable because the blocks are
   * fixture data with no vendor behind them — but it is why "the two reads agree" is a claim
   * about PRODUCTION, not about a dev seed. A real vendor belongs in the provider, never here.
   */
  busyBlocks?: BusyBlock[];
  /** UTC instant; injected for testability. Defaults to `new Date()`. */
  now?: Date;
  /** Days to look ahead. Defaults to `RESOLVER_HORIZON_DAYS` env or 14. */
  horizonDays?: number;
  /** Discard sub-windows shorter than this. Defaults to `MIN_CONSULTATION_MINUTES` env or 15. */
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
): Promise<ResolveAndCacheResult> {
  const now = options.now ?? new Date();

  // Load the expert's resolver settings (timezone + booking rules) first.
  const settings = await expertsRepository.findResolverSettings(expertProfileId);
  if (!settings) {
    log.warn(
      { expertProfileId },
      'Skipping availability cache rebuild — expert profile or timezone not found'
    );
    return {
      status: 'skipped',
      skipReason: 'expert_settings_not_found',
      earliestAvailableAt: null,
    };
  }
  const timezone = settings.timezone;

  // Precedence: explicit option > valid `RESOLVER_HORIZON_DAYS` env > default.
  // The look-ahead horizon is platform-level config (BAL-398), never a per-expert
  // setting. Guarded so `horizonEnd` and the resolver input always see the same
  // finite number (a malformed env var would otherwise make `horizonEnd` an
  // Invalid Date and silently skip subtracting any consultations).
  const horizonDays = resolveHorizonDays(options.horizonDays);
  const minMinutes = guardedNumber(
    options.minMinutes ?? Number.parseInt(process.env.MIN_CONSULTATION_MINUTES ?? '15', 10),
    DEFAULT_MIN_MINUTES
  );
  const horizonEnd = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  // ⚠ THE SAME `CONSULTATION_LOAD_PAD_MS` `window-availability.ts` PADS ITS WINDOW WITH, and
  // BAL-129 added it here to CLOSE A DIVERGENCE: this read used to be bare `[now, horizonEnd]`,
  // so a consultation that ended just before `now` was invisible to the advertised answer while
  // the booking gate loaded it, grew it by `bufferAfterMinutes` and refused the slot. Direction
  // was safe (accept stricter than advertise ⇒ a 409 on a slot we had shown as free), but a 409
  // on an advertised slot is still a bug the user experiences. Both ranges now pad identically.
  const loadFrom = new Date(now.getTime() - CONSULTATION_LOAD_PAD_MS);
  const loadTo = new Date(horizonEnd.getTime() + CONSULTATION_LOAD_PAD_MS);

  // Vendor free/busy comes from the SHARED port unless a caller overrode it (seed only) — see
  // `ResolveAndCacheOptions.busyBlocks` and `./vendor-busy.ts`.
  //
  // ⚠⚠ BAL-396 §9.4 — THE ADVERTISE PATH SKIPS THE CACHE WRITE, IT DOES NOT FAIL THE JOB.
  // `vendorBusyProvider.listBusyBlocks` THROWS `VendorBusyUnavailableError` when it cannot
  // trust its answer (an unreadable connection, or a vendor read that failed). Overwriting
  // `availability_cache` with a result computed WITHOUT that data would replace last-known-
  // good with a possibly-wrong "more available than reality" answer, which is worse than a
  // stale one — so the rejection is turned into a tagged result BEFORE `Promise.all` sees it
  // (a raw rejection there would abort the whole rebuild the same way, but this makes the
  // "vendor failure ≠ every other read failing" distinction explicit rather than incidental).
  type BusyBlocksOutcome =
    | { readonly ok: true; readonly value: BusyBlock[] }
    | { readonly ok: false; readonly error: unknown };
  const busyBlocksSource: Promise<BusyBlocksOutcome> = (
    options.busyBlocks === undefined
      ? vendorBusyProvider.listBusyBlocks(expertProfileId, loadFrom, loadTo)
      : Promise.resolve(options.busyBlocks)
  ).then(
    (value): BusyBlocksOutcome => ({ ok: true, value }),
    (error: unknown): BusyBlocksOutcome => ({ ok: false, error })
  );

  const [rules, baloConsultations, overrides, busyOutcome] = await Promise.all([
    availabilityRulesRepository.listByExpertProfileId(expertProfileId),
    consultationsRepository.listConfirmedInRange(expertProfileId, loadFrom, loadTo),
    availabilityOverridesRepository.listUpcoming(expertProfileId),
    busyBlocksSource,
  ]);

  if (!busyOutcome.ok) {
    const err = busyOutcome.error;
    const isVendorUnavailable = err instanceof VendorBusyUnavailableError;
    log.warn(
      {
        expertProfileId,
        error: err instanceof Error ? err.message : String(err),
      },
      isVendorUnavailable
        ? 'Skipping availability cache rebuild — vendor busy read unavailable; leaving last-known-good cache in place'
        : 'Skipping availability cache rebuild — unexpected error reading vendor busy; leaving last-known-good cache in place'
    );
    return {
      status: 'skipped',
      skipReason: isVendorUnavailable ? 'vendor_busy_unavailable' : 'vendor_read_error',
      earliestAvailableAt: null,
    };
  }
  const busyBlocks = busyOutcome.value;

  // ⚠ ALL THREE ROW PROJECTIONS ARE SHARED WITH BAL-129's `window-availability.ts` (see
  // `./resolver-inputs.ts`), as are the load pad above and the vendor-busy port. What this
  // function computes is what every surface ADVERTISES; what that one computes is what a
  // booking is ACCEPTED against. If the two ever read the same rows differently, the platform
  // would accept a booking for a window it advertises as blocked, or refuse one it advertises
  // as free.
  const overrideBlocks: BusyBlock[] = expandOverrideBlocks(overrides, timezone);

  const result = resolve({
    rules: toResolverRules(rules),
    baloConsultations: toResolverConsultations(baloConsultations),
    busyBlocks,
    overrideBlocks,
    timezone,
    now,
    horizonDays,
    minMinutes,
    bufferBeforeMinutes: settings.bufferBeforeMinutes,
    bufferAfterMinutes: settings.bufferAfterMinutes,
    minimumNoticeMinutes: settings.minimumNoticeMinutes,
  });

  await calendarRepository.upsertAvailabilityCache(expertProfileId, result.earliestAvailableAt);

  log.info(
    {
      expertProfileId,
      earliestAvailableAt: result.earliestAvailableAt?.toISOString() ?? null,
      ruleCount: rules.length,
      consultationCount: baloConsultations.length,
      busyBlockCount: busyBlocks.length,
      overrideCount: overrides.length,
    },
    'Availability cache rebuilt'
  );

  return { status: 'completed', earliestAvailableAt: result.earliestAvailableAt };
}

function guardedNumber(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve the look-ahead horizon. Precedence: an explicit option, then a valid
 * `RESOLVER_HORIZON_DAYS` env override, then `DEFAULT_HORIZON_DAYS`. A missing or
 * non-numeric env var is ignored so the default wins. The horizon is platform
 * config (BAL-398), not a per-expert column.
 */
function resolveHorizonDays(optionValue: number | undefined): number {
  if (optionValue !== undefined) {
    return guardedNumber(optionValue, DEFAULT_HORIZON_DAYS);
  }
  const envRaw = process.env.RESOLVER_HORIZON_DAYS;
  if (envRaw !== undefined) {
    const parsed = Number.parseInt(envRaw, 10);
    // Must be strictly positive — a 0 or negative horizon collapses the window to
    // empty ("never available"), so a misconfigured env falls through to the default.
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_HORIZON_DAYS;
}
