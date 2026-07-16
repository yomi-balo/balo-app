import { creditWalletsRepository, db, type CreditWallet } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { getStripeClient } from '../../lib/stripe.js';

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
 */
export async function ensureCustomer(wallet: CreditWallet): Promise<string> {
  if (wallet.stripeCustomerId) {
    return wallet.stripeCustomerId;
  }

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
