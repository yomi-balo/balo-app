'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { promoCodesRepository, PromoCodeNotFoundError } from '@balo/db';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { actorHoldsPlatformCapability } from '@/lib/authz/live-platform-capability';
import { log } from '@/lib/logging';
import { deactivatePromoCodeSchema } from './promo-code-schema';

const PERMISSION_DENIED = 'You do not have permission to do this.';
// A malformed id and a missing/soft-deleted code both reduce to "the code isn't there".
const CODE_GONE = 'This code no longer exists.';
const GENERIC_FAILURE = 'Could not deactivate the code. Please try again.';

export type DeactivatePromoCodeResult = { success: true } | { success: false; error: string };

/**
 * Admin promo-code deactivation (BAL-384) — one-way (`status → 'deactivated'`; no
 * reactivation this ticket), idempotent (re-deactivating is a no-op). Same auth order as
 * the mint: `MANAGE_PROMO_CODES` gate BEFORE the input is parsed; generic denial (no
 * existence leak). No analytics event (the ticket scopes analytics to the mint only).
 */
export async function deactivatePromoCode(input: {
  id: string;
}): Promise<DeactivatePromoCodeResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { success: false, error: PERMISSION_DENIED };
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES)) {
    return { success: false, error: PERMISSION_DENIED };
  }
  // ⚠ BAL-560 fix round 1 (security F2) — THE SESSION GATE ABOVE IS NOT A REVOCATION BOUNDARY.
  // `checkSessionDrift` only runs during a page RENDER; this action POSTs straight to its own
  // endpoint, so a per-user override revoked days ago is still sealed in the cookie. Re-read the
  // LIVE row before mutating — the same reason, and the same shape, as the impersonation entry
  // point (`lib/auth/actions/impersonation.ts`). The cheap synchronous check above stays: it
  // fails closed on an unauthenticated caller before this query is spent.
  if (!(await actorHoldsPlatformCapability(user.id, PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES))) {
    return { success: false, error: PERMISSION_DENIED };
  }

  const parsed = deactivatePromoCodeSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: CODE_GONE };
  }
  const { id } = parsed.data;

  try {
    await promoCodesRepository.deactivate(id);

    log.info('Admin deactivated promo code', { promoCodeId: id, actorUserId: user.id });
    revalidatePath('/promo-codes');

    return { success: true };
  } catch (error) {
    if (error instanceof PromoCodeNotFoundError) {
      return { success: false, error: CODE_GONE };
    }
    log.error('Failed to deactivate promo code', {
      promoCodeId: id,
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
