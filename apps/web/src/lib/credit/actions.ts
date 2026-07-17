'use server';

import { z } from 'zod';
import {
  creditWalletsRepository,
  promoRedemptionsRepository,
  type PromoValidationReason,
} from '@balo/db';
import { requireUser, getCompanyContext } from '@/lib/auth/session';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { createPurchaseIntent, createMandateSetupIntent } from './api-client';
import {
  MIN_AMOUNT_MINOR,
  MAX_AMOUNT_MINOR,
  MIN_RELOAD_MINOR,
  MAX_RELOAD_MINOR,
  MAX_THRESHOLD_MINOR,
} from './display-constants';

/**
 * BAL-377 top-up Server Actions (ADR-1040 Lane 1). apps/web owns authz + wallet resolution +
 * config persistence; Stripe intent-creation is delegated to apps/api over the internal
 * secret hop. EVERY mutation gates on `hasCapability(MANAGE_BILLING)` — capability, never
 * role/activeMode (ADR-1029) — EXCEPT `nudgeBillingAdminAction` (the member path, gated only
 * on session membership). Analytics are CLIENT-fired via `track()` in the composer/receipt
 * (the webhook is the money source of truth), so these actions emit no `trackServer`.
 *
 * FEE NON-LEAK (BAL-357): a top-up buys AUD at FACE VALUE — the charge is in AUD
 * (`presentmentCurrency: 'aud'`, `presentmentAmountMinor` = the chosen AUD amount), so the
 * wallet is credited exactly what the user selected and the Balo fee (which lives in the
 * per-minute consume rate) never appears here. The "≈ US$…" figure is display-FX only.
 */

const lowBalanceModeSchema = z.enum(['auto_topup', 'keep_going', 'notify_only']);
export type LowBalanceMode = z.infer<typeof lowBalanceModeSchema>;

/** Config the composer persists regardless of payment outcome (a preference). */
const configSchema = z
  .object({
    lowBalanceMode: lowBalanceModeSchema,
    topupReloadMinor: z.number().int().min(MIN_RELOAD_MINOR).max(MAX_RELOAD_MINOR),
    topupThresholdMinor: z.number().int().nonnegative().max(MAX_THRESHOLD_MINOR),
  })
  // "Add" (reload) must be ≥ "When below" (threshold) — only meaningful for auto_topup, but
  // harmless to enforce whenever the two figures are supplied together.
  .refine((v) => v.lowBalanceMode !== 'auto_topup' || v.topupReloadMinor >= v.topupThresholdMinor, {
    message: 'Add amount must be at least the "when below" amount',
    path: ['topupReloadMinor'],
  });

const startPurchaseSchema = z.object({
  amountMinor: z.number().int().min(MIN_AMOUNT_MINOR).max(MAX_AMOUNT_MINOR),
  clientRequestId: z.uuid(),
  promoCode: z.string().min(1).max(64).optional(),
  config: configSchema,
});

export type StartPurchaseInput = z.infer<typeof startPurchaseSchema>;

export type StartPurchaseResult =
  | {
      ok: true;
      /** PaymentIntent client secret — confirmed client-side to charge the card. */
      clientSecret: string;
      paymentIntentId: string;
      /**
       * SetupIntent client secret — present ONLY for a card-backed mode (auto_topup /
       * keep_going). Confirmed with the just-saved payment method to capture the reusable
       * off-session mandate (webhook `setup_intent.succeeded` → `applyMandate`). `null`
       * for `notify_only` (no mandate needed).
       */
      setupClientSecret: string | null;
      walletId: string;
    }
  | { ok: false; error: 'unauthorized' | 'no_wallet' | 'invalid_input' | 'stripe_error' };

export type ValidatePromoResult =
  | { ok: true; grantMinor: number }
  | { ok: false; reason: PromoValidationReason | 'unauthorized' | 'error' };

export type SaveConfigResult =
  | { ok: true }
  | { ok: false; error: 'unauthorized' | 'invalid_input' };

export type NudgeResult = { ok: true } | { ok: false; error: 'error' };

/**
 * Persist the low-balance mode (+ auto-top-up reload/threshold). NO gating here — the caller
 * resolves MANAGE_BILLING. Reload/threshold are written only for `auto_topup`; the other
 * modes persist just the mode. Safe to persist a card-backed mode while `mandate_status` is
 * still `pending` — the enforcement lanes (BAL-378/379) gate on `mandate_status==='active'`
 * at charge time; here we record the user's stated intent.
 */
/**
 * Resolve the acting MANAGE_BILLING holder + their company scope, or `null` when the actor
 * lacks the capability. Shared by the three billing-gated actions (capability-based, ADR-1029
 * — never role/activeMode). Throws propagate to each action's own catch boundary.
 */
async function requireBillingActor(): Promise<{ userId: string; companyId: string } | null> {
  const user = await requireUser();
  const { companyId } = await getCompanyContext();
  if (!(await hasCapability(user, CAPABILITIES.MANAGE_BILLING, { companyId }))) {
    return null;
  }
  return { userId: user.id, companyId };
}

async function persistLowBalanceConfig(
  walletId: string,
  config: z.infer<typeof configSchema>
): Promise<void> {
  if (config.lowBalanceMode === 'auto_topup') {
    await creditWalletsRepository.updateConfig(walletId, {
      lowBalanceMode: config.lowBalanceMode,
      topupReloadMinor: config.topupReloadMinor,
      topupThresholdMinor: config.topupThresholdMinor,
    });
    return;
  }
  await creditWalletsRepository.updateConfig(walletId, { lowBalanceMode: config.lowBalanceMode });
}

/**
 * Start a card top-up: gate MANAGE_BILLING, resolve the wallet, persist low-balance config,
 * then create the on-session purchase PaymentIntent (deferred flow) and return its
 * `clientSecret` for the client to confirm with Stripe.js. The wallet is credited by the
 * shipped BAL-382 webhook — this NEVER writes the ledger. `clientRequestId` (stable per
 * configuration) keys Stripe idempotency, so a double-submit returns the same PI.
 */
export async function startPurchaseAction(
  rawInput: StartPurchaseInput
): Promise<StartPurchaseResult> {
  const parsed = startPurchaseSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_input' };
  }
  const input = parsed.data;

  try {
    const actor = await requireBillingActor();
    if (actor === null) {
      return { ok: false, error: 'unauthorized' };
    }

    const wallet = await creditWalletsRepository.findByCompanyId(actor.companyId);
    if (wallet === undefined) {
      return { ok: false, error: 'no_wallet' };
    }

    // Config is a preference — persist it regardless of payment outcome.
    await persistLowBalanceConfig(wallet.id, input.config);

    const { clientSecret, paymentIntentId } = await createPurchaseIntent({
      walletId: wallet.id,
      // The charge is in AUD at face value — the card network converts to the local currency
      // (the "≈ US$…" honest estimate); the wallet is credited exactly the chosen AUD amount.
      presentmentCurrency: 'aud',
      presentmentAmountMinor: input.amountMinor,
      initiatingMemberId: actor.userId,
      clientRequestId: input.clientRequestId,
      promoCode: input.promoCode,
    });

    // Card-backed modes capture the reusable off-session mandate inline (same Pay step): a
    // SetupIntent whose confirmation lands the wallet's mandate columns via the webhook. The
    // client confirms it with the payment method saved by the PaymentIntent confirmation.
    // GUARD: skip the SetupIntent when an ACTIVE mandate already exists — `createSetupIntent`
    // flips `mandate_status` to 'pending', so requesting one for a wallet that is already
    // 'active' would transiently downgrade a working mandate on a repeat card-backed purchase.
    const cardBacked =
      input.config.lowBalanceMode === 'auto_topup' || input.config.lowBalanceMode === 'keep_going';
    const needsMandate = cardBacked && wallet.mandateStatus !== 'active';
    const setupClientSecret = needsMandate
      ? (await createMandateSetupIntent(wallet.id)).clientSecret
      : null;

    return { ok: true, clientSecret, paymentIntentId, setupClientSecret, walletId: wallet.id };
  } catch (error) {
    log.error('Top-up purchase intent creation failed', {
      amountMinor: input.amountMinor,
      hasPromo: Boolean(input.promoCode),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, error: 'stripe_error' };
  }
}

/**
 * Validate an unadvertised promo code (Apply-time, READ-ONLY). Gated MANAGE_BILLING. Returns
 * the bonus grant on success, or the specific reason it cannot be applied so the UI can show
 * a per-reason line. The authoritative grant happens ONLY on successful payment (webhook) —
 * this never credits anything.
 */
export async function validatePromoAction(code: string): Promise<ValidatePromoResult> {
  try {
    const actor = await requireBillingActor();
    if (actor === null) {
      return { ok: false, reason: 'unauthorized' };
    }

    const validation = await promoRedemptionsRepository.validate({
      code,
      companyId: actor.companyId,
      now: new Date(),
    });
    if (validation.ok) {
      return { ok: true, grantMinor: validation.grantMinor };
    }
    return { ok: false, reason: validation.reason };
  } catch (error) {
    log.error('Promo validation failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, reason: 'error' };
  }
}

/**
 * Persist the low-balance mode + auto-top-up bounds standalone (also usable from the shared
 * billing-settings picker). Gated MANAGE_BILLING. Card-backed modes are safe to persist while
 * `mandate_status` is still pending — the enforcement lanes gate on 'active' at charge time.
 */
export async function saveLowBalanceConfigAction(
  rawInput: z.infer<typeof configSchema>
): Promise<SaveConfigResult> {
  const parsed = configSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_input' };
  }

  try {
    const actor = await requireBillingActor();
    if (actor === null) {
      return { ok: false, error: 'unauthorized' };
    }

    const wallet = await creditWalletsRepository.findByCompanyId(actor.companyId);
    if (wallet === undefined) {
      return { ok: false, error: 'invalid_input' };
    }

    await persistLowBalanceConfig(wallet.id, parsed.data);
    return { ok: true };
  } catch (error) {
    log.error('Low-balance config save failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, error: 'invalid_input' };
  }
}

/** Notification-dedup window for member nudges — one dispatch per (member, company) per hour. */
const NUDGE_WINDOW_MS = 60 * 60 * 1000;

/**
 * The MEMBER path (BAL-381): a company member WITHOUT MANAGE_BILLING nudges the billing
 * holder(s) to top up. NOT gated on MANAGE_BILLING — any company member may nudge; the
 * session's company scope is the membership proof. Publishes `credit.topup.requested`, which
 * fans out to the company's MANAGE_BILLING holders (the nudging member is naturally excluded).
 *
 * ABUSE GUARD: the `correlationId` is WINDOW-BUCKETED per (company, requester, hour) rather than
 * a fresh UUID per click. The notification engine's BullMQ jobId embeds the correlationId
 * (`{template}--{recipientId}--{correlationId}`), so repeated nudges inside the same hour
 * collapse to the same job and can't email-bomb the billing admins — while a genuine re-nudge in
 * a later window is still delivered. (Plain server clock; this is app code, not a stable-across-
 * retries idempotency key.)
 */
export async function nudgeBillingAdminAction(): Promise<NudgeResult> {
  try {
    const user = await requireUser();
    const { companyId } = await getCompanyContext();

    const hourBucket = Math.floor(Date.now() / NUDGE_WINDOW_MS);
    await publishNotificationEvent('credit.topup.requested', {
      correlationId: `topup-nudge:${companyId}:${user.id}:${hourBucket}`,
      companyId,
      requestedByUserId: user.id,
    });
    return { ok: true };
  } catch (error) {
    log.error('Top-up nudge failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, error: 'error' };
  }
}
