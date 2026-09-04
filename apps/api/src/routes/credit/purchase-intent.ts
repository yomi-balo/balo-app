import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { creditWalletsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { isWalletCardReusableOnSession } from '@balo/shared/credit';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { resolveAppUrl } from '../../lib/app-url.js';
import {
  ensureCustomer,
  createOnSessionPurchaseIntent,
  createOnSessionSavedCardCharge,
} from '../../services/stripe/index.js';

const log = createLogger('credit');

/**
 * Body for `POST /credit/purchase-intent` (BAL-377). The web Server Action has already
 * resolved the session + gated MANAGE_BILLING + resolved the wallet; this internal route
 * trusts that across the `requireInternalAuth` secret boundary (same trust model as
 * `/notifications/publish`). `clientRequestId` is a UUID minted client-side, STABLE across
 * double-submits of the same configuration → the Stripe idempotency key
 * `purchase:{walletId}:{paymentMethodSource}:{clientRequestId}` makes a double-click return the
 * SAME PaymentIntent (never a second charge). `promoCode` is optional (unadvertised); it rides
 * into PI metadata so the webhook grants the bonus best-effort on successful payment.
 *
 * ⚠ THE PAYMENT-METHOD SOURCE IS IN THAT KEY, AND IT IS DERIVED SERVER-SIDE (BAL-515 — see the
 * construction in the handler). The two sources build PaymentIntents with DIFFERENT params —
 * `saved_card` carries `payment_method` + `confirm: true` + `return_url`, `new_card` carries none
 * of them — and Stripe 400s a key replayed with different params. Before BAL-515 the key was
 * `purchase:{walletId}:{clientRequestId}` and the two were kept apart only by a CLIENT-side
 * convention: the web composer includes `paymentMethodSource` in its config signature and
 * re-mints `clientRequestId` when the buyer switches. That made a SERVER-side guarantee depend on
 * a browser behaving, and any other caller reusing one request id across a switch got a 400 on
 * the money path. Deriving the source here makes the separation structural: a client that reuses
 * one request id across a switch now gets two distinct keys instead of an error.
 *
 * DEFENCE-IN-DEPTH (behind `requireInternalAuth`): the amount + currency are re-asserted here,
 * independently of the web limits, so a compromised/misused internal caller can't mint an
 * arbitrary charge. Bounds mirror the web slider (A$300 … A$10,000) and the currency is
 * restricted to the supported allowlist (the charge itself is always AUD at face value).
 */
const MIN_PRESENTMENT_MINOR = 30_000; // A$300 — matches the web MIN_AMOUNT_MINOR
const MAX_PRESENTMENT_MINOR = 1_000_000; // A$10,000 — matches the web MAX_AMOUNT_MINOR
const SUPPORTED_PRESENTMENT_CURRENCIES = ['aud', 'usd', 'gbp', 'eur'] as const;

const purchaseIntentBodySchema = z.object({
  walletId: z.uuid(),
  presentmentCurrency: z
    .string()
    .length(3)
    .transform((c) => c.toLowerCase())
    .refine(
      (c): c is (typeof SUPPORTED_PRESENTMENT_CURRENCIES)[number] =>
        (SUPPORTED_PRESENTMENT_CURRENCIES as readonly string[]).includes(c),
      { message: 'unsupported_currency' }
    ),
  presentmentAmountMinor: z.number().int().min(MIN_PRESENTMENT_MINOR).max(MAX_PRESENTMENT_MINOR),
  initiatingMemberId: z.uuid(),
  clientRequestId: z.uuid(),
  promoCode: z.string().min(1).max(64).optional(),
  /**
   * Which card to charge. `new_card` (default) keeps the shipped deferred flow — the browser
   * confirms the returned client secret against its Payment Element. `saved_card` charges the
   * wallet's stored payment method, created AND confirmed here, because there is no Element to
   * submit and the browser must never learn the payment-method id.
   *
   * ⚠ The two sources build PaymentIntents with DIFFERENT params, so they must never share a
   * Stripe idempotency key — the web composer mints a fresh `clientRequestId` on a source
   * switch (its config signature includes `paymentMethodSource`). Reusing one would 400.
   */
  paymentMethodSource: z.enum(['new_card', 'saved_card']).default('new_card'),
});

export async function purchaseIntentRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/credit/purchase-intent',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const parsed = purchaseIntentBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'invalid_payload',
          details: parsed.error.issues.map((i) => i.message),
        });
      }

      const {
        walletId,
        presentmentCurrency,
        presentmentAmountMinor,
        initiatingMemberId,
        clientRequestId,
        promoCode,
        paymentMethodSource,
      } = parsed.data;

      const wallet = await creditWalletsRepository.findById(walletId);
      if (wallet === undefined) {
        return reply.status(404).send({ error: 'wallet_not_found' });
      }

      // BAL-515 — the payment-method source is part of the key STRUCTURALLY, on the server. The
      // two sources build PaymentIntents with DIFFERENT params (`saved_card` carries
      // `payment_method` + `confirm: true`), and Stripe 400s on one key reused with different
      // params. That used to hold only because the web composer includes `paymentMethodSource` in
      // its config signature and re-mints `clientRequestId` on a switch — a CLIENT-side convention
      // protecting a SERVER-side guarantee. Deriving it here makes it structural: a client that
      // reuses one request id across a switch now gets two distinct keys instead of a 400.
      const idempotencyKey = `purchase:${walletId}:${paymentMethodSource}:${clientRequestId}`;

      if (paymentMethodSource === 'saved_card') {
        const { stripeCustomerId, stripePaymentMethodId } = wallet;
        // The predicate is the single statement of "may we charge this on-session"; the two
        // explicit null checks alongside it are what actually NARROW the types (it returns a
        // boolean and does not narrow — the shape `auto-topup.ts` uses).
        if (
          !isWalletCardReusableOnSession(wallet) ||
          stripeCustomerId === null ||
          stripePaymentMethodId === null
        ) {
          log.warn(
            { op: 'purchaseIntent', walletId },
            'saved_card purchase requested for a wallet with no stored card'
          );
          return reply.status(400).send({ error: 'no_saved_card' });
        }

        const charge = await createOnSessionSavedCardCharge({
          walletId,
          customerId: stripeCustomerId,
          paymentMethodId: stripePaymentMethodId,
          presentmentCurrency,
          presentmentAmountMinor,
          initiatingMemberId,
          idempotencyKey,
          // SERVER-derived, never client-supplied — an open redirect otherwise (R15).
          returnUrl: resolveAppUrl('/billing/top-up'),
          promoCode,
        });

        if (charge.outcome === 'declined') {
          return reply.status(402).send({
            outcome: 'declined',
            code: charge.code,
            paymentIntentId: charge.paymentIntentId,
          });
        }
        if (charge.status === 'succeeded' || charge.status === 'processing') {
          // The wallet is credited by the webhook, never from this return value.
          return reply.send({ outcome: 'complete', paymentIntentId: charge.paymentIntentId });
        }
        if (charge.status === 'requires_action') {
          return reply.send({
            outcome: 'requires_action',
            clientSecret: charge.clientSecret,
            paymentIntentId: charge.paymentIntentId,
          });
        }
        // Any other terminal status (canceled, requires_capture, …) is not something the buyer
        // can complete here — report it as a decline with no specific code rather than
        // pretending the top-up landed.
        return reply
          .status(402)
          .send({ outcome: 'declined', code: null, paymentIntentId: charge.paymentIntentId });
      }

      // BAL-522 — `initiatingMemberId` is a legacy misnomer: despite the name it is already a
      // USER id (`apps/web`'s `startPurchaseAction` passes `actor.userId`), so it doubles as the
      // `ensureCustomer` actor with no schema change.
      const customerId = await ensureCustomer(wallet, { userId: initiatingMemberId });
      const { clientSecret, paymentIntentId } = await createOnSessionPurchaseIntent({
        walletId,
        customerId,
        // Already normalised to lower-case + allowlisted by the schema transform.
        presentmentCurrency,
        presentmentAmountMinor,
        initiatingMemberId,
        idempotencyKey,
        promoCode,
      });

      return reply.send({ outcome: 'needs_client_confirmation', clientSecret, paymentIntentId });
    }
  );
}
