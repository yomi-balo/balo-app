import {
  availabilityOverridesRepository,
  availabilityRulesRepository,
  consultationsRepository,
} from '@balo/db';
import type {
  AvailabilityRuleRow,
  ConsultationWindowRow,
  OverrideDateRange,
} from './resolver-inputs.js';
import type { BusyBlock } from './types.js';
import { vendorBusyProvider } from './vendor-busy.js';

export type BusyBlocksOutcome =
  | { readonly ok: true; readonly value: BusyBlock[] }
  | { readonly ok: false; readonly error: unknown };

export interface LoadedResolverInputs {
  rules: AvailabilityRuleRow[];
  baloConsultations: ConsultationWindowRow[];
  overrides: OverrideDateRange[];
  busyOutcome: BusyBlocksOutcome;
}

/**
 * THE shared loader: three Balo-owned reads plus the vendor free/busy read, run CONCURRENTLY,
 * with the vendor rejection TAGGED into a value so `Promise.all` can carry it and each caller
 * decides its own fail-closed behaviour (`window-availability.ts` → `false`;
 * `resolve-and-cache.ts` → skip the write; BAL-236's route → 503 `unavailable`).
 *
 * ⚠ EXTRACTED, NOT INVENTED. `window-availability.ts` and `resolve-and-cache.ts` used to carry
 * the same 35-line load-and-tag block independently — a third copy for BAL-236 would have been
 * a guaranteed jscpd hit and a guaranteed drift risk (D1).
 *
 * ⚠ ⚠ `vendorBusyProvider.listBusyBlocks(...)` MUST STAY ON ONE PHYSICAL LINE. Invariant Scan C
 * (`apps/api/src/invariants/sync-token-parity.test.ts`) greps for that exact contiguous
 * substring on a non-comment code line; a prettier-style member-access break makes the scan
 * blind, not the call wrong.
 *
 * ⚠ Callers pass their own `[loadFrom, loadTo]`, both already padded by
 * `CONSULTATION_LOAD_PAD_MS` — the pad is correctness, not slack (`resolver-inputs.ts:44`).
 *
 * ⚠ `busyBlocksOverride` exists ONLY for `resolve-and-cache.ts`'s seed/test-only
 * `ResolveAndCacheOptions.busyBlocks` (see that file's docblock for the divergence it
 * deliberately accepts). When supplied, the vendor port is NOT consulted at all — the override
 * is short-circuited straight into an already-`ok` outcome — so a seeded environment's
 * advertised answer accounts for synthetic blocks while the booking gate (which never passes
 * this) does not.
 */
export async function loadResolverInputs(
  expertProfileId: string,
  loadFrom: Date,
  loadTo: Date,
  busyBlocksOverride?: BusyBlock[]
): Promise<LoadedResolverInputs> {
  // ⚠ Scan C (`invariants/sync-token-parity.test.ts`) greps for the exact contiguous
  // substring `vendorBusyProvider.listBusyBlocks` on a non-comment code line — keep that call
  // on ONE physical line if this is ever reformatted; splitting the member access across
  // lines (as a pure `prettier`-style break would) makes the scan blind, not the call wrong.
  const vendorBusyRead =
    busyBlocksOverride === undefined
      ? vendorBusyProvider.listBusyBlocks(expertProfileId, loadFrom, loadTo)
      : Promise.resolve(busyBlocksOverride);
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

  return { rules, baloConsultations, overrides, busyOutcome };
}
