'use server';

import 'server-only';

import { z } from 'zod';
import { promoCodesRepository, normalizePromoCode, type RedeemPromoResult } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { trackServerAndFlush, PROMO_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { formatMinorAud } from '@/lib/promo-codes/promo-codes-view';
import { log } from '@/lib/logging';

/**
 * The serialisable result the redeem Server Action returns to the client panel. Every
 * refusal is a TYPED status the panel renders with warm, non-adversarial copy — no
 * refusal throws. `redeemed` carries pre-formatted labels (no minor units cross the
 * boundary); `balanceLabel` is null for an `already_redeemed` collapse (the repo returns
 * no post-balance on that path). `forbidden` is returned for a caller without
 * MANAGE_BILLING, indistinguishable from a copy standpoint so no existence is leaked.
 */
export type RedeemPromoActionResult =
  | {
      status: 'redeemed';
      grantedLabel: string;
      balanceLabel: string | null;
      alreadyRedeemed: boolean;
    }
  | { status: 'forbidden' }
  | { status: 'not_found' }
  | { status: 'scheduled' }
  | { status: 'expired' }
  | { status: 'deactivated' }
  | { status: 'exhausted' }
  | { status: 'error' };

const redeemInputSchema = z.object({
  code: z.string().trim().min(1).max(64),
});

export interface RedeemPromoActionInput {
  code: string;
}

/** 0–100 utilisation fill (redeemed / cap); a non-positive cap reads 0. */
function utilisationPct(redeemedCount: number, cap: number): number {
  if (cap <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((redeemedCount / cap) * 100));
}

/** Fold a repo redeem result into the serialisable action result the panel renders. */
function mapOutcome(result: RedeemPromoResult): RedeemPromoActionResult {
  switch (result.outcome) {
    case 'redeemed':
      return {
        status: 'redeemed',
        grantedLabel: formatMinorAud(result.grantedMinor),
        balanceLabel: formatMinorAud(result.balanceAfterMinor),
        alreadyRedeemed: false,
      };
    case 'already_redeemed':
      return {
        status: 'redeemed',
        grantedLabel: formatMinorAud(result.grantedMinor),
        balanceLabel: null,
        alreadyRedeemed: true,
      };
    case 'not_found':
      return { status: 'not_found' };
    case 'scheduled':
      return { status: 'scheduled' };
    case 'expired':
      return { status: 'expired' };
    case 'deactivated':
      return { status: 'deactivated' };
    case 'exhausted':
      return { status: 'exhausted' };
    default: {
      // Exhaustiveness guard — a new outcome must be mapped here.
      const _never: never = result;
      return _never;
    }
  }
}

/**
 * Redeem a promo code (BAL-383) — binds a fixed AUD credit grant to the redeeming
 * company's wallet (Model C: no purchase, no card). Gated on `MANAGE_BILLING` for the
 * session company (redeem is billing-adjacent and the continue path captures a card).
 * Requires an onboarded session (`requireOnboardedUser`, per the BAL-365 mutation gate);
 * the shipped entry points — the `/redeem` route and the dashboard "Have a promo code?"
 * link — are both post-onboarding. A redeem step inside the onboarding wizard is a
 * deferred follow-up.
 *
 * On a fresh `redeemed` outcome ONLY (never `already_redeemed`, to avoid double-count):
 * publishes `promo.redeemed` (correlationId = redemption id → BullMQ dedup) and emits the
 * two server analytics events. The repo owns idempotency, so a retried Server Action
 * collapses to `already_redeemed` and never re-notifies.
 */
export async function redeemPromoCode(
  input: RedeemPromoActionInput
): Promise<RedeemPromoActionResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { status: 'forbidden' };
  }

  const parsed = redeemInputSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 'not_found' };
  }

  const allowed = await hasCapability(user, CAPABILITIES.MANAGE_BILLING, {
    companyId: user.companyId,
  });
  if (!allowed) {
    return { status: 'forbidden' };
  }

  try {
    const result = await promoCodesRepository.redeem({
      rawCode: parsed.data.code,
      companyId: user.companyId,
      redeemedByUserId: user.id,
    });

    if (result.outcome === 'redeemed') {
      const code = normalizePromoCode(parsed.data.code);
      const grantedLabel = formatMinorAud(result.grantedMinor);

      publishNotificationEvent('promo.redeemed', {
        correlationId: result.redemption.id,
        userId: user.id,
        code,
        grantedLabel,
        companyName: user.companyName,
      }).catch((error) => {
        // Fire-and-forget: a broken queue/Brevo path must NOT fail the redeem — the credit
        // has already landed. But a silently-lost notification must leave a trace so the
        // path is diagnosable.
        log.error('promo.redeemed notification publish failed', {
          correlationId: result.redemption.id,
          companyId: user.companyId,
          actorUserId: user.id,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      });

      trackServerAndFlush(PROMO_SERVER_EVENTS.PROMO_REDEEMED, {
        promo_code_id: result.redemption.promoCodeId,
        granted_minor: result.grantedMinor,
        distinct_id: user.id,
      });
      trackServerAndFlush(PROMO_SERVER_EVENTS.PROMO_CODE_REDEEMED_VS_CAP, {
        promo_code_id: result.redemption.promoCodeId,
        redeemed_count: result.redeemedCount,
        per_code_redemption_cap: result.perCodeRedemptionCap,
        utilisation_pct: utilisationPct(result.redeemedCount, result.perCodeRedemptionCap),
        distinct_id: user.id,
      });

      log.info('Promo code redeemed', {
        promoCodeId: result.redemption.promoCodeId,
        companyId: user.companyId,
        actorUserId: user.id,
      });
    }

    return mapOutcome(result);
  } catch (error) {
    log.error('Promo redeem failed', {
      companyId: user.companyId,
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { status: 'error' };
  }
}
