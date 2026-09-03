import {
  companiesRepository,
  creditReceivablesRepository,
  creditSessionsRepository,
  creditWalletsRepository,
  db,
  type CreditWallet,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type Stripe from 'stripe';
import { getStripeClient } from '../../lib/stripe.js';
import { resolveAppUrl } from '../../lib/app-url.js';
import type { CardDisplayFields } from './types.js';

const log = createLogger('stripe');

/**
 * Ensure a Stripe Customer for the wallet and return its id (skill Mandate step 1).
 *
 * If the wallet already has `stripeCustomerId`, that is returned unchanged. Otherwise a
 * Customer is created with a STABLE Stripe idempotency key (`stripe-customer-{walletId}`),
 * so a retry of the same wallet never creates a duplicate Customer. The id is persisted
 * onto the wallet at `setup_intent.succeeded` (via `applyMandate`) alongside the payment
 * method + mandate ref — the shipped DB layer's single mandate-write seam — and it also
 * round-trips through `SetupIntent.customer`, so no eager customer-only write is needed.
 *
 * BAL-515 — the customer carries the WORKSPACE name. The wallet is company-scoped, so the Stripe
 * customer is a party, not a purchase; every row previously read "Unnamed customer", which hurts
 * dispute evidence, Radar signal, support lookup and finance reconciliation.
 *
 * ⚠ FOR A PERSONAL WORKSPACE THAT STRING IS A PERSON'S NAME. `companies.isPersonal` defaults
 * true and `usersRepository` names such a workspace `{firstName}'s Workspace`, so the common
 * solo-buyer case does send a given name to Stripe. That is ACCEPTED, on these grounds and no
 * others: it is the company's OWN record name — the workspace label Balo already shows that
 * account everywhere, not a fact inferred about a person; it goes to the processor that is
 * already handling that company's card payments, for dispute evidence, Radar signal, support
 * lookup and finance reconciliation; and the alternative, omitting it, restores the "Unnamed
 * customer" problem for exactly the buyers this change exists to identify.
 *
 * ⚠ AND BE PRECISE ABOUT THE COST, BECAUSE AN EARLIER DRAFT OF THIS COMMENT WAS NOT. It waved the
 * concern away with "Stripe already holds the cardholder's real name on every PaymentMethod's
 * `billing_details`" — i.e. this sends nothing Stripe does not have. THAT IS NOT ESTABLISHED BY
 * THIS CODEBASE and must not be relied on. Balo never sets `billing_details`: `<PaymentElement />`
 * is rendered with no `options` at all in `redeem/_components/continue-to-mandate.tsx`, and with
 * only `onReady`/`onLoadError` in `billing/top-up/PaymentMethodSection.tsx`, so no
 * `fields.billingDetails` and no `defaultValues` are configured anywhere; `paymentMethods.create`
 * is never called server-side either. Whether a cardholder name ever reaches Stripe on a
 * PaymentMethod is up to Stripe's own Element and the issuer, not up to us, and this file has no
 * business asserting vendor behaviour it has not verified. So state it plainly instead: FOR A
 * PERSONAL WORKSPACE THIS MAY BE THE FIRST PERSON-IDENTIFYING STRING BALO SENDS TO STRIPE FOR
 * THAT WALLET. The decision above stands on its own grounds and does not need the vendor claim.
 * Do NOT "improve" this by sending the member's first + last name: see the attribution note below
 * for why that is strictly worse.
 *
 * `email` is deliberately OUT OF SCOPE, and the reason is structural rather than squeamish:
 * `Customer.email` is a SINGLE-VALUED field on a MULTI-MEMBER entity, so the first buyer would
 * own the company's billing address forever — including any mail Stripe sends itself — and keep
 * owning it after leaving. The right primitive is a company-level billing email that survives
 * departures (a `companies` column + `customers.update`), which is a schema change this ticket
 * cannot take and which belongs with BAL-516's billing settings. Balo sends its own receipts via
 * the notification engine, so nothing on the buyer's receipt path depends on this field.
 *
 * ⚠ ATTRIBUTION: this names the PARTY, never the purchaser. One Stripe customer exists per
 * wallet (`stripe-customer-{walletId}`) and the wallet is company-scoped, so a person's name here
 * would not label "the buyer" — it would permanently label the COMPANY's billing record with
 * whoever happened to buy first. Whatever per-charge human identity Stripe DOES capture belongs
 * on the PaymentMethod's `billing_details`, where it would be accurate per charge instead of
 * frozen at the first one — that is where such a value goes, not a claim about what is currently
 * there (Balo sets no `billing_details`; see above).
 *
 * ⚠ THE NAME IS SET ONCE, AT FIRST CREATION, AND NEVER REFRESHED. The idempotency key is stable
 * and name-independent (which is what makes a duplicate customer impossible), so a retried create
 * inside Stripe's key window replays the ORIGINAL customer and will not apply a changed name.
 * Customers created before this change keep "Unnamed customer" until someone backfills them
 * out-of-band. A company rename is likewise not propagated.
 */
export async function ensureCustomer(wallet: CreditWallet): Promise<string> {
  if (wallet.stripeCustomerId) {
    return wallet.stripeCustomerId;
  }

  const stripe = getStripeClient();
  // FAIL-SOFT. A name is dispute-evidence / support-lookup quality, not correctness: if the
  // company read fails or returns nothing, create the customer WITHOUT one rather than blocking a
  // money path on a display read (the same posture as `retrieveCardDisplay` below). Read the
  // DISPLAY-only projection — never `findById`, which returns billing details, domain and join
  // mode that have no business crossing to Stripe.
  let companyName: string | undefined;
  try {
    companyName = (await companiesRepository.findNameById(wallet.companyId))?.name;
  } catch (err: unknown) {
    log.warn(
      {
        op: 'ensureCustomer',
        walletId: wallet.id,
        error: err instanceof Error ? err.message : String(err),
      },
      'Could not read the company name — creating the Stripe customer without one'
    );
  }
  try {
    const customer = await stripe.customers.create(
      {
        ...(companyName === undefined ? {} : { name: companyName }),
        metadata: { walletId: wallet.id },
      },
      { idempotencyKey: `stripe-customer-${wallet.id}` }
    );
    log.info(
      { op: 'ensureCustomer', walletId: wallet.id, stripeId: customer.id },
      'Created Stripe customer for wallet'
    );
    return customer.id;
  } catch (err: unknown) {
    log.error(
      {
        op: 'ensureCustomer',
        walletId: wallet.id,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to create Stripe customer'
    );
    throw err;
  }
}

/**
 * Attach a PaymentMethod to a Customer (thin helper for out-of-band PM collection). The
 * primary path — a SetupIntent confirmed on the frontend with `usage: 'off_session'` —
 * auto-attaches, so this is optional glue the consumer lane can use if it collects a PM
 * separately.
 */
export async function attachPaymentMethod(
  customerId: string,
  paymentMethodId: string
): Promise<void> {
  const stripe = getStripeClient();
  try {
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    log.info(
      { op: 'attachPaymentMethod', stripeId: paymentMethodId, customerId },
      'Attached payment method to customer'
    );
  } catch (err: unknown) {
    log.error(
      {
        op: 'attachPaymentMethod',
        customerId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to attach payment method'
    );
    throw err;
  }
}

/**
 * Create an `off_session` SetupIntent for a REUSABLE mandate (skill Mandate step 2).
 *
 * Ensures the Customer first, marks the wallet's `mandate_status = 'pending'`, and returns
 * the `client_secret` for the frontend to confirm the card. On `setup_intent.succeeded`
 * the webhook persists the customer + payment method + mandate ref and flips the status to
 * `'active'`. Never sets `payment_method_types` (dynamic payment methods — best practice).
 */
export async function createSetupIntent(
  walletId: string
): Promise<{ clientSecret: string; setupIntentId: string; customerId: string }> {
  const wallet = await creditWalletsRepository.findById(walletId);
  if (wallet === undefined) {
    throw new Error(`Credit wallet not found: ${walletId}`);
  }

  const customerId = await ensureCustomer(wallet);
  const stripe = getStripeClient();

  try {
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
      metadata: { walletId },
    });

    const clientSecret = setupIntent.client_secret;
    if (clientSecret === null) {
      throw new Error(`SetupIntent ${setupIntent.id} was created without a client_secret`);
    }

    // Mark pending BEFORE returning so the wallet reflects an in-flight mandate attempt.
    await creditWalletsRepository.applyMandateStatus(db, walletId, 'pending');

    log.info(
      { op: 'createSetupIntent', walletId, stripeId: setupIntent.id, customerId },
      'Created off-session SetupIntent (mandate pending)'
    );

    return { clientSecret, setupIntentId: setupIntent.id, customerId };
  } catch (err: unknown) {
    log.error(
      {
        op: 'createSetupIntent',
        walletId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to create SetupIntent'
    );
    throw err;
  }
}

/**
 * Read the DISPLAY facts of a saved PaymentMethod (top-up redesign). Returns `null` for a
 * non-card payment method, for a card with no `card` object, or for ANY Stripe failure —
 * never throws.
 *
 * ⚠ FAIL-SOFT IS LOAD-BEARING. Both callers run inside `resolveStripeEffect`, i.e. on the path
 * to a money effect. A throw here becomes a webhook 500, which makes Stripe retry a wallet
 * credit we have already taken the card payment for. A missing "Visa •••• 4242" on the next
 * visit is a cosmetic regression; a failed credit is a money bug. Log warn and move on.
 *
 * LOGGING: the warn path logs the payment-method id only (already treated as loggable at this
 * layer — `attachPaymentMethod` above does it). NEVER `last4`, expiry, or a mandate ref.
 */
export async function retrieveCardDisplay(
  paymentMethodId: string
): Promise<CardDisplayFields | null> {
  try {
    const stripe = getStripeClient();
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (pm.type !== 'card' || !pm.card) {
      return null;
    }
    return {
      cardBrand: pm.card.brand,
      cardLast4: pm.card.last4,
      cardExpMonth: pm.card.exp_month,
      cardExpYear: pm.card.exp_year,
    };
  } catch (err: unknown) {
    log.warn(
      {
        op: 'retrieveCardDisplay',
        stripeId: paymentMethodId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Could not read card display facts — continuing without them (display-only)'
    );
    return null;
  }
}

/** The outcome of confirming a mandate against the wallet's already-stored card. */
export interface SavedCardMandateResult {
  status: 'succeeded' | 'requires_action' | 'failed';
  /** Present ONLY for `requires_action` — the browser runs 3DS via `stripe.handleNextAction`. */
  clientSecret: string | null;
}

/**
 * Create AND confirm a SetupIntent (`usage: 'off_session'`) against the wallet's ALREADY-STORED
 * payment method (top-up redesign), so a returning buyer paying with a saved card can activate
 * a mandate without re-entering the card. Marks the wallet `pending` exactly as
 * `createSetupIntent` does; `setup_intent.succeeded` flips it to `active`.
 *
 * `succeeded` ⇒ nothing more for the client to do. `requires_action` ⇒ the client secret comes
 * back so the browser can run 3DS via `stripe.handleNextAction`. Anything else ⇒ `failed`.
 *
 * ⚠ `off_session` is deliberately NOT passed to `confirm`. The buyer IS present (they just
 * pressed Pay), so an authentication challenge must be allowed to surface as `requires_action`
 * and be answered — claiming they are absent would turn a completable 3DS into a hard failure.
 * `usage: 'off_session'` (what the mandate is FOR) and `off_session` (whether the buyer is here)
 * are different questions.
 *
 * This is the narrow case of "card on file from a `notify_only` purchase, buyer now picks a
 * card-backed mode". Throws when the wallet is missing or has no stored card — the caller gates
 * on `isWalletCardReusableOnSession` first.
 */
export async function confirmSavedCardMandate(
  walletId: string,
  clientRequestId: string
): Promise<SavedCardMandateResult> {
  const wallet = await creditWalletsRepository.findById(walletId);
  if (wallet === undefined) {
    throw new Error(`Credit wallet not found: ${walletId}`);
  }
  const { stripeCustomerId, stripePaymentMethodId } = wallet;
  if (stripeCustomerId === null || stripePaymentMethodId === null) {
    throw new Error(`Credit wallet ${walletId} has no stored card to confirm a mandate against`);
  }

  const stripe = getStripeClient();
  try {
    const setupIntent = await stripe.setupIntents.create(
      {
        customer: stripeCustomerId,
        payment_method: stripePaymentMethodId,
        usage: 'off_session',
        confirm: true,
        use_stripe_sdk: true,
        return_url: resolveAppUrl('/billing/top-up'),
        metadata: { walletId },
      },
      // Previously unkeyed, so a retried Server Action minted duplicate SetupIntents. Keyed on
      // the purchase's clientRequestId so it inherits the composer's rotation (fresh per
      // configuration AND per decline): a retry of the SAME attempt returns the same
      // SetupIntent; a genuinely new attempt gets a new one. (`attachPaymentMethod` and
      // `createSetupIntent` above remain unkeyed POSTs — pre-existing, out of this change.)
      { idempotencyKey: `mandate-confirm:${walletId}:${clientRequestId}` }
    );

    // Mark the attempt in flight. NOT the same posture as `createSetupIntent`, despite the
    // shape: that one does NOT confirm, so its intent cannot succeed until the user acts, and
    // the gap makes writing `pending` unconditionally safe. `confirm: true` above removes
    // exactly that gap — the intent can reach `succeeded` DURING the create, so Stripe may have
    // queued `setup_intent.succeeded` (→ `applyMandate` → `active`) before this line runs.
    //
    // `applyMandateStatus` refuses `active` → `pending` for that reason, so a webhook that wins
    // the race is not stomped back and the wallet cannot be stranded un-chargeable. Relying on
    // that guard rather than re-ordering here keeps the invariant at the data layer, where
    // every caller gets it — see the comment on `applyMandateStatus`.
    await creditWalletsRepository.applyMandateStatus(db, walletId, 'pending');

    if (setupIntent.status === 'succeeded') {
      log.info(
        { op: 'confirmSavedCardMandate', walletId, stripeId: setupIntent.id },
        'Confirmed mandate against the stored card (mandate pending → webhook activates)'
      );
      return { status: 'succeeded', clientSecret: null };
    }
    if (setupIntent.status === 'requires_action') {
      return { status: 'requires_action', clientSecret: setupIntent.client_secret };
    }
    log.warn(
      { op: 'confirmSavedCardMandate', walletId, stripeId: setupIntent.id },
      'Saved-card mandate confirmation did not complete'
    );
    return { status: 'failed', clientSecret: null };
  } catch (err: unknown) {
    log.error(
      {
        op: 'confirmSavedCardMandate',
        walletId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to confirm mandate against the stored card'
    );
    return { status: 'failed', clientSecret: null };
  }
}

/** The outcome of a user-initiated card removal (BAL-516). */
export type DetachSavedCardResult =
  | { status: 'removed'; lowBalanceMode: CreditWallet['lowBalanceMode']; modeReconciled: boolean }
  | { status: 'no_wallet' }
  /**
   * FIX ROUND (security MEDIUM) — the wallet has a live overdraft-grace session or an open
   * receivable. Refused BEFORE any Stripe call so the card stays attached and chargeable.
   */
  | { status: 'settlement_outstanding' }
  | { status: 'stripe_error' };

/** True for a Stripe `resource_missing` failure — the payment method genuinely no longer exists
 * at Stripe (key rotation across environments, restored non-prod data, a manual dashboard
 * delete), as opposed to a transient network/API fault. Duck-typed rather than
 * `instanceof Stripe.errors.StripeInvalidRequestError` because the real Stripe SDK's error
 * classes are NOT mocked in `detachSavedCard`'s own unit tests (only `StripeError` /
 * `StripeCardError` are) — an `instanceof` against an undefined class throws, it doesn't just
 * fail to match. */
function isResourceMissing(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'resource_missing'
  );
}

/**
 * Already-detached PROBE — Stripe has no stable error code for a double-detach, so a failed
 * `detach` asks the payment method itself whether it still names a customer. `pm.customer ===
 * null` means a prior attempt already succeeded (or a Stripe-dashboard detach raced us), so the
 * local write can still proceed; any other outcome is a genuine, retryable Stripe failure —
 * EXCEPT a `resource_missing` on the retrieve itself, which means the payment method no longer
 * exists at Stripe at all. That is, semantically, also "detached": there is no PM left to hold
 * consent, so refusing to clear it locally would make the card permanently un-removable through
 * this UI (BAL-516 fix round — the exact bad state "Remove card" exists to escape).
 */
async function probeAlreadyDetached(
  stripe: Stripe,
  walletId: string,
  stripePaymentMethodId: string,
  detachErr: unknown
): Promise<boolean> {
  try {
    const pm = await stripe.paymentMethods.retrieve(stripePaymentMethodId);
    if (pm.customer === null) {
      return true;
    }
    log.error(
      {
        op: 'detachSavedCard',
        walletId,
        stripeId: stripePaymentMethodId,
        error: detachErr instanceof Error ? detachErr.message : String(detachErr),
      },
      'Failed to detach payment method at Stripe — still attached'
    );
    return false;
  } catch (probeErr: unknown) {
    if (isResourceMissing(probeErr)) {
      log.warn(
        { op: 'detachSavedCard', walletId, stripeId: stripePaymentMethodId },
        'Payment method no longer exists at Stripe — treating as already detached'
      );
      return true;
    }
    log.error(
      {
        op: 'detachSavedCard',
        walletId,
        stripeId: stripePaymentMethodId,
        error: probeErr instanceof Error ? probeErr.message : String(probeErr),
      },
      'Failed to probe payment method after a failed detach'
    );
    return false;
  }
}

/** Detach the payment method at Stripe, or confirm (via the probe) that it is already gone. */
async function detachAtStripe(walletId: string, stripePaymentMethodId: string): Promise<boolean> {
  const stripe = getStripeClient();
  try {
    await stripe.paymentMethods.detach(stripePaymentMethodId);
    return true;
  } catch (detachErr: unknown) {
    return probeAlreadyDetached(stripe, walletId, stripePaymentMethodId, detachErr);
  }
}

/** The local clear + mode-reconcile, inside ONE transaction. Rethrows after the loudest log. */
async function clearLocallyAndReconcile(
  walletId: string,
  stripePaymentMethodId: string | null,
  actorUserId: string
): Promise<DetachSavedCardResult> {
  try {
    const result = await db.transaction((tx) =>
      creditWalletsRepository.clearSavedCardAndReconcileMode(tx, walletId, actorUserId)
    );
    log.info(
      { op: 'detachSavedCard', walletId, modeReconciled: result.modeReconciled },
      'Removed saved card and reconciled low-balance mode'
    );
    return {
      status: 'removed',
      lowBalanceMode: result.wallet.lowBalanceMode,
      modeReconciled: result.modeReconciled,
    };
  } catch (err: unknown) {
    log.error(
      {
        op: 'detachSavedCard',
        walletId,
        stripeId: stripePaymentMethodId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Card detached at Stripe but the local clear failed — retry converges'
    );
    throw err;
  }
}

/**
 * BAL-516 — USER-INITIATED card removal: detach at Stripe FIRST (outside any DB transaction —
 * network I/O never runs inside one), THEN clear locally + reconcile a card-backed low-balance
 * mode in ONE `db.transaction` (`clearSavedCardAndReconcileMode`). See the removal-transaction
 * decision in the BAL-516 plan for the full ordering rationale; summary below.
 *
 * ⚠ ORDER IS LOAD-BEARING. Clearing locally first and then failing the detach would null
 * `stripePaymentMethodId` while Stripe still holds an attached, mandate-bearing payment method —
 * Balo would lose the id needed to ever detach it (orphaned consent, unrecoverable). Detach-first
 * means the failure window (detach succeeded, local write failed) is recoverable: a retry's detach
 * errors "not attached", the already-detached PROBE below (`paymentMethods.retrieve` →
 * `pm.customer === null`) recognises that and proceeds to the local write anyway. Stripe gives no
 * stable error code for a double-detach, hence the probe rather than message-matching.
 *
 * ⚠ IDEMPOTENT BY CONSTRUCTION. No Stripe idempotency key is passed to `detach` — idempotence
 * here is semantic ("the PM ends detached"), enforced by the probe. A repeat call with no stored
 * PM (`stripePaymentMethodId === null`) skips Stripe entirely and still runs the transaction, so
 * the response always upholds "no card ⇒ no card-backed mode armed".
 *
 * A throw from the transaction AFTER a successful detach is deliberately NOT caught here — it
 * propagates so the route 500s. That is the recoverable failure window described above; the
 * loudest possible log is written first so it is never silent.
 *
 * ⚠ FIX ROUND (security MEDIUM) — refuses BEFORE any Stripe call when the wallet has a live
 * overdraft-grace session or the company has an open receivable. Without this, a client on
 * `keep_going`/`auto_topup` could let a consultation run into overdraft grace and pull the card
 * in a second tab: `settleOverdraft` then finds `mandateActive === false` and takes the
 * `openReceivableAndDun` branch instead of charging, and the dunning sweep only ever
 * RE-NOTIFIES — it never re-charges. The two guards are the SAME ones `auto-topup.ts`'s
 * between-session safe-to-charge gate already reads (`hasActiveSessionForWallet`,
 * `hasOpenReceivable`); reused here, not reinvented.
 *
 * FIX ROUND 3 (N2) — `actorUserId` is the WEB Server Action's already-session-resolved actor,
 * threaded across the internal hop (never client-supplied — see `payment-method.ts`'s route
 * docblock). It rides straight through to `clearSavedCardAndReconcileMode`, which appends the
 * one `audit_events` row for this user-initiated detach, in the SAME transaction as the clear.
 */
export async function detachSavedCard(
  walletId: string,
  actorUserId: string
): Promise<DetachSavedCardResult> {
  const wallet = await creditWalletsRepository.findById(walletId);
  if (wallet === undefined) {
    return { status: 'no_wallet' };
  }

  const [activeSession, openReceivable] = await Promise.all([
    creditSessionsRepository.hasActiveSessionForWallet(walletId),
    creditReceivablesRepository.hasOpenReceivable(wallet.companyId),
  ]);
  if (activeSession || openReceivable) {
    return { status: 'settlement_outstanding' };
  }

  const { stripePaymentMethodId } = wallet;
  if (stripePaymentMethodId !== null) {
    const detached = await detachAtStripe(walletId, stripePaymentMethodId);
    if (!detached) {
      return { status: 'stripe_error' };
    }
  }

  return clearLocallyAndReconcile(walletId, stripePaymentMethodId, actorUserId);
}
