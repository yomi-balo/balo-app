import 'server-only';

import { platformConfigRepository } from '@balo/db';
import { BILLING_FLOOR_MINUTES } from '@balo/shared/pricing';

/**
 * platform-config-admin — the `server-only` loader for the admin platform-config surface
 * (BAL-398). Reads the singleton `platform_config` row via `get()` and folds it into a
 * fully-serialisable DTO (plain numbers only — no `Date` crosses the RSC boundary; we do
 * not surface `updatedAt`/`updatedBy` in v1).
 *
 * The migration seeds the row, so `get()` normally returns it; the `?? BILLING_FLOOR_MINUTES`
 * fallback covers the impossible "no seeded row" case (defense-in-depth, same posture as
 * the resolver). No try/catch — errors propagate to the page's error boundary, which owns
 * the `log.error` + rethrow (same pattern as `promo-codes-admin.ts`).
 */

export interface PlatformConfigAdminDTO {
  /** The current platform-wide minimum consultation length, in whole minutes. */
  minConsultationMinutes: number;
  /** The hard billing floor (whole minutes) — drives the input `min=` attr + copy. */
  billingFloorMinutes: number;
}

export async function loadPlatformConfigAdmin(): Promise<PlatformConfigAdminDTO> {
  const config = await platformConfigRepository.get();
  return {
    minConsultationMinutes: config?.minConsultationMinutes ?? BILLING_FLOOR_MINUTES,
    billingFloorMinutes: BILLING_FLOOR_MINUTES,
  };
}
