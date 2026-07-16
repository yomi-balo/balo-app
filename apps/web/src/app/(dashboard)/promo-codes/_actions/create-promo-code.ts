'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { promoCodesRepository, DuplicatePromoCodeError } from '@balo/db';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { trackServerAndFlush, PROMO_SERVER_EVENTS } from '@/lib/analytics/server';
import { log } from '@/lib/logging';
import { createPromoCodeSchema } from './promo-code-schema';

const PERMISSION_DENIED = 'You do not have permission to do this.';
const INVALID_INPUT = 'Check the code, amount, cap, and dates, then try again.';
const DUPLICATE_CODE = 'A code with that name already exists.';
const GENERIC_FAILURE = 'Could not create the promo code. Please try again.';

/**
 * The mint action's input. The dialog converts the admin's dollar entry to `grantMinor`
 * (integer minor units) and sends the window as ISO strings; the schema coerces the
 * strings to `Date`s and validates every bound against the DB CHECKs.
 */
export interface CreatePromoCodeActionInput {
  code: string;
  grantMinor: number;
  perCodeRedemptionCap: number;
  validFrom: string;
  validUntil: string;
}

export type CreatePromoCodeResult =
  | { success: true; promoCodeId: string; code: string }
  | { success: false; error: string; field?: 'code' };

/**
 * Admin promo-code mint (BAL-384). Authorization is the platform-capability axis
 * (`MANAGE_PROMO_CODES`), NOT `requireAdmin()`. Auth gates run BEFORE the input is
 * parsed, and an unauthenticated / uncapable caller gets a generic permission error (no
 * existence leak). The repo normalizes + inserts the code; a duplicate (including a
 * concurrent-creation race, caught by the partial unique index) maps to a friendly
 * field message. One server analytics event + a `log.info` fire on success only.
 */
export async function createPromoCode(
  input: CreatePromoCodeActionInput
): Promise<CreatePromoCodeResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { success: false, error: PERMISSION_DENIED };
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES)) {
    return { success: false, error: PERMISSION_DENIED };
  }

  const parsed = createPromoCodeSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_INPUT };
  }
  const { code, grantMinor, perCodeRedemptionCap, validFrom, validUntil } = parsed.data;

  try {
    const created = await promoCodesRepository.create({
      code,
      grantMinor,
      perCodeRedemptionCap,
      validFrom,
      validUntil,
      createdBy: user.id,
    });

    log.info('Admin minted promo code', {
      promoCodeId: created.id,
      actorUserId: user.id,
      grantMinor: created.grantMinor,
      cap: created.perCodeRedemptionCap,
    });
    trackServerAndFlush(PROMO_SERVER_EVENTS.PROMO_CODE_CREATED, {
      promo_code_id: created.id,
      grant_minor: created.grantMinor,
      per_code_redemption_cap: created.perCodeRedemptionCap,
      valid_from: created.validFrom.toISOString(),
      valid_until: created.validUntil.toISOString(),
      distinct_id: user.id,
    });

    revalidatePath('/promo-codes');

    return { success: true, promoCodeId: created.id, code: created.code };
  } catch (error) {
    if (error instanceof DuplicatePromoCodeError) {
      return { success: false, error: DUPLICATE_CODE, field: 'code' };
    }
    log.error('Failed to create promo code', {
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
