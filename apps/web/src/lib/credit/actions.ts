'use server';

import { z } from 'zod';
import {
  db,
  creditWalletsRepository,
  promoRedemptionsRepository,
  type CreditWallet,
  type PromoValidationReason,
} from '@balo/db';
import { requireOnboardedUser, getCompanyContext } from '@/lib/auth/session';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import {
  createPurchaseIntent,
  createMandateSetupIntent,
  confirmSavedCardMandate,
  CreditApiError,
  type PaymentMethodSource,
} from './api-client';
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

/**
 * Promo-code input bound — 1..64 chars. Applied at BOTH entry points (validate + purchase) so
 * an over-long or empty code is rejected structurally before it ever reaches the repo/DB lookup;
 * mirrors the API's `promoRedeemedPayload.code` bound.
 */
const promoCodeSchema = z.string().min(1).max(64);

const startPurchaseSchema = z.object({
  amountMinor: z.number().int().min(MIN_AMOUNT_MINOR).max(MAX_AMOUNT_MINOR),
  clientRequestId: z.uuid(),
  promoCode: promoCodeSchema.optional(),
  config: configSchema,
  /**
   * Which card to charge (top-up redesign). `new_card` keeps the shipped deferred flow;
   * `saved_card` charges the wallet's stored payment method, created AND confirmed on the api
   * side (the browser never learns the payment-method id).
   */
  paymentMethodSource: z.enum(['new_card', 'saved_card']).default('new_card'),
});

export type StartPurchaseInput = z.input<typeof startPurchaseSchema>;

/**
 * What happened to the card-backed mandate on this purchase — STATED, never inferred.
 *
 * ⚠ THE OUTCOME IS EXPLICIT BECAUSE A NULLABLE SECRET CANNOT CARRY IT. Three very different
 * results all produce "no client secret": the mandate confirmed server-side, the confirmation
 * FAILED, and a `requires_action` that came back without a secret. Collapsing them meant a
 * failed mandate was reported to the buyer as captured — the receipt suppressed its "we
 * couldn't finish setting up automatic charging" warning and `MANDATE_CAPTURED` fired, while
 * the wallet sat at `mandate_status: 'pending'` forever with nothing to ever tell them.
 *
 *  · `not_required`    — no mandate work was done for this purchase. Either the mode is not
 *                        card-backed, or an existing mandate belongs to a card the buyer is
 *                        replacing (the webhook revokes it), so nothing was captured here.
 *  · `captured`        — the mandate is confirmed for the card being charged; nothing left for
 *                        the browser (the webhook flips the wallet to `active`).
 *  · `requires_action` — the browser must finish it: `confirmSetup` on a fresh card, or
 *                        `handleNextAction` for 3DS on the stored card.
 *  · `failed`          — the confirmation did not complete. The PURCHASE still succeeds; only
 *                        the automatic-charging setup did not, and the receipt says so.
 */
export type MandateOutcome =
  | { outcome: 'not_required' }
  | { outcome: 'captured' }
  | { outcome: 'requires_action'; clientSecret: string }
  | { outcome: 'failed' };

export type StartPurchaseResult =
  | {
      ok: true;
      /** New card: the browser confirms this PaymentIntent secret against its Payment Element. */
      outcome: 'needs_client_confirmation';
      clientSecret: string;
      paymentIntentId: string;
      mandate: MandateOutcome;
      walletId: string;
    }
  | {
      ok: true;
      /** Stored card: already confirmed server-side. The webhook credits, as always. */
      outcome: 'complete';
      paymentIntentId: string;
      mandate: MandateOutcome;
      walletId: string;
    }
  | {
      ok: true;
      /** Stored card: the browser must run 3DS with `stripe.handleNextAction`. */
      outcome: 'requires_action';
      clientSecret: string;
      paymentIntentId: string;
      mandate: MandateOutcome;
      walletId: string;
    }
  | {
      ok: false;
      error:
        | 'unauthorized'
        | 'invalid_input'
        | 'stripe_error'
        | 'saved_card_error'
        | 'no_saved_card'
        | 'card_declined';
      /** Stripe's specific refusal reason, when it gave one (`card_declined` only). */
      declineCode?: string;
    };

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
 * — never role/activeMode). Fail-closed on onboarding (requireOnboardedUser, BAL-365): these
 * are privileged mutations, so an un-onboarded session must not pass. Throws propagate to each
 * action's own catch boundary.
 */
async function requireBillingActor(): Promise<{ userId: string; companyId: string } | null> {
  const user = await requireOnboardedUser();
  const { companyId } = await getCompanyContext();
  if (!(await hasCapability(user, CAPABILITIES.MANAGE_BILLING, { companyId }))) {
    return null;
  }
  return { userId: user.id, companyId };
}

/**
 * Resolve the company's wallet, CREATING it if this is the company's first credit event.
 * A company that has never held credit has no `credit_wallets` row, and every path to one is
 * a money event — so the purchase path has to be able to bootstrap it, or a client who never
 * redeemed a promo code can never buy credit at all (the shipped BAL-377 flow dead-ended on
 * `no_wallet` here). `ensureForCompany` is race-safe, so two concurrent first purchases
 * converge on one row rather than colliding on the one-wallet-per-company unique.
 *
 * Faults deliberately PROPAGATE to each action's catch boundary. Absence is no longer a
 * possible outcome, so anything thrown here is infrastructure (pool exhausted, statement
 * timeout, the corruption case `ensureForCompany` guards) — reporting that to the buyer as
 * "we couldn't find your balance" would be a lie about a system they cannot act on.
 */
async function ensureWallet(companyId: string): Promise<CreditWallet> {
  return creditWalletsRepository.ensureForCompany(db, companyId);
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
 * Resolve what happens to the card-backed mandate on this purchase. Returns a stated
 * {@link MandateOutcome} — never a bare nullable secret, whose three meanings the composer
 * could not tell apart.
 *
 * GUARD (unchanged): no SetupIntent is opened when an ACTIVE mandate already exists — opening
 * one flips `mandate_status` to 'pending', so requesting it for an already-'active' wallet would
 * transiently downgrade a working mandate on a repeat card-backed purchase. What that means for
 * THIS purchase depends on which card is being charged:
 *  · `saved_card` — the live mandate was captured against the very card we are charging, so it
 *                   is genuinely `captured`.
 *  · `new_card`   — a different card is going on file, and the webhook revokes the mandate
 *                   captured for the old one (`applySavedCardDisplay`). Nothing is captured
 *                   here, so say `not_required` and let the receipt's warning surface.
 *
 * Otherwise the two sources differ in WHICH card the mandate is captured against:
 *  · `new_card`   — return the secret; the browser confirms it with the PM the PaymentIntent
 *                   just saved.
 *  · `saved_card` — the api confirms server-side against the stored card. `succeeded` ⇒
 *                   `captured` (the webhook activates it, nothing for the browser to do);
 *                   `requires_action` WITH a secret ⇒ `requires_action`, for `handleNextAction`;
 *                   anything else — including a `requires_action` that came back without a
 *                   secret, which the browser cannot act on — ⇒ `failed`. The purchase still
 *                   completes; only the automatic-charging setup did not.
 *
 * ⚠ NEVER THROWS. A MANDATE HICCUP MUST NOT FAIL A COMPLETED PURCHASE — the same rule the
 * composer's `captureMandate` already follows on the client side. This runs AFTER
 * `createPurchaseIntent`, and on the saved-card path the money moved inside that call; letting
 * a transient failure of the second internal hop propagate to the action's catch boundary would
 * discard a successful purchase, report it as `saved_card_error`, and never render a receipt for
 * a wallet the webhook is about to credit. So the network arms degrade to `failed` and the
 * receipt's warning does the telling.
 */
async function resolveMandateOutcome(
  wallet: CreditWallet,
  lowBalanceMode: z.infer<typeof lowBalanceModeSchema>,
  paymentMethodSource: PaymentMethodSource
): Promise<MandateOutcome> {
  const cardBacked = lowBalanceMode === 'auto_topup' || lowBalanceMode === 'keep_going';
  if (!cardBacked) {
    return { outcome: 'not_required' };
  }
  if (wallet.mandateStatus === 'active') {
    return paymentMethodSource === 'saved_card'
      ? { outcome: 'captured' }
      : { outcome: 'not_required' };
  }
  try {
    if (paymentMethodSource === 'new_card') {
      const { clientSecret } = await createMandateSetupIntent(wallet.id);
      return { outcome: 'requires_action', clientSecret };
    }
    const result = await confirmSavedCardMandate(wallet.id);
    if (result.status === 'requires_action' && result.clientSecret !== null) {
      return { outcome: 'requires_action', clientSecret: result.clientSecret };
    }
    return result.status === 'succeeded' ? { outcome: 'captured' } : { outcome: 'failed' };
  } catch (error) {
    log.warn('Mandate capture failed — the top-up itself is unaffected', {
      walletId: wallet.id,
      lowBalanceMode,
      paymentMethodSource,
      error: error instanceof Error ? error.message : String(error),
    });
    return { outcome: 'failed' };
  }
}

/**
 * Recognise the two api failures the buyer can ACT on, and return `null` for everything else
 * (which the catch boundary then reports as a generic fault). A card DECLINE is a user outcome,
 * not a system fault: it gets its own arm — and its own copy — so the buyer learns their card
 * was refused instead of being told to "try again".
 */
function mapPurchaseFailure(
  error: unknown
): Extract<StartPurchaseResult, { ok: false }> | undefined {
  if (!(error instanceof CreditApiError)) return undefined;
  if (error.body?.outcome === 'declined') {
    const declineCode = error.body.code;
    return { ok: false, error: 'card_declined', ...(declineCode ? { declineCode } : {}) };
  }
  if (error.body?.error === 'no_saved_card') {
    return { ok: false, error: 'no_saved_card' };
  }
  return undefined;
}

/**
 * Start a card top-up: gate MANAGE_BILLING, resolve the wallet, persist low-balance config,
 * then charge. `new_card` creates the on-session PaymentIntent (deferred flow) and returns its
 * `clientSecret` for the client to confirm with Stripe.js; `saved_card` has the api create AND
 * confirm the PaymentIntent against the wallet's stored payment method, so the browser only runs
 * 3DS if asked. The wallet is credited by the shipped BAL-382 webhook — this NEVER writes the
 * ledger. `clientRequestId` (stable per configuration, and REGENERATED when the payment-method
 * source changes) keys Stripe idempotency, so a double-submit returns the same PI while a card
 * swap never reuses a key against different PI params.
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

    const wallet = await ensureWallet(actor.companyId);

    // Config is a preference — persist it regardless of payment outcome.
    await persistLowBalanceConfig(wallet.id, input.config);

    const purchase = await createPurchaseIntent({
      walletId: wallet.id,
      // The charge is in AUD at face value — the card network converts to the local currency
      // (the "≈ US$…" honest estimate); the wallet is credited exactly the chosen AUD amount.
      presentmentCurrency: 'aud',
      presentmentAmountMinor: input.amountMinor,
      initiatingMemberId: actor.userId,
      clientRequestId: input.clientRequestId,
      promoCode: input.promoCode,
      paymentMethodSource: input.paymentMethodSource,
    });

    // Never throws (see its docblock): on the saved-card path the money has already moved above,
    // so a mandate hiccup degrades to `{ outcome: 'failed' }` rather than discarding a completed
    // purchase at the catch boundary below.
    const mandate = await resolveMandateOutcome(
      wallet,
      input.config.lowBalanceMode,
      input.paymentMethodSource
    );

    if (purchase.outcome === 'complete') {
      return {
        ok: true,
        outcome: 'complete',
        paymentIntentId: purchase.paymentIntentId,
        mandate,
        walletId: wallet.id,
      };
    }
    return {
      ok: true,
      outcome: purchase.outcome,
      clientSecret: purchase.clientSecret,
      paymentIntentId: purchase.paymentIntentId,
      mandate,
      walletId: wallet.id,
    };
  } catch (error) {
    const mapped = mapPurchaseFailure(error);
    if (mapped?.error === 'card_declined') {
      // A decline is a USER outcome, not a system fault — warn, not error.
      log.warn('Top-up card declined', {
        amountMinor: input.amountMinor,
        paymentMethodSource: input.paymentMethodSource,
        declineCode: mapped.declineCode,
      });
      return mapped;
    }
    log.error('Top-up purchase intent creation failed', {
      amountMinor: input.amountMinor,
      hasPromo: Boolean(input.promoCode),
      paymentMethodSource: input.paymentMethodSource,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (mapped?.error === 'no_saved_card') {
      return mapped;
    }
    // ⚠ R14: the saved-card branch must NOT reuse the new-card "no charge was made" copy —
    // on that path the charge is attempted inside the call above.
    return {
      ok: false,
      error: input.paymentMethodSource === 'saved_card' ? 'saved_card_error' : 'stripe_error',
    };
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

    // Bound the raw string before the repo lookup (an over-long/empty code is structurally
    // invalid, not a DB miss) — same 1..64 bound the purchase schema applies.
    const parsedCode = promoCodeSchema.safeParse(code);
    if (!parsedCode.success) {
      return { ok: false, reason: 'invalid' };
    }

    const validation = await promoRedemptionsRepository.validate({
      code: parsedCode.data,
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

    // Same provisioning rule as the purchase path — saving a preference must not depend on a
    // row that only a money event would otherwise create.
    const wallet = await ensureWallet(actor.companyId);

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
 * holder(s) to top up. NOT gated on MANAGE_BILLING — any onboarded company member may nudge;
 * the session's company scope is the membership proof. Publishes `credit.topup.requested`,
 * which fans out to the company's MANAGE_BILLING holders.
 *
 * SELF-INCLUSION EDGE: the fan-out targets ALL MANAGE_BILLING holders, so it excludes the
 * caller only when the caller LACKS the capability — which is the sole case the UI surfaces
 * this action (the member-variant nudge renders only for non-billing members; a holder sees
 * the composer, not the nudge). Were a holder to invoke it directly they'd receive their own
 * nudge — harmless (a single self-notification, hour-bucketed below), never a leak or a loop —
 * so this is left as a UI-reliance rather than a redundant capability check.
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
    const user = await requireOnboardedUser();
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
