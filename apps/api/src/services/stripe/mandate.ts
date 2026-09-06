import {
  companiesRepository,
  creditReceivablesRepository,
  creditSessionsRepository,
  creditWalletsRepository,
  usersRepository,
  db,
  type CreditWallet,
  type CompanyBillingIdentity,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { trackServer, BILLING_SERVER_EVENTS } from '@balo/analytics/server';
import type Stripe from 'stripe';
import { getStripeClient } from '../../lib/stripe.js';
import { resolveAppUrl } from '../../lib/app-url.js';
import { publishSavedCardDetached } from '../credit/saved-card-notify.js';
import type { CardDisplayFields } from './types.js';

const log = createLogger('stripe');

/** The acting member on this `ensureCustomer` touch — an id only (D2: the address is resolved
 *  server-side from `usersRepository.findEmailById`, never carried on the internal seam). */
export interface EnsureCustomerActor {
  userId: string;
}

/**
 * Ensure a Stripe Customer for the wallet and return its id (skill Mandate step 1), keeping the
 * Customer's NAME and EMAIL in sync with the company's billing identity on every `ensureCustomer`
 * touch — not just at creation.
 *
 * ⚠ BE PRECISE ABOUT WHAT "EVERY TOUCH" MEANS — IT IS NOT EVERY MONEY PATH. Two paths reach
 * Stripe WITHOUT coming through here: the `saved_card` arm of `POST /credit/purchase-intent`
 * returns from `createOnSessionSavedCardCharge` before this function is called, and off-session
 * auto-top-up charges an already-stored customer/PM directly. Neither seeds and neither syncs.
 * THE SEED IS STILL GUARANTEED, THOUGH: a saved card can only arrive via a SetupIntent, and
 * `createSetupIntent` DOES call this function — so by the time either of those paths can run, the
 * seed has already had its chance. What those paths cost is only sync FRESHNESS, and the next
 * `ensureCustomer` touch (a new-card SetupIntent, a fresh-card purchase) heals it — as does the
 * settings mutation's own post-commit sync (`services/billing/set-billing-email.ts`), which is
 * the path that matters for an EXPLICIT change and does not depend on this one at all.
 *
 * FIVE STEPS, IN ORDER — 1, 2 AND 4 RUN BEFORE THE CUSTOMER LOOKUP. An existing
 * `stripeCustomerId` skips only the CREATE inside step 3; it does NOT skip the read, the seed, or
 * the sync. ⚠ RESTORING AN EARLY RETURN AT THE TOP OF THIS FUNCTION (`if (wallet.stripeCustomerId)
 * return wallet.stripeCustomerId;`) SILENTLY DISABLES THE SEED FOR EVERY COMPANY THAT ALREADY HAS
 * A CUSTOMER — which, after the first purchase, is every company. Do not reintroduce it.
 *
 *   1. READ  — the billing-identity projection (`companiesRepository.findBillingIdentityById`,
 *      never `findById`). FAIL-SOFT.
 *   2. SEED  — iff the read succeeded AND `billingEmail` is still null: resolve the actor's own
 *      account address (`usersRepository.findEmailById`) and attempt
 *      `companiesRepository.seedBillingEmail`. FAIL-SOFT.
 *   3. ENSURE — the wallet's `stripeCustomerId`, or `stripe.customers.create` under the stable
 *      key `stripe-customer-{walletId}`. THE ONLY HARD FAILURE.
 *   4. SYNC  — `syncStripeCustomerIdentity(customerId, { name, email })`, run on BOTH the
 *      existing-customer path and the just-created path. FAIL-SOFT.
 *   5. return the customer id.
 *
 * WHY 1/2/4 ARE FAIL-SOFT AND 3 IS NOT: a display/identity read or write must never block a money
 * path — the same posture `retrieveCardDisplay` below already uses. A failed company read simply
 * means this touch creates/uses the Customer with no name/email sync; a failed seed or sync heals
 * on the next touch, because the value (or its absence) is already durable in `companies`.
 *
 * `customers.create` PARAMS ARE DELIBERATELY IDENTITY-FREE — exactly `{ metadata: { walletId } }`
 * under the stable key. Inside Stripe's 24 h idempotency window, a reused key with DIFFERENT
 * params 400s (`idempotency_error`); if the create carried `name`/`email`, a benign retry with a
 * since-changed value would turn into a hard failure on the money path. Deterministic create
 * params make the stable key collision-proof BY CONSTRUCTION. This SUPERSEDES BAL-515's
 * name-at-create: the end state is identical (the Customer ends up named), and a failed
 * post-create sync leaves "Unnamed customer" only until the next touch, not forever.
 *
 * THE SEED CONDITION is exactly "`billing_email` is null AND the actor holds `MANAGE_BILLING` on
 * the wallet's company", resolved INSIDE `seedBillingEmail`'s own transaction (D4) — atomic with
 * the conditional write, so there is no TOCTOU gap on a permanent, audited value. A platform-role
 * actor holds no company membership and fails closed. Members cannot top up
 * (`REPRESENTABLE_CAPABILITIES` excludes `MANAGE_BILLING`), so the seeded address is never a Balo
 * AE's. The actor's address is resolved SERVER-SIDE from `usersRepository.findEmailById` — the
 * internal seam carries ids, never an address (D2).
 *
 * PERSONAL WORKSPACES FOLLOW THE SAME RULE WITH NO BRANCH (decision 9, extended to email): for a
 * personal workspace the first purchaser IS the person, and the seeded address is that
 * workspace's own billing identity going to the processor already handling its card.
 *
 * `syncStripeCustomerIdentity` TAKES NO IDEMPOTENCY KEY — it is idempotent BY VALUE, not by key
 * (see its own docblock).
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
 * ⚠ ATTRIBUTION: the Customer's NAME still names the PARTY, never the purchaser — one Stripe
 * customer exists per wallet (`stripe-customer-{walletId}`) and the wallet is company-scoped, so a
 * person's name here would not label "the buyer", it would permanently label the COMPANY's
 * billing record with whoever happened to buy first. The EMAIL is different: it is now an
 * explicit, visible, editable company-level value with provenance (`/settings/billing`), captured
 * from the first purchaser only as a SEED, not frozen there invisibly and permanently — any
 * MANAGE_BILLING holder can change it, and the change is attributed to them, not silently absorbed
 * back into "whoever bought first". Whatever per-charge human identity Stripe DOES capture belongs
 * on the PaymentMethod's `billing_details`, where it would be accurate per charge instead of
 * frozen at the first one — that is where such a value goes, not a claim about what is currently
 * there (Balo sets no `billing_details`; see above).
 */
export async function ensureCustomer(
  wallet: CreditWallet,
  actor: EnsureCustomerActor
): Promise<string> {
  // 1. READ (fail-soft) — the billing-identity projection, never `findById`.
  let company: CompanyBillingIdentity | undefined;
  try {
    company = await companiesRepository.findBillingIdentityById(wallet.companyId);
  } catch (err: unknown) {
    log.warn(
      {
        op: 'ensureCustomer',
        walletId: wallet.id,
        companyId: wallet.companyId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Could not read the company billing identity — skipping the seed and the identity sync for this touch'
    );
  }

  // 2. SEED (fail-soft) — only when the company read succeeded AND the address is still null.
  let emailForSync: string | null = company?.billingEmail ?? null;
  if (company !== undefined && company.billingEmail === null) {
    emailForSync = await seedCompanyBillingEmail(wallet, actor, company);
  }

  // 3. ENSURE — the ONLY hard failure on this path (unchanged posture).
  const customerId = wallet.stripeCustomerId ?? (await createStripeCustomer(wallet));

  // 4. SYNC (fail-soft, no idempotency key) — runs on the existing-customer path too.
  if (company !== undefined) {
    await syncStripeCustomerIdentity(customerId, { name: company.name, email: emailForSync });
  }

  // 5.
  return customerId;
}

/** Step 3's create, extracted so `ensureCustomer`'s body reads as one line per step. Params are
 *  DELIBERATELY IDENTITY-FREE (decision 8) — see `ensureCustomer`'s docblock. */
async function createStripeCustomer(wallet: CreditWallet): Promise<string> {
  const stripe = getStripeClient();
  try {
    const customer = await stripe.customers.create(
      { metadata: { walletId: wallet.id } },
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
 * Step 2's seed attempt — NEVER THROWS, always resolves the address this touch's sync should
 * carry (or `null`). Resolves the actor's own account address server-side (D2), then attempts
 * `companiesRepository.seedBillingEmail` (D4: the capability gate lives INSIDE that transaction).
 *
 * ⚠ NEVER LOG THE ADDRESS. `companyId` / `walletId` / `actorUserId` only — the posture
 * `armSavedCardMandateAction` / `removeSavedCardAction` already use for their forensics logs.
 */
async function seedCompanyBillingEmail(
  wallet: CreditWallet,
  actor: EnsureCustomerActor,
  company: CompanyBillingIdentity
): Promise<string | null> {
  const { id: walletId, companyId } = wallet;
  const actorUserId = actor.userId;

  let actorEmail: string | undefined;
  try {
    actorEmail = (await usersRepository.findEmailById(actorUserId))?.email;
  } catch (err: unknown) {
    log.warn(
      {
        op: 'ensureCustomer.seed',
        walletId,
        companyId,
        actorUserId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Could not read the acting member — skipping the billing-email seed for this touch'
    );
    return null;
  }
  if (actorEmail === undefined) {
    log.warn(
      { op: 'ensureCustomer.seed', walletId, companyId, actorUserId },
      'The acting member has no live account — skipping the billing-email seed'
    );
    return null;
  }

  try {
    const result = await companiesRepository.seedBillingEmail({
      companyId,
      email: actorEmail,
      actorUserId,
    });
    if (result.seeded) {
      log.info(
        { op: 'ensureCustomer.seed', walletId, companyId, actorUserId },
        'Seeded the company billing email from the first purchaser'
      );
      trackServer(BILLING_SERVER_EVENTS.EMAIL_SEEDED, {
        company_id: companyId,
        company_is_personal: company.isPersonal,
        distinct_id: companyId,
      });
      return result.billingEmail;
    }
    // 'already_set' → a concurrent first purchase won; sync THIS touch with the WINNER's value.
    // 'no_capability' / 'company_not_found' → never seeds; this touch syncs with no email.
    return result.billingEmail;
  } catch (err: unknown) {
    log.warn(
      {
        op: 'ensureCustomer.seed',
        walletId,
        companyId,
        actorUserId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Could not seed the company billing email — skipping the identity sync address for this touch'
    );
    // ⚠ FIX ROUND (security) — RETURN `null`, NEVER `actorEmail`. The MANAGE_BILLING gate lives
    // INSIDE `seedBillingEmail`'s transaction (D4), so a throw means the gate never resolved:
    // returning the actor's address here would put an UNAUTHORIZED member's address on step 4's
    // `customers.update`, writing to Stripe a value the capability check never approved. The seed
    // is conditional and durable — the next `ensureCustomer` touch re-attempts it — so the only
    // cost of failing closed is that this one touch syncs the name alone.
    return null;
  }
}

/** ⚠ FIX ROUND (security) — PER-REQUEST OPTIONS, DELIBERATE, DO NOT DROP. `getStripeClient` sets
 *  no `timeout`, so this call would otherwise inherit stripe-node's 80 s default and, with the
 *  client's `maxNetworkRetries: 2`, could stall an `ensureCustomer` touch — i.e. a PURCHASE — for
 *  ~240 s over a DISPLAY-ONLY field. The sync is best-effort and the next `ensureCustomer` touch
 *  re-syncs, so a fast failure is strictly better than a slow success: 5 s, no retries. */
const SYNC_REQUEST_OPTIONS: Stripe.RequestOptions = { timeout: 5000, maxNetworkRetries: 0 };

/**
 * BAL-522 — mirror the company's identity onto its Stripe Customer. The ONLY writer of
 * `customers.update` in this codebase.
 *
 * ⚠ BEST-EFFORT, NEVER THROWS. Two callers: `ensureCustomer` step 4 (on the money path) and the
 * settings mutation's post-commit sync (`services/billing/set-billing-email.ts`). A throw would
 * either fail a purchase over a display field or turn a committed settings change into a 500.
 * Warn and continue — the value is already durable in `companies` and the next touch re-syncs.
 * Same posture as `retrieveCardDisplay` below. It is also BOUNDED — see `SYNC_REQUEST_OPTIONS`:
 * "never throws" is not enough on a money path if it can instead hang there.
 *
 * ⚠ NO IDEMPOTENCY KEY, DELIBERATELY. `customers.update` is idempotent BY VALUE; a stable key
 * would 400 the moment the value legitimately changes (decision 8's whole point).
 *
 * `email: null` ⇒ the key is OMITTED, never sent as `null` — a company with no billing email yet
 * must not have an existing Stripe address blanked by a sync.
 *
 * ⚠ Log `customerId` only — never the name or the address.
 */
export async function syncStripeCustomerIdentity(
  customerId: string,
  identity: { name: string; email: string | null }
): Promise<void> {
  try {
    const stripe = getStripeClient();
    await stripe.customers.update(
      customerId,
      {
        name: identity.name,
        ...(identity.email === null ? {} : { email: identity.email }),
      },
      SYNC_REQUEST_OPTIONS
    );
  } catch (err: unknown) {
    log.warn(
      {
        op: 'syncStripeCustomerIdentity',
        stripeId: customerId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Could not sync the Stripe customer identity — continuing (heals on the next touch)'
    );
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
 *
 * BAL-522 (D2) — `actorUserId` is the SESSION-resolved actor, threaded so `ensureCustomer` can
 * seed the company's billing email on this touch. Required, not optional: an omitted actor would
 * make the seed silently never happen on this path.
 */
export async function createSetupIntent(
  walletId: string,
  actorUserId: string
): Promise<{ clientSecret: string; setupIntentId: string; customerId: string }> {
  const wallet = await creditWalletsRepository.findById(walletId);
  if (wallet === undefined) {
    throw new Error(`Credit wallet not found: ${walletId}`);
  }

  const customerId = await ensureCustomer(wallet, { userId: actorUserId });
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

/**
 * The local clear + mode-reconcile, inside ONE transaction, THEN — post-commit — the BAL-521
 * notice. Rethrows after the loudest log; the transaction's throw-propagation contract is
 * preserved VERBATIM (a failure still surfaces exactly as it did before this change).
 *
 * Takes the PRE-CLEAR wallet (`detachSavedCard` already holds it from `findById`) rather than a
 * bare `walletId` — it is the ONLY place the card label (`cardBrand`/`cardLast4`) still exists
 * once the primitive nulls those columns, and it is what lets the post-commit notice fire with NO
 * extra read.
 */
async function clearLocallyAndReconcile(input: {
  wallet: CreditWallet;
  actorUserId: string;
}): Promise<DetachSavedCardResult> {
  const { wallet, actorUserId } = input;
  let result: Awaited<ReturnType<typeof creditWalletsRepository.clearSavedCardAndReconcileMode>>;
  try {
    result = await db.transaction((tx) =>
      creditWalletsRepository.clearSavedCardAndReconcileMode(tx, wallet.id, {
        actorUserId,
        source: 'user_initiated',
      })
    );
    log.info(
      { op: 'detachSavedCard', walletId: wallet.id, modeReconciled: result.modeReconciled },
      'Removed saved card and reconciled low-balance mode'
    );
  } catch (err: unknown) {
    log.error(
      {
        op: 'detachSavedCard',
        walletId: wallet.id,
        stripeId: wallet.stripePaymentMethodId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Card detached at Stripe but the local clear failed — retry converges'
    );
    throw err;
  }

  // BAL-521 §3 — POST-COMMIT, outside the transaction, and ONLY when a card was actually there.
  // `detachSavedCard` deliberately runs this transaction even with NO stored payment method, so
  // the response always upholds "no card ⇒ no card-backed mode armed" — and that repeat call
  // correctly writes its own idempotent audit row. But telling the billing holders "someone
  // removed the saved card" when NO CARD EXISTED is false and pure noise: the audit row is a
  // RECORD, the notice is a CLAIM. `publishSavedCardDetached` never throws, so a notification
  // hiccup can never turn a completed removal into a 500 (the same posture as the webhook door's
  // post-commit thunk in `dispatch.ts`).
  const hadCard = wallet.stripePaymentMethodId !== null || wallet.cardBrand !== null;
  if (hadCard) {
    await publishSavedCardDetached({
      walletId: wallet.id,
      companyId: wallet.companyId,
      source: 'user_initiated',
      modeReconciled: result.modeReconciled,
      previousLowBalanceMode: result.previousLowBalanceMode,
      cardBrand: wallet.cardBrand,
      cardLast4: wallet.cardLast4,
      dedupKey: result.auditEventId,
      detachedByUserId: actorUserId,
    });
  }

  return {
    status: 'removed',
    lowBalanceMode: result.wallet.lowBalanceMode,
    modeReconciled: result.modeReconciled,
  };
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
 * in a second tab: `settleOverdraft` then re-checks `isWalletMandateActive(wallet)` against its
 * OWN fresh wallet read (`end-session.ts:158`, BAL-525/O3 — no threaded boolean anymore), finds
 * no live mandate, and takes the `openReceivableAndDun` branch instead of charging, and the
 * dunning sweep only ever RE-NOTIFIES — it never re-charges. The two guards are the SAME ones
 * `auto-topup.ts`'s between-session safe-to-charge gate already reads
 * (`hasActiveSessionForWallet`, `hasOpenReceivable`); reused here, not reinvented.
 *
 * FIX ROUND 3 (N2) — `actorUserId` is the WEB Server Action's already-session-resolved actor,
 * threaded across the internal hop (never client-supplied — see `payment-method.ts`'s route
 * docblock). It still rides straight through to `clearSavedCardAndReconcileMode` (AMEND-10 — the
 * shape changed under BAL-521: `{ actorUserId, source: 'user_initiated' }`, not a bare string),
 * which appends the one `audit_events` row for this user-initiated detach, in the SAME
 * transaction as the clear, and (BAL-521 §3) POST-COMMIT publishes `credit.saved_card.detached`
 * to the company's billing holders — see `clearLocallyAndReconcile` below.
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

  return clearLocallyAndReconcile({ wallet, actorUserId });
}
