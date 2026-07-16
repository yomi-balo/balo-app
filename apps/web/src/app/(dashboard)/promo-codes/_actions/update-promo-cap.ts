'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { promoCodesRepository, CapBelowRedeemedCountError, PromoCodeNotFoundError } from '@balo/db';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { updatePromoCapSchema } from './promo-code-schema';

const PERMISSION_DENIED = 'You do not have permission to do this.';
const INVALID_INPUT = 'Enter a valid cap, then try again.';
const CODE_GONE = 'This code no longer exists.';
const GENERIC_FAILURE = 'Could not update the cap. Please try again.';

export type UpdatePromoCapResult =
  | { success: true; newCap: number }
  | { success: false; error: string };

/**
 * Admin promo-code cap edit (BAL-384). Same auth order as the mint. The repo row-locks
 * the code and rejects a cap below the current `redeemed_count` with a friendly message
 * (the DB CHECK is the hard backstop). No analytics event (ticket scopes analytics to
 * the mint only).
 */
export async function updatePromoCap(input: {
  id: string;
  newCap: number;
}): Promise<UpdatePromoCapResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { success: false, error: PERMISSION_DENIED };
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES)) {
    return { success: false, error: PERMISSION_DENIED };
  }

  const parsed = updatePromoCapSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_INPUT };
  }
  const { id, newCap } = parsed.data;

  try {
    const updated = await promoCodesRepository.updateCap({ id, newCap });

    log.info('Admin updated promo cap', {
      promoCodeId: id,
      actorUserId: user.id,
      newCap: updated.perCodeRedemptionCap,
    });
    revalidatePath('/promo-codes');

    return { success: true, newCap: updated.perCodeRedemptionCap };
  } catch (error) {
    if (error instanceof CapBelowRedeemedCountError) {
      return {
        success: false,
        error: `Cap can't be lower than the ${error.redeemedCount} redemptions already made.`,
      };
    }
    if (error instanceof PromoCodeNotFoundError) {
      return { success: false, error: CODE_GONE };
    }
    log.error('Failed to update promo cap', {
      promoCodeId: id,
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
