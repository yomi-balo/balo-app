import 'server-only';

import { promoCodesRepository } from '@balo/db';
import { derivePromoCodesDTO, type PromoCodesAdminDTO } from './promo-codes-view';

/**
 * promo-codes-admin — the `server-only` loader for the admin promo-code surface
 * (BAL-384). Reads EVERY active (non-soft-deleted) code via `list()` and the whole
 * (empty-until-BAL-383) redemption ledger via `listAllRedemptions()`, then folds both
 * through the pure derivers in `promo-codes-view.ts`, returning a fully serialisable DTO
 * (ISO strings + precomputed labels/booleans — no `Date` crosses the RSC boundary).
 *
 * The two reads are independent, so they run concurrently (`Promise.all`). No try/catch —
 * errors propagate to the page's error boundary, which owns the `log.error` + rethrow
 * (same pattern as `engagements-oversight.ts`). `now` is injected so the derived
 * status/counts are deterministic in tests.
 */
export async function loadPromoCodesAdmin(now: Date = new Date()): Promise<PromoCodesAdminDTO> {
  const [promos, redemptions] = await Promise.all([
    promoCodesRepository.list(),
    promoCodesRepository.listAllRedemptions(),
  ]);
  return derivePromoCodesDTO(promos, redemptions, now);
}
