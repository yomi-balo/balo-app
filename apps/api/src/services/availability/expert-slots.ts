import { expertsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  AVAILABILITY_LEAD_GUARD_MINUTES,
  MAX_AVAILABILITY_WINDOW_DAYS,
} from '@balo/shared/availability';
import {
  CONSULTATION_LOAD_PAD_MS,
  expandOverrideBlocks,
  toResolverConsultations,
  toResolverRules,
} from './resolver-inputs.js';
import { loadResolverInputs } from './load-resolver-inputs.js';
import { listBookableSlots, type BookableSlot } from './slot-grid.js';
import { VendorBusyUnavailableError } from './vendor-busy.js';

const log = createLogger('availability-expert-slots');

export interface ExpertSlotsResult {
  status: 'ok' | 'not_configured' | 'no_slots' | 'unavailable' | 'expert_not_found';
  /** `''` when `status === 'expert_not_found'`, and on a breaker-suppressed `unavailable`
   *  (`expert-slots-cache.ts`) where no settings read happened. Never consumed on either path —
   *  both answer with a body that names no timezone. */
  expertTimezone: string;
  generatedAt: Date;
  slots: BookableSlot[];
}

/**
 * BAL-236 — computes the FULL `MAX_AVAILABILITY_WINDOW_DAYS` (= 14-day advertise horizon) grid
 * for one expert, uncached.
 *
 * ⚠ THE HORIZON IS THE ADVERTISE HORIZON, NOT A THIRD ONE. apiroc skill Constraint 6: "Cap
 * `freeBusy.get` to the horizon of the caller's question — do not invent a third." An earlier
 * draft always read and cached 60 days regardless of what `days` asked for; widening it again
 * belongs in BAL-400, together with an ADR-1021 amendment. See the constant's docblock.
 *
 * The Redis cache and the in-process single-flight coalescing live in `./expert-slots-cache.ts`.
 *
 * Status determination mirrors `resolve-and-cache.ts`'s "branch on status, never on an empty
 * array" (plan §3.3):
 *   1. No resolver settings (missing profile/timezone) → `expert_not_found`.
 *   2. No published weekly rules at all → `not_configured`. Checked BEFORE the vendor outcome
 *      on purpose (D8): an expert with no schedule is unbookable regardless of calendar
 *      health, and "we can't reach your calendar" on top of "you have no hours" is noise.
 *   3. `VendorBusyUnavailableError` → `unavailable`. Any OTHER vendor-read error rethrows —
 *      vendor distrust is not the same failure class as a `@balo/db` outage.
 *   4. Empty grid → `no_slots`.
 *   5. Otherwise → `ok`.
 */
export async function computeExpertSlots(
  expertProfileId: string,
  now: Date
): Promise<ExpertSlotsResult> {
  const settings = await expertsRepository.findResolverSettings(expertProfileId);
  if (!settings) {
    return { status: 'expert_not_found', expertTimezone: '', generatedAt: now, slots: [] };
  }

  const horizonDays = MAX_AVAILABILITY_WINDOW_DAYS;
  const horizonEnd = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);
  // Same pad every other resolver caller applies (`resolver-inputs.ts`'s
  // `CONSULTATION_LOAD_PAD_MS`) — correctness, not slack.
  const loadFrom = new Date(now.getTime() - CONSULTATION_LOAD_PAD_MS);
  const loadTo = new Date(horizonEnd.getTime() + CONSULTATION_LOAD_PAD_MS);

  const { rules, baloConsultations, overrides, busyOutcome } = await loadResolverInputs(
    expertProfileId,
    loadFrom,
    loadTo
  );

  if (rules.length === 0) {
    return {
      status: 'not_configured',
      expertTimezone: settings.timezone,
      generatedAt: now,
      slots: [],
    };
  }

  if (!busyOutcome.ok) {
    const err = busyOutcome.error;
    if (err instanceof VendorBusyUnavailableError) {
      log.warn(
        { expertProfileId, error: err.message },
        'Availability unavailable — vendor busy read untrustworthy (fail-closed)'
      );
      return {
        status: 'unavailable',
        expertTimezone: settings.timezone,
        generatedAt: now,
        slots: [],
      };
    }
    throw err;
  }
  const busyBlocks = busyOutcome.value;
  const overrideBlocks = expandOverrideBlocks(overrides, settings.timezone);

  const slots = listBookableSlots({
    rules: toResolverRules(rules),
    baloConsultations: toResolverConsultations(baloConsultations),
    busyBlocks,
    overrideBlocks,
    timezone: settings.timezone,
    now,
    horizonDays,
    bufferBeforeMinutes: settings.bufferBeforeMinutes,
    bufferAfterMinutes: settings.bufferAfterMinutes,
    minimumNoticeMinutes: settings.minimumNoticeMinutes,
    // §1.3 — cache-staleness guard band; this grid is served from a short-TTL response cache.
    leadGuardMinutes: AVAILABILITY_LEAD_GUARD_MINUTES,
  });

  return {
    status: slots.length === 0 ? 'no_slots' : 'ok',
    expertTimezone: settings.timezone,
    generatedAt: now,
    slots,
  };
}
