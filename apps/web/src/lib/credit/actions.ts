'use server';

import { z } from 'zod';
import {
  db,
  creditWalletsRepository,
  creditLedgerRepository,
  creditSessionsRepository,
  promoRedemptionsRepository,
  deriveIdempotencyKey,
  type CreditWallet,
  type PromoValidationReason,
} from '@balo/db';
import { isCardBackedLowBalanceMode, type CardBackedModeWriteGuard } from '@balo/shared/credit';
import { requireOnboardedUser, getCompanyContext } from '@/lib/auth/session';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import {
  createPurchaseIntent,
  createMandateSetupIntent,
  confirmSavedCardMandate,
  detachSavedCardPaymentMethod,
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

/**
 * Config the composer persists regardless of payment outcome (a preference).
 *
 * BAL-524 — this does NOT enforce "a card-backed mode needs a card on file". `safeParse` runs
 * before `requireBillingActor()` / `ensureWallet()`, so the wallet — and therefore the card — is
 * not in scope at parse time. That rule lives after wallet resolution, in
 * `saveLowBalanceConfigAction` and `persistLowBalanceConfig` / `updateConfig` beneath it.
 */
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

/**
 * Did the webhook actually credit THIS purchase yet, and what does the actor's own wallet say?
 *
 *  · `unauthorized` — no MANAGE_BILLING (or no session). Terminal; the poll stops.
 *  · `error`        — a fault we could not read through (invalid input, DB blip). Carries NO
 *                     balance, deliberately: reporting a transport failure as `0` would be the
 *                     same class of lie the receipt's client arithmetic was.
 *  · `pending`      — the wallet is readable but the `manual_purchase:{piId}` ledger entry is
 *                     not (yet) against it. `balanceMinor` is a real read of the actor's wallet.
 *  · `credited`     — that entry exists AND belongs to the actor's own wallet.
 */
export type TopUpCreditStatusResult =
  | { status: 'unauthorized' }
  | { status: 'error' }
  | { status: 'pending'; balanceMinor: number }
  | {
      status: 'credited';
      balanceMinor: number;
      /**
       * Whether THIS purchase's promo grant is in the ledger — `null` when no promo was asked
       * about. The webhook's `grantPromoBestEffort` re-validates at settlement and can skip the
       * grant while the base credit lands, so the receipt must ASK rather than render
       * "Promo bonus +A$X" off the composer's apply-time state. Same class of lie this whole
       * surface exists to remove; smaller scope.
       */
      promoGranted: boolean | null;
    };

export type ValidatePromoResult =
  | { ok: true; grantMinor: number; promoCodeId: string }
  | { ok: false; reason: PromoValidationReason | 'unauthorized' | 'error' };

export type SaveConfigResult =
  | { ok: true }
  /**
   * `no_saved_card` — the selection is a CARD-BACKED mode (`auto_topup` / `keep_going`) and the
   * wallet holds no `stripe_payment_method_id`. Its own arm, never folded into `invalid_input`:
   * the client's next move is a specific control one section down the page, and "please try
   * again" is copy a retry cannot fix.
   */
  | { ok: false; error: 'unauthorized' | 'invalid_input' | 'no_saved_card' };

export type NudgeResult = { ok: true } | { ok: false; error: 'error' };

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

/** Whether the mode was written, or refused because the wallet holds no card. */
type PersistLowBalanceConfigOutcome = 'persisted' | 'refused_no_card_on_file';

/**
 * Persist the low-balance mode (+ auto-top-up reload/threshold). NO capability gating here — the
 * caller resolves MANAGE_BILLING. Reload/threshold are written only for `auto_topup`; the other
 * modes persist just the mode.
 *
 * THE CARD RULE, STATED PROPERLY (BAL-524). A card-backed mode (`auto_topup` / `keep_going`)
 * remains safe to persist while `mandate_status` is `pending` — the enforcement lanes
 * (BAL-378/379) gate on `mandate_status === 'active'` at charge time, so a pending mandate simply
 * does not fire. That was always true, and it is NOT the same claim as "safe to persist with no
 * card at all", which the previous wording collapsed into it. A card-backed mode on a wallet with
 * no `stripe_payment_method_id` is a stated intent nothing can ever honour, and it is the exact
 * state `clearSavedCardAndReconcileMode` exists to prevent from the other direction.
 *
 * WHAT ACTUALLY PROTECTS MONEY TODAY — read this guard as defence-in-depth, not as the whole
 * story. The lanes that gate a real off-session charge key off the MANDATE, not this mode guard:
 * `apps/api/src/services/credit/auto-topup.ts:259-266` skips with `no_mandate` unless
 * `isWalletMandateActive(wallet)` (plus both Stripe ids) holds, and
 * `apps/api/src/services/credit-session/drawdown.ts:61` passes
 * `mandatePresent: isWalletMandateActive(wallet)` into the same decision. Both are indifferent to
 * `low_balance_mode`. BAL-523 (Backlog) is what turns the (mode, card) pair written here into
 * something those lanes themselves consult — until it lands, a row this guard failed to prevent
 * (see the exemption's docblock below) is inert, not exploitable.
 *
 * So the requirement is the DEFAULT here and in `updateConfig` beneath it. A caller that passes
 * nothing is guarded. The single exemption is named at its call site.
 */
async function persistLowBalanceConfig(
  walletId: string,
  config: z.infer<typeof configSchema>,
  cardBackedModeGuard: CardBackedModeWriteGuard = 'require_card_on_file'
): Promise<PersistLowBalanceConfigOutcome> {
  const result = await creditWalletsRepository.updateConfig(
    walletId,
    config.lowBalanceMode === 'auto_topup'
      ? {
          lowBalanceMode: config.lowBalanceMode,
          topupReloadMinor: config.topupReloadMinor,
          topupThresholdMinor: config.topupThresholdMinor,
        }
      : { lowBalanceMode: config.lowBalanceMode },
    cardBackedModeGuard
  );
  return result.outcome === 'written' ? 'persisted' : 'refused_no_card_on_file';
}

/**
 * BAL-524 — one place that both refusal arms of `saveLowBalanceConfigAction` go through, so the
 * log message exists once and the two arms differ only in `refusedBy`. That field is the point:
 * `action_guard` is the ordinary case (a stale tab, or a hand-rolled POST); `atomic_write` means
 * the wallet genuinely lost its card BETWEEN the read and the write, which is the race the
 * conditional WHERE exists for and the only way to measure how often it bites.
 */
function refuseCardBackedModeWithoutCard(context: {
  walletId: string;
  companyId: string;
  lowBalanceMode: LowBalanceMode;
  refusedBy: 'action_guard' | 'atomic_write';
}): Extract<SaveConfigResult, { ok: false }> {
  log.warn('Card-backed low-balance mode refused — no card on file', context);
  return { ok: false, error: 'no_saved_card' };
}

/**
 * Resolve what happens to the card-backed mandate on this purchase. Returns a stated
 * {@link MandateOutcome} — never a bare nullable secret, whose three meanings the composer
 * could not tell apart.
 *
 * AN ACTIVE MANDATE SHORT-CIRCUITS ONLY THE `saved_card` ARM. There, the live mandate was
 * captured against the very card being charged, so it is genuinely `captured` and opening a
 * SetupIntent would be pure churn.
 *
 * `new_card` with an active mandate MUST still open a SetupIntent — this is the arm that
 * previously said `not_required`, and that was a silent auto-top-up kill switch: the purchase
 * webhook revokes the old card's mandate (`applySavedCardDisplay`, a card CHANGE), no consent
 * was ever captured for the new card, and the wallet lands at `mandate_status = NULL` with
 * auto-top-up and overdraft settlement dead. The buyer's only clue was the receipt's small
 * "couldn't finish setting up automatic charging" note.
 *
 * The old guard's stated reason — "opening a SetupIntent flips the status to 'pending',
 * transiently downgrading a working mandate" — no longer holds: `applyMandateStatus` now
 * REFUSES `active` → `pending`, so the pending write is inert while the old mandate is live.
 * Either webhook order then converges on `active` for the NEW card: if `setup_intent.succeeded`
 * lands first, the purchase webhook sees the stored payment method already equals the charged
 * one and preserves the mandate; if the purchase webhook lands first, it nulls the old mandate
 * and the SetupIntent's success then writes `active` for the new card.
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
  paymentMethodSource: PaymentMethodSource,
  clientRequestId: string
): Promise<MandateOutcome> {
  const cardBacked = isCardBackedLowBalanceMode(lowBalanceMode);
  if (!cardBacked) {
    return { outcome: 'not_required' };
  }
  if (wallet.mandateStatus === 'active' && paymentMethodSource === 'saved_card') {
    return { outcome: 'captured' };
  }
  try {
    if (paymentMethodSource === 'new_card') {
      const { clientSecret } = await createMandateSetupIntent(wallet.id);
      return { outcome: 'requires_action', clientSecret };
    }
    const result = await confirmSavedCardMandate(wallet.id, clientRequestId);
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
    // D3 EXEMPTION — the ONLY one. FIX ROUND (security MEDIUM-1 / review WARNING) — stated
    // honestly: this is an INTENT to establish the card, not a guarantee that it will exist.
    // The config write below commits UNCONDITIONALLY, before `createPurchaseIntent` even runs
    // and regardless of its outcome. If the buyer abandons the Payment Element, closes the tab
    // during 3DS, or the card declines, this write still landed — the wallet is left at a
    // card-backed mode with `stripe_payment_method_id IS NULL`, PERMANENTLY. Nothing sweeps it:
    // `clearSavedCardAndReconcileMode` only reconciles on card REMOVAL, which cannot fire when
    // there was never a card, and `TopUpComposer.tsx` re-seeds the next composer visit from that
    // same stated mode — an abandoned purchase is self-REINFORCING, not self-healing.
    //
    // This is INERT today, not a live money hole: every unattended charge gates on
    // `isWalletMandateActive` (`@balo/shared/credit`, `settlement.ts:46`), a conjunction of an
    // ACTIVE mandate AND a payment method — a card-backed mode with no card and no mandate fires
    // nothing. ⚠ It is not PERMANENTLY inert, though: a LATER "Add card" in Settings
    // (`startCardCaptureAction` → Stripe `setup_intent.succeeded` → `applyMandate`) arms an
    // active mandate on this same wallet directly, at which point the standing card-backed mode
    // set here goes LIVE — without anyone ever pressing Save on the low-balance control itself.
    //
    // So BAL-524 constrains one DIRECTION OF WRITE (a mode write must prove a card, unless
    // exempted), never the CONTENTS OF THE TABLE — this exemption is exactly why a card-backed
    // mode with no card can still exist after BAL-524, deliberately, on the purchase path.
    await persistLowBalanceConfig(
      wallet.id,
      input.config,
      'card_is_established_by_this_same_operation'
    );

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
      input.paymentMethodSource,
      input.clientRequestId
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
 * Bound the polled PaymentIntent id before it reaches the key derivation. Stripe ids are short
 * opaque `pi_…` strings; anything outside 1..255 chars is structurally invalid and never worth
 * a DB round-trip.
 */
const paymentIntentIdSchema = z.string().min(1).max(255);

/**
 * READ-ONLY: has the webhook credited this purchase to the ACTOR'S OWN wallet yet, and what is
 * that wallet's real balance? Polled by the receipt (`use-topup-credit-poll`).
 *
 * ⚠ THIS EXISTS BECAUSE THE RECEIPT USED TO ASSERT A BALANCE IT NEVER READ. It computed
 * `previous + amount + promo` client-side, so a purchase the webhook never credited rendered
 * "Your balance is now A$1,000.00" beside a top-bar chip reading A$0.00. Nothing on the client
 * ever asked the wallet. This is that question — and its answer is always a READ, never
 * arithmetic. The webhook stays the only writer (BAL-382); this writes nothing.
 *
 * ⚠⚠ `findByCompanyId`, NEVER `ensureForCompany`. A POLLED READ MUST NOT MINT A WALLET ROW.
 * `ensureForCompany` is a write, it runs up to ~13 times per receipt, and a company that never
 * bought anything would end up with a wallet conjured by a status check. Absence is a legitimate
 * answer here (`pending`, balance 0) precisely because the purchase path provisions the row.
 *
 * ⚠⚠ THE IDOR GUARD IS `entry.walletId === wallet.id`. The ledger key is
 * `manual_purchase:{paymentIntentId}` — derived entirely from a value the caller supplies, so it
 * is GUESSABLE. Answering "that key exists" for a key that resolves to somebody else's wallet
 * would confirm another company's purchase to whoever can reach this action. The answer is
 * scoped to the actor's own wallet, and a foreign entry is reported to nobody: it reads exactly
 * like the entry not existing.
 *
 * Auth is `requireBillingActor()` → `requireOnboardedUser()` (the fail-closed sibling), so this
 * needs no `READ_ONLY_ALLOWLIST` entry — that invariant only catches bare `requireUser()`.
 */
const promoCodeIdSchema = z.uuid();

/**
 * Whether the promo grant is in the ledger — the same question asked of the GRANT's own key,
 * `promo:{walletId}:{promoCodeId}`, inherently scoped to the actor's wallet because the wallet
 * id is half the key. `null` = no promo asked about; a malformed id is answered `false`, not an
 * error — the receipt then simply doesn't claim a bonus it cannot prove.
 */
async function resolvePromoGranted(
  walletId: string,
  promoCodeId: string | null | undefined
): Promise<boolean | null> {
  if (promoCodeId === null || promoCodeId === undefined) {
    return null;
  }
  const parsedPromoId = promoCodeIdSchema.safeParse(promoCodeId);
  if (!parsedPromoId.success) {
    return false;
  }
  const grant = await creditLedgerRepository.findByIdempotencyKey(
    deriveIdempotencyKey({ reason: 'promo', walletId, promoCodeId: parsedPromoId.data })
  );
  return grant !== undefined;
}

export async function getTopUpCreditStatusAction(
  paymentIntentId: string,
  promoCodeId?: string | null
): Promise<TopUpCreditStatusResult> {
  const parsed = paymentIntentIdSchema.safeParse(paymentIntentId);
  if (!parsed.success) {
    return { status: 'error' };
  }

  try {
    const actor = await requireBillingActor();
    if (actor === null) {
      return { status: 'unauthorized' };
    }

    const wallet = await creditWalletsRepository.findByCompanyId(actor.companyId);
    if (wallet === undefined) {
      // No row yet ⇒ nothing has been credited to this company, and its balance genuinely is 0.
      return { status: 'pending', balanceMinor: 0 };
    }

    const entry = await creditLedgerRepository.findByIdempotencyKey(
      deriveIdempotencyKey({ reason: 'manual_purchase', paymentIntentId: parsed.data })
    );
    const credited = entry !== undefined && entry.walletId === wallet.id;

    if (entry !== undefined && !credited) {
      // Someone asked about a PaymentIntent whose credit landed on a DIFFERENT wallet. Benign
      // in the normal flow (nothing hands the browser a foreign id), so warn rather than error —
      // but never silent: this is the one signal that the guessable key is being guessed at.
      log.warn('Top-up credit status asked about a PaymentIntent from another wallet', {
        companyId: actor.companyId,
        walletId: wallet.id,
      });
    }

    if (!credited) {
      return { status: 'pending', balanceMinor: wallet.balanceMinor };
    }

    // ⚠ ALWAYS THE WALLET'S OWN `balanceMinor`, NEVER A SUM. The promo grant commits in the SAME
    // webhook transaction as the base credit, so once the purchase key is visible this balance
    // already includes any bonus — and it is still right when the promo was SKIPPED at
    // settlement, which a sum would not be.
    //
    return {
      status: 'credited',
      balanceMinor: wallet.balanceMinor,
      promoGranted: await resolvePromoGranted(wallet.id, promoCodeId),
    };
  } catch (error) {
    log.error('Top-up credit status read failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { status: 'error' };
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
      // `promoCodeId` rides along so the RECEIPT can later ask whether the grant actually
      // landed — the grant's ledger key is `promo:{walletId}:{promoCodeId}`, keyed on the
      // promo's UUID, and the settlement webhook can legitimately SKIP the grant
      // (re-validation fails: expired or cap-exhausted between Apply and charge). Holding the
      // id authorises nothing; the status action still scopes every answer to the actor's
      // own wallet.
      return { ok: true, grantMinor: validation.grantMinor, promoCodeId: validation.promoCodeId };
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
 * Persist the low-balance mode + auto-top-up bounds standalone (the billing-settings picker's
 * Save). Gated MANAGE_BILLING.
 *
 * ⚠ BAL-524 — A CARD-BACKED MODE REQUIRES A CARD ON FILE, and this is where the client hears
 * about it. The refusal is enforced TWICE, deliberately, and the two are not redundant:
 *   · here, from the wallet already in hand, so the client gets a specific error naming the
 *     control that fixes it rather than a generic failure; and
 *   · inside `creditWalletsRepository.updateConfig`, as a conditional WHERE — the write is the
 *     real invariant, because this read and that write are not one transaction and a concurrent
 *     `clearSavedCardAndReconcileMode` (the Remove button, or Stripe's `payment_method.detached`)
 *     can land between them.
 * The card-presence test is necessarily spelled twice (once in TypeScript, once in SQL — SQL
 * cannot call a TS predicate). The MODE half has exactly one definition,
 * `isCardBackedLowBalanceMode` in `@balo/shared/credit`, which the card-removal reconcile reads too.
 *
 * The bar is CARD PRESENCE (`stripe_payment_method_id`), never `mandate_status === 'active'`:
 * `armSavedCardMandateAction` exists to move a pending mandate to active during THIS SAME Save,
 * so refusing the mode for a not-yet-active mandate would refuse the thing being armed. And never
 * `stripe_customer_id`, which deliberately SURVIVES a card clear (`clearSavedCard`).
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
    // row that only a money event would otherwise create. (A cardless company that lands on the
    // refusal below keeps the row `ensureForCompany` just minted: idempotent, and exactly the
    // row a `notify_only` save would have created anyway.)
    const wallet = await ensureWallet(actor.companyId);

    if (
      isCardBackedLowBalanceMode(parsed.data.lowBalanceMode) &&
      wallet.stripePaymentMethodId === null
    ) {
      return refuseCardBackedModeWithoutCard({
        walletId: wallet.id,
        companyId: actor.companyId,
        lowBalanceMode: parsed.data.lowBalanceMode,
        refusedBy: 'action_guard',
      });
    }

    if ((await persistLowBalanceConfig(wallet.id, parsed.data)) === 'refused_no_card_on_file') {
      // The write's own guard refused: the card went away between the read above and this
      // statement. 0 rows affected — surfaced, never reported as a successful save.
      return refuseCardBackedModeWithoutCard({
        walletId: wallet.id,
        companyId: actor.companyId,
        lowBalanceMode: parsed.data.lowBalanceMode,
        refusedBy: 'atomic_write',
      });
    }
    return { ok: true };
  } catch (error) {
    log.error('Low-balance config save failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, error: 'invalid_input' };
  }
}

// ── BAL-516: billing-settings-only actions (Save-time mandate arm, Add/Change, Remove) ──────

const armMandateSchema = z.object({ clientRequestId: z.uuid() });

/** Outcome of arming the mandate against the wallet's ALREADY-STORED card, from Save. */
export type ArmSavedCardMandateResult =
  | { ok: true; outcome: 'captured' }
  | { ok: true; outcome: 'requires_action'; clientSecret: string }
  | { ok: false; error: 'unauthorized' | 'invalid_input' | 'no_saved_card' | 'failed' };

/**
 * Settings-only Save-time step (design "Arming the mandate from Save" — the invariant's home):
 * when the picker's outgoing selection is card-backed and the stored card's mandate is not yet
 * `active`, Save also captures the mandate against the card ALREADY on file — never a new card
 * entry. `requireBillingActor` → `findByCompanyId` (**never `ensureWallet`** — arming needs an
 * existing card, which needs an existing wallet). `mandateStatus === 'active'` short-circuits
 * `captured` (same rule `resolveMandateOutcome`'s saved-card arm follows mid-purchase) so a
 * client who already armed the mandate never re-opens a SetupIntent. `clientRequestId` is minted
 * CLIENT-side (fresh per Save attempt, fresh per Retry) so a replayed/retried POST reuses the
 * same Stripe idempotency key inside `confirmSavedCardMandate` instead of minting duplicates.
 */
export async function armSavedCardMandateAction(
  rawInput: z.infer<typeof armMandateSchema>
): Promise<ArmSavedCardMandateResult> {
  const parsed = armMandateSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_input' };
  }

  let companyId: string | undefined;
  try {
    const actor = await requireBillingActor();
    if (actor === null) {
      return { ok: false, error: 'unauthorized' };
    }
    companyId = actor.companyId;

    const wallet = await creditWalletsRepository.findByCompanyId(actor.companyId);
    if (
      wallet === undefined ||
      wallet.stripeCustomerId === null ||
      wallet.stripePaymentMethodId === null
    ) {
      return { ok: false, error: 'no_saved_card' };
    }

    if (wallet.mandateStatus === 'active') {
      return { ok: true, outcome: 'captured' };
    }

    const result = await confirmSavedCardMandate(wallet.id, parsed.data.clientRequestId);
    if (result.status === 'succeeded') {
      return { ok: true, outcome: 'captured' };
    }
    if (result.status === 'requires_action' && result.clientSecret !== null) {
      return { ok: true, outcome: 'requires_action', clientSecret: result.clientSecret };
    }
    return { ok: false, error: 'failed' };
  } catch (error) {
    // FIX ROUND (security LOW) — `companyId` (never card facts, never a Stripe id) so the one
    // window that genuinely needs fast forensics is namable from THIS log line alone.
    log.error('Save-time mandate arm failed', {
      companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, error: 'failed' };
  }
}

/** Outcome of starting the settings Add/Change card capture panel. */
export type StartCardCaptureResult =
  | { ok: true; clientSecret: string; publishableKey: string }
  | { ok: false; error: 'unauthorized' | 'unconfigured' | 'settlement_outstanding' | 'error' };

/**
 * Start the settings Add/Change card capture panel: open a fresh off-session mandate
 * SetupIntent for a card the client is about to enter. Zero-arg — this never carries a
 * client-supplied wallet id. `ensureWallet` (not `findByCompanyId`) — a company that never held
 * credit can add a card FIRST (the design's empty-state flow); `ensureForCompany` is race-safe
 * and this is a deliberate user act, the same provisioning rule `saveLowBalanceConfigAction`
 * follows. Deliberately NO `mandateStatus === 'active'` short-circuit: unlike the Save-time arm
 * above, "Change" must open a fresh SetupIntent even over an already-active mandate.
 *
 * FIX ROUND 2 (security MEDIUM — NEW-1) — refuses a card **CHANGE** while the wallet has a live
 * overdraft-grace session, the same `hasActiveSessionForWallet` guard `detachSavedCard` already
 * runs (`apps/api`'s `mandate.ts`), reused rather than reinvented. Without this, F6's removal
 * guard was symmetric only in one direction: a client on `keep_going`/`auto_topup` who burns the
 * 30-minute overdraft grace could not REMOVE the card mid-session, but could still PRESS CHANGE
 * in a second tab and swap in a card that passes a $0 SetupIntent verification but declines on
 * the real off-session settlement charge — `settleOverdraft` re-reads the wallet at session end
 * and charges whatever card is on the row THEN, so the swap has the same economics as the closed
 * removal exploit.
 *
 * Two deliberate asymmetries with the removal guard, do not "fix" these:
 *  - A first **Add** (`stripePaymentMethodId === null`) is NEVER blocked — a client with no card
 *    on file is not evading anything, and blocking it would make the empty-state Add flow
 *    unusable the moment a session is live.
 *  - This is NOT gated on `hasOpenReceivable`, unlike removal. Adding or replacing a card is
 *    exactly how a client with an open receivable REMEDIATES it (there is no other in-product
 *    path — see `SETTLEMENT_OUTSTANDING_MESSAGE`'s docblock); blocking Change on an open
 *    receivable would strand such a client permanently.
 */
export async function startCardCaptureAction(): Promise<StartCardCaptureResult> {
  let companyId: string | undefined;
  try {
    const actor = await requireBillingActor();
    if (actor === null) {
      return { ok: false, error: 'unauthorized' };
    }
    companyId = actor.companyId;

    const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) {
      return { ok: false, error: 'unconfigured' };
    }

    const wallet = await ensureWallet(actor.companyId);

    if (wallet.stripePaymentMethodId !== null) {
      const activeSession = await creditSessionsRepository.hasActiveSessionForWallet(wallet.id);
      if (activeSession) {
        log.warn('Card change refused — settlement outstanding on the wallet', {
          walletId: wallet.id,
          companyId,
        });
        return { ok: false, error: 'settlement_outstanding' };
      }
    }

    const { clientSecret } = await createMandateSetupIntent(wallet.id);
    return { ok: true, clientSecret, publishableKey };
  } catch (error) {
    // FIX ROUND (security LOW) — see `armSavedCardMandateAction`'s catch for why `companyId` and
    // nothing card-shaped belongs here.
    log.error('Start card capture failed', {
      companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, error: 'error' };
  }
}

/** Outcome of removing the wallet's saved card (BAL-516). */
export type RemoveSavedCardResult =
  | { ok: true; lowBalanceMode: LowBalanceMode; modeReconciled: boolean }
  | { ok: false; error: 'unauthorized' | 'no_wallet' | 'settlement_outstanding' | 'error' };

/**
 * Remove the wallet's saved card: detach at Stripe, clear locally, and reconcile a card-backed
 * low-balance mode to `notify_only` — all inside ONE transaction on the `apps/api` side
 * (`detachSavedCard` → `clearSavedCardAndReconcileMode`). Zero-arg — takes NO client-supplied
 * ids; the wallet is resolved from the SESSION's company (`requireBillingActor` →
 * `findByCompanyId`), never from anything the browser sends. **Never `ensureWallet`** — removal
 * must not mint a wallet. Returns the EFFECTIVE `lowBalanceMode` the transaction committed, so
 * the settings UI repaints from server truth, not local optimism.
 *
 * FIX ROUND (security MEDIUM) — `detachSavedCard` now refuses (409 `settlement_outstanding`)
 * when the wallet has a live overdraft-grace session or an open receivable, so a client cannot
 * pull their card mid-consultation to dodge an already-incurred debt. That refusal surfaces here
 * as its own error arm — never folded into the generic `error` case — so the dialog can render
 * blocking copy instead of "please try again".
 */
export async function removeSavedCardAction(): Promise<RemoveSavedCardResult> {
  let walletId: string | undefined;
  let companyId: string | undefined;
  try {
    const actor = await requireBillingActor();
    if (actor === null) {
      return { ok: false, error: 'unauthorized' };
    }
    companyId = actor.companyId;

    const wallet = await creditWalletsRepository.findByCompanyId(actor.companyId);
    if (wallet === undefined) {
      return { ok: false, error: 'no_wallet' };
    }
    walletId = wallet.id;

    // FIX ROUND 3 (N2) — `actor.userId` is resolved server-side by `requireBillingActor()` above,
    // never client-supplied; threaded across the internal hop so `apps/api` can record who
    // detached the card in the same transaction as the clear.
    const result = await detachSavedCardPaymentMethod(wallet.id, actor.userId);
    log.info('Saved card removed', {
      walletId: wallet.id,
      companyId: actor.companyId,
      modeReconciled: result.modeReconciled,
    });
    return {
      ok: true,
      lowBalanceMode: result.lowBalanceMode,
      modeReconciled: result.modeReconciled,
    };
  } catch (error) {
    if (error instanceof CreditApiError && error.body?.error === 'settlement_outstanding') {
      log.warn('Saved card removal refused — settlement outstanding on the wallet', {
        walletId,
        companyId,
      });
      return { ok: false, error: 'settlement_outstanding' };
    }
    // FIX ROUND (security LOW) — `walletId` + `companyId`, no card facts, no `mandateRef`, no
    // Stripe ids. This is the one window that genuinely needs fast forensics (detached at
    // Stripe, local write failed) and the web-side log previously couldn't name the wallet.
    log.error('Saved card removal failed', {
      walletId,
      companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, error: 'error' };
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
