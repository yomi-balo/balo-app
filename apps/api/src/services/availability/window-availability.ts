import {
  availabilityOverridesRepository,
  availabilityRulesRepository,
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
import { isWindowBookable } from './resolver.js';
import type { BusyBlock } from './types.js';
import { vendorBusyProvider, VendorBusyUnavailableError } from './vendor-busy.js';

const log = createLogger('availability-window-check');

/**
 * BAL-129 (§2a) — THE IMPURE ADAPTER for `isWindowBookable`: load one expert's published
 * availability and their already-booked slots, then ask the pure resolver whether a proposed
 * window fits.
 *
 * ⚠⚠ THIS IS THE AGGREGATE AVAILABILITY-DoS BOUND — AND IT **BOUNDS** THE ABUSE, IT DOES NOT
 * CLOSE IT. `POST /meetings`'s tenancy gate closes booking on a STRANGER'S calendar and
 * `@balo/shared/meetings`'s constants cap ONE window's shape — neither bounds how much of a
 * reachable expert's calendar a legitimate company member may consume. This does: a caller can
 * only take slots the expert published, and each booking writes a `confirmed` consultation that
 * the very next call reads as busy. See `isWindowBookable`'s docblock for the full argument,
 * including the residual (it is a check, not a lock).
 *
 * ⚠ WHAT REMAINS OPEN, STATED SO NOBODY READS "BOUNDED" AS "SOLVED". Every slot an expert
 * published is still consumable, and in BAL-129 a consumed slot stays consumed:
 *   · BOOKINGS ARE IRREVERSIBLE ON THIS BRANCH. `cancelMeeting` / `softDeleteMeeting` exist in
 *     `services/meetings/meeting-availability.ts` and have ZERO production callers — only tests
 *     — so no shipped surface frees a slot again. Cancel is BAL-410's.
 *   · BOOKINGS ARE SILENT. Nothing publishes `booking.confirmed` (the rule and templates are a
 *     documented orphan; wiring them is BAL-400's), so an expert whose calendar is being walked
 *     is not told about it by the platform.
 * The two rate limits on `POST /meetings` are what keep the walk slow; they are not a cure.
 *
 * ⚠ READ-ONLY, DELIBERATELY, AND NOT VIA `resolveAndCacheAvailability`. That function WRITES
 * `availability_cache` and answers a different question ("when is this expert next free?",
 * bounded by a 14-day display horizon). An authorization check on a request path must not
 * mutate a cache as a side effect, and it must not be limited by a display horizon when the
 * booking horizon is 365 days.
 *
 * ⚠ FAILS CLOSED. A missing expert profile (or one with no resolver settings) returns `false`
 * rather than "no constraints found, allow it". The caller answers a clean `409`.
 */

/**
 * `true` when `[start, end)` lies wholly inside `expertProfileId`'s published availability and
 * overlaps no busy interval. Every input instant is UTC; `now` is injected.
 */
export async function isWindowAvailableForExpert(
  expertProfileId: string,
  start: Date,
  end: Date,
  now: Date
): Promise<boolean> {
  const settings = await expertsRepository.findResolverSettings(expertProfileId);
  if (!settings) {
    // No profile, or no timezone to interpret the weekly rules in. Nothing about this window
    // can be verified, so it is not bookable.
    log.warn(
      { expertProfileId },
      'Booking window rejected — expert profile or timezone not found (fail-closed)'
    );
    return false;
  }

  // Pad the consultation read on BOTH sides by the SHARED `CONSULTATION_LOAD_PAD_MS`
  // (`./resolver-inputs.ts`), which `resolveAndCacheAvailability` applies to its own range too.
  // `combineBusyIntervals` grows every busy interval by the booking buffers, so a consultation
  // that ends shortly before `start` (or begins shortly after `end`) can still overlap the
  // proposed window once padded.
  const loadFrom = new Date(start.getTime() - CONSULTATION_LOAD_PAD_MS);
  const loadTo = new Date(end.getTime() + CONSULTATION_LOAD_PAD_MS);

  // ⚠ THE SHARED PORT, NOT AN INLINE `[]`. `resolveAndCacheAvailability` reads vendor
  // free/busy from this SAME object (BAL-396 §9), so the booking gate gets whatever vendor
  // is wired there in the same commit. An inline `[]` here would have kept double-booking
  // over an expert's real external commitments with nothing failing.
  //
  // ⚠⚠ BAL-396 §9.4 — FAILS CLOSED. `vendorBusyProvider.listBusyBlocks` THROWS
  // `VendorBusyUnavailableError` when it cannot trust its answer (an unreadable connection,
  // or a vendor read that failed) — it MUST be caught, never allowed to propagate, otherwise
  // `POST /meetings` would answer a `500` where it should answer a clean `409`. Caught
  // SEPARATELY from the three Balo-owned reads below: this function's own fail-closed
  // contract is specifically about vendor trust, not about a `@balo/db` outage, which stays
  // an uncaught 500 exactly as it always has.
  //
  // ⚠⚠ round-2 fix #10 — RUN CONCURRENTLY WITH THE THREE BALO-OWNED READS, NOT BEFORE THEM.
  // A prior version `await`ed the vendor round-trip serially, ahead of `Promise.all` below —
  // paying a full un-overlapped Apiroc round-trip on every `POST /meetings`, even one the
  // pure resolver would have cheaply rejected anyway (outside published hours, etc.). The
  // fail-closed catch is still required; it just no longer needs to be serial to get it. This
  // mirrors `resolve-and-cache.ts`'s identical `BusyBlocksOutcome` tagging (its §9.4 comment)
  // exactly, so the two call sites can't drift on how they turn a rejection into a value the
  // `Promise.all` can carry.
  type BusyBlocksOutcome =
    | { readonly ok: true; readonly value: BusyBlock[] }
    | { readonly ok: false; readonly error: unknown };
  // ⚠ Scan C (`invariants/sync-token-parity.test.ts`) greps for the exact contiguous substring
  // `vendorBusyProvider.listBusyBlocks` on a non-comment code line — keep that call on ONE
  // physical line if this is ever reformatted; splitting the member access across lines (as a
  // pure `prettier`-style break would) makes the scan blind, not the call wrong.
  const vendorBusyRead = vendorBusyProvider.listBusyBlocks(expertProfileId, loadFrom, loadTo);
  const busyBlocksSource: Promise<BusyBlocksOutcome> = vendorBusyRead.then(
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
    if (err instanceof VendorBusyUnavailableError) {
      log.warn(
        {
          expertProfileId,
          error: err.message,
        },
        'Booking window rejected — vendor busy read unavailable (fail-closed)'
      );
      return false;
    }
    throw err;
  }
  const busyBlocks = busyOutcome.value;

  return isWindowBookable({
    // ⚠ THE SAME PROJECTIONS `resolveAndCacheAvailability` USES (`./resolver-inputs.ts`), so
    // what is ACCEPTED here and what is ADVERTISED there cannot read the rows differently.
    rules: toResolverRules(rules),
    baloConsultations: toResolverConsultations(baloConsultations),
    busyBlocks,
    overrideBlocks: expandOverrideBlocks(overrides, settings.timezone),
    timezone: settings.timezone,
    now,
    start,
    end,
    bufferBeforeMinutes: settings.bufferBeforeMinutes,
    bufferAfterMinutes: settings.bufferAfterMinutes,
    minimumNoticeMinutes: settings.minimumNoticeMinutes,
  });
}
