/**
 * BAL-515 — THE AUTO-TOP-UP REPAIR PASS. Twin of `reconcileStuckSettlement`
 * (`../credit-session/end-session.ts`), and built on the same principle: LEDGER-KEY ABSENCE IS
 * THE REPAIR TRIGGER, `retrievePaymentIntentStatus` is the read-only pre-check, and the repair
 * goes through the ordinary crediting pipeline rather than a second money path.
 *
 * Why it exists: a real A$300 top-up was charged and never credited because the webhook answered
 * 200 on a transaction that had committed nothing. `payment_intent.succeeded` is still the
 * PRIMARY crediting authority; this is the second trigger for when it never lands.
 *
 * ⚠⚠ IT NEVER CHARGES. Every Stripe call reachable from here is a READ —
 * `retrievePaymentIntentStatus`, `findPaymentIntentByIdempotencyKey` (a `list`, never a
 * `create`), and `retrieveSettlement` inside the repair arm. `createOffSessionCharge` is not
 * imported and must never be. This is the ONE structural difference from
 * `reconcileStuckSettlement`, which CAN re-invoke a session-keyed charge and therefore needs an
 * age bound (`isPastReconcileWindow`) to avoid minting a second PaymentIntent past Stripe's ~24h
 * key expiry. Because nothing here can mint a PaymentIntent, this pass needs NO upper age bound:
 * an old marker is still safely repairable, and refusing to repair it would strand money.
 *
 * ⚠ IT NEVER GATES ON A MANDATE COLUMN, DELIBERATELY. It does READ one — `walletLogFields` puts
 * `wallet.mandateStatus` on every record — but no branch in this file consults it, and none may.
 * `applyAutoTopupFromStripe` builds a credit effect and nothing else, so a wrongly-`failed`
 * mandate (the known `resolveSetupIntentFailed` gap: a new card's failed SetupIntent revokes a
 * working mandate captured against a DIFFERENT card) can never block recovery of money that has
 * already been charged. Fail-closed on the CHARGING side must not become fail-closed on the
 * RECORDING side — that would turn a cosmetic mandate bug into permanent money loss. The read is
 * purely observational: a wallet whose auto-top-up stopped for that reason is then visible in
 * Axiom beside its money state. Pinned by the `mandateStatus: 'failed'` repair test.
 *
 * ⚠ CONCURRENCY: no row claim, no `FOR UPDATE` — identical to `reconcileStuckSettlement`. Safety
 * is (a) `applyLedgerEntry`'s per-wallet advisory lock and (b) the ledger `idempotency_key`
 * unique. A webhook racing this repair dedups; whoever takes the lock first writes. No double
 * credit is possible either way, so racing a live delivery costs a no-op, not money.
 *
 * ⚠ IMPORT DISCIPLINE. `applyAutoTopupFromStripe` is imported DIRECTLY from
 * `../stripe/dispatch.js` and the readers directly from `../stripe/charges.js`, never via
 * `../stripe/index.js` — the barrel re-exports `dispatch.js`, which imports `../credit/auto-topup.js`.
 * This module is not imported by `dispatch.ts`, so there is no cycle; the direct imports match
 * `auto-topup.ts`'s own cycle-avoidance note.
 */
import { creditLedgerRepository, creditWalletsRepository, deriveIdempotencyKey } from '@balo/db';
import type { CreditWallet } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { TOPUP_RECONCILE_ESCALATE_AFTER_MS } from '@balo/shared/pricing';
import {
  findPaymentIntentByIdempotencyKey,
  retrievePaymentIntentStatus,
  type PaymentIntentStatusResult,
} from '../stripe/charges.js';
import { applyAutoTopupFromStripe } from '../stripe/dispatch.js';
import { publishAutoTopupFailed } from './auto-topup.js';

const log = createLogger('credit-auto-topup-reconcile');

/**
 * BAL-515 — the repair transaction resolved without its ledger row being visible afterwards.
 *
 * Thrown so the marker is NEVER cleared ahead of a credit that may not exist. The sweep's per-row
 * catch logs it and moves on; the row is still `pending` next tick, with its PaymentIntent id and
 * crossing correlation intact, so the repair simply runs again. Mirrors
 * `StripeWebhookCommitProofError` on the webhook route — same failure, same refusal to declare
 * success on unproven money.
 */
export class AutoTopupRepairCommitProofError extends Error {
  constructor(walletId: string, crossingKey: string) {
    super(
      `Auto-top-up repair commit proof failed: wallet ${walletId} has no committed ledger row for ${crossingKey}`
    );
    this.name = 'AutoTopupRepairCommitProofError';
  }
}

/**
 * Why a row alarmed. BOTH arms WRITE NOTHING and leave the marker exactly as it was, so the row
 * re-presents next tick and a human still has every handle needed to resolve it by hand.
 *
 * `payment_intent_unresolvable` — the PaymentIntent could not be identified conclusively.
 * `partial_refund` — the charge succeeded, PART of it was refunded, and the remainder is credit
 * the customer is still owed. See `repairOrClear` for why that cannot be settled automatically.
 */
export type AutoTopupReconcileAlarmReason = 'payment_intent_unresolvable' | 'partial_refund';

/**
 * The discriminated outcome, for the sweep's aggregation and the unit tests.
 *
 * `alarm` is the only arm that WRITES NOTHING while also not deferring: the crossing cannot be
 * settled by any rule this pass may safely apply, and clearing a marker on a false negative would
 * let a later crossing fire a second charge under a DIFFERENT key — the one double-charge this
 * design must not create. It needs a human, which is why the sweep aggregates it into a `log.error`.
 *
 * `refunded` is terminal and CREDITS NOTHING: the charge succeeded and the money has since gone
 * back to the customer IN FULL, so the marker is drained and the crossing closed. Crediting it
 * would hand the company the face value on top of the refund. ⚠ A PARTIAL refund is NOT this arm.
 */
export type AutoTopupReconcileOutcome =
  | { outcome: 'skipped'; reason: 'not_pending' | 'no_charge_found' }
  | { outcome: 'repaired'; paymentIntentId: string }
  | { outcome: 'already_credited'; paymentIntentId: string }
  | { outcome: 'refunded'; paymentIntentId: string }
  | { outcome: 'failed_closed'; paymentIntentId: string }
  | { outcome: 'deferred'; reason: 'pi_unreadable' | 'still_in_flight' }
  | { outcome: 'alarm'; reason: AutoTopupReconcileAlarmReason };

/** The identifiers every log on this path carries (§13 — one shape, never re-spelled). */
function walletLogFields(wallet: CreditWallet): Record<string, unknown> {
  return {
    op: 'reconcileStuckAutoTopup',
    walletId: wallet.id,
    companyId: wallet.companyId,
    triggeringEntryId: wallet.pendingTopupTriggeringEntryId,
    pendingTopupAt: wallet.pendingTopupAt,
    // BAL-515 §10.2 — carried so a wallet whose auto-top-up stopped on a wrongly-revoked mandate
    // is visible HERE, beside its money state, rather than needing a separate investigation.
    mandateStatus: wallet.mandateStatus,
  };
}

/**
 * Resolve the PaymentIntent id for a crossing whose marker is stuck.
 *
 * Fast path: the engine stamped it on the wallet. Slow path: phase 2 threw between
 * `paymentIntents.create` and the stamp, so the id is recovered READ-ONLY from Stripe by the
 * crossing's idempotency key and persisted, so the next tick takes the fast path.
 *
 * Returns `null` when the scan proves no charge was ever created (the marker is then drained by
 * the caller), or `undefined` when the answer is inconclusive and nothing may be written.
 */
async function resolvePaymentIntentId(
  wallet: CreditWallet,
  triggeringEntryId: string,
  crossingKey: string,
  pendingSince: Date
): Promise<string | null | undefined> {
  if (wallet.pendingTopupPaymentIntentId !== null) {
    return wallet.pendingTopupPaymentIntentId;
  }
  if (wallet.stripeCustomerId === null) {
    // Nothing to scan: an off-session charge cannot exist without a customer. Inconclusive
    // rather than "never created" — a wallet can lose its customer id by other routes.
    return undefined;
  }
  const lookup = await findPaymentIntentByIdempotencyKey({
    customerId: wallet.stripeCustomerId,
    idempotencyKey: crossingKey,
    createdAfter: pendingSince,
  });
  if (lookup.found) {
    // Persist so the next tick is a single retrieve. A `false` here (marker moved on) is fine —
    // this tick still proceeds with the id it just recovered.
    await creditWalletsRepository.recordPendingTopupPaymentIntent({
      walletId: wallet.id,
      triggeringEntryId,
      paymentIntentId: lookup.paymentIntentId,
    });
    return lookup.paymentIntentId;
  }
  return lookup.exhaustive ? null : undefined;
}

/** The refund + amount facts `repairOrClear` needs off the resolved PaymentIntent status. */
type RefundFacts = Pick<
  PaymentIntentStatusResult,
  'refundedFully' | 'amountRefundedMinor' | 'amountMinor' | 'currency'
>;

/**
 * `succeeded` at Stripe: credit it if the ledger has no row for the crossing, else just clear.
 *
 * ⚠⚠ FULL AND PARTIAL REFUNDS TAKE DIFFERENT ARMS, AND THE DIFFERENCE IS REAL MONEY. This function
 * once took a single `refunded: boolean` derived as `charge.refunded || amount_refunded > 0`. On an
 * A$300 charge with an A$25 refund that boolean was `true`, so the terminal arm fired: the marker
 * was DRAINED, NOTHING was credited, and the A$275 the customer had genuinely paid for was gone —
 * silently and unrecoverably, because with the marker drained the crossing never re-presents.
 *
 * ⚠ WHY A PARTIAL REFUND ALARMS RATHER THAN CREDITING THE REMAINDER. The obvious alternative —
 * credit `amount − amount_refunded` — cannot be expressed on this path without FORKING THE MONEY
 * PATH, which is the one thing this module refuses to do. The repair credits by handing
 * `applyAutoTopupFromStripe` a PaymentIntent id; that builds the SAME `{kind:'credit',
 * reason:'auto_topup'}` effect the webhook builds, and its amount is `retrieveSettlement`'s
 * `balance_transaction.amount` — the GROSS settled AUD of the ORIGINAL charge, which a refund does
 * NOT reduce (Stripe books a refund as a SEPARATE balance transaction). Writing a different figure
 * would mean either a bespoke ledger write here (a second money path) or an entry whose
 * `amount_minor` disagrees with the `stripe_balance_transaction_id` it carries — breaking the
 * reconciliation invariant that every money entry ties back to its balance transaction, and
 * feeding `credit.auto_topup.executed` a `reloadedMinor` that matches no Stripe object. A partial
 * refund on an auto-top-up is also not a state this system can produce: only a human in the
 * Dashboard can create one, so a human is exactly who should finish it.
 *
 * So: WRITE NOTHING, leave the marker and both correlation columns intact, and alarm. The row
 * re-presents every tick with the PaymentIntent id still on it until someone resolves it — either
 * by completing the refund (then the terminal arm takes it) or by crediting the remainder by hand.
 */
async function repairOrClear(
  wallet: CreditWallet,
  triggeringEntryId: string,
  crossingKey: string,
  paymentIntentId: string,
  refund: RefundFacts
): Promise<AutoTopupReconcileOutcome> {
  const existingCredit = await creditLedgerRepository.findByIdempotencyKey(crossingKey);
  if (existingCredit !== undefined) {
    // The webhook did credit; only the marker was left behind (its clear rides the FRESH branch,
    // so a deduped delivery returns early without clearing). Nothing to repair.
    await creditWalletsRepository.clearPendingTopup({ walletId: wallet.id, triggeringEntryId });
    log.info(
      {
        ...walletLogFields(wallet),
        paymentIntentId,
        crossingKey,
        refundedFully: refund.refundedFully,
        amountRefundedMinor: refund.amountRefundedMinor,
      },
      'Reconcile: auto-top-up PI succeeded AND the ledger credit exists — cleared the stale in-flight marker'
    );
    return { outcome: 'already_credited', paymentIntentId };
  }

  if (refund.refundedFully) {
    // ⚠ A REFUND DOES NOT MOVE A PaymentIntent OFF `succeeded`, so nothing above this line can see
    // it. This pass has NO upper age bound by design, and its own alarm tells a responder to
    // "check each crossing in the Stripe Dashboard" — where refunding the customer is the obvious
    // remedy. Without this arm the very next tick would read `succeeded`, find no ledger row, and
    // credit the wallet at full face value: the company keeps the refund AND the credit.
    // TERMINAL and CREDITS NOTHING — and terminal ONLY because Stripe's own `charge.refunded` flag
    // says the charge was reversed IN FULL, i.e. there is provably no remainder to owe anyone.
    await creditWalletsRepository.clearPendingTopup({ walletId: wallet.id, triggeringEntryId });
    log.warn(
      {
        ...walletLogFields(wallet),
        paymentIntentId,
        crossingKey,
        refundedFully: true,
        amountRefundedMinor: refund.amountRefundedMinor,
        amountMinor: refund.amountMinor,
      },
      'Reconcile: auto-top-up charge was FULLY refunded and never credited — cleared the marker WITHOUT crediting (Stripe reports the charge reversed in full, so no credit is owed)'
    );
    return { outcome: 'refunded', paymentIntentId };
  }

  if (refund.amountRefundedMinor > 0) {
    // ⚠⚠ PART OF THE MONEY CAME BACK AND PART DID NOT. Neither automated answer is safe (see the
    // docblock), so this writes NOTHING — no credit, no clear — and escalates. The message states
    // the un-refunded remainder rather than asserting where the money is.
    log.error(
      {
        ...walletLogFields(wallet),
        paymentIntentId,
        crossingKey,
        amountMinor: refund.amountMinor,
        amountRefundedMinor: refund.amountRefundedMinor,
        unrefundedMinor: refund.amountMinor - refund.amountRefundedMinor,
        currency: refund.currency,
      },
      'Reconcile: auto-top-up charge was PARTIALLY refunded and has no ledger credit — wrote NOTHING and cleared NOTHING; the un-refunded remainder is still owed to the company and needs a human (complete the refund, or credit the remainder by hand)'
    );
    return { outcome: 'alarm', reason: 'partial_refund' };
  }

  // THE REPAIR ARM. A throw before the credit commits propagates to the sweep's per-row catch and
  // retries next tick; nothing is cleared ahead of the money.
  //
  // ⚠ THE POST-COMMIT EFFECTS COME BACK UNRUN, DELIBERATELY. `applyAutoTopupFromStripe` used to run
  // them itself — i.e. the `credit.auto_topup.executed` notice and `AUTO_TOPUP_FIRED` analytics
  // fired BEFORE the commit proof below, the exact inverse of `routes/stripe/webhook.ts`, where the
  // read-back deliberately precedes the post-commit drain so an UNCOMMITTED effect can never
  // notify. A phantom commit would otherwise tell the client "we added $100" about a credit that
  // does not exist. They run at the bottom of this function, after the proof.
  const postCommit = await applyAutoTopupFromStripe(wallet.id, triggeringEntryId, paymentIntentId);

  // ⚠⚠ COMMIT PROOF — the same guard the webhook route carries (`routes/stripe/webhook.ts`), for
  // the same reason and against the same failure. A resolved `db.transaction()` is NOT proof of a
  // commit: over the Supabase pooler a named COMMIT can be lost and Postgres roll everything back
  // silently. That is the incident this ticket exists to close, and this is the SECOND crediting
  // trigger — so it needs the proof too. Without it, the in-transaction marker clear rolls back
  // while the clear BELOW (a separate autocommit statement) lands: credit gone, marker gone,
  // evidence gone, and the sweep reports `repaired: 1` on a crossing that is now permanently
  // unreconcilable. Re-read on the BASE `db` (a different pooled connection) and throw if absent;
  // the sweep's per-row catch retries the row next tick with everything still intact.
  const committedCredit = await creditLedgerRepository.findByIdempotencyKey(crossingKey);
  if (committedCredit === undefined) {
    log.error(
      { ...walletLogFields(wallet), paymentIntentId, crossingKey },
      'Reconcile: the auto-top-up repair transaction resolved but its ledger row is NOT committed — refusing to clear the marker; retrying next tick'
    );
    throw new AutoTopupRepairCommitProofError(wallet.id, crossingKey);
  }

  // Belt-and-braces: `applyCredit`'s auto-top-up arm clears the marker in-transaction on the
  // FRESH branch, but returns early (without clearing) when the ledger write deduped against a
  // webhook that won the race in between. GUARDED on the crossing — see `clearPendingTopup`.
  await creditWalletsRepository.clearPendingTopup({ walletId: wallet.id, triggeringEntryId });

  // Post-commit side-effects, on PROVEN money — the webhook route's ordering, mirrored. Each
  // publish is best-effort and idempotent by `correlationId` (BullMQ jobId dedup).
  for (const run of postCommit) {
    await run();
  }

  log.warn(
    { ...walletLogFields(wallet), paymentIntentId, crossingKey, appliedByReconcile: true },
    'Reconcile: auto-top-up PI succeeded but NO auto_topup ledger credit existed — applied the credit here (the webhook never landed)'
  );
  return { outcome: 'repaired', paymentIntentId };
}

/**
 * The reload definitively failed and its `payment_intent.payment_failed` webhook was also lost.
 *
 * ⚠ THE FIGURES MUST BE CROSSING-TIME, NOT SWEEP-TIME. This arm exists precisely for when the
 * sync notice never went out, so its "we couldn't add $X" is the ONLY thing the buyer ever reads.
 * `attemptedMinor` therefore comes from the PaymentIntent's own `amount` — the amount pinned when
 * the charge was made — never from `wallet.topupReloadMinor`, which is re-read here minutes-to-
 * days later and states a figure that may never have been attempted (the company can change its
 * reload at any time). `attemptedMinor` is the only money figure the notification payload carries
 * (`publishAutoTopupFailed` → `credit.auto_topup.failed`), so it is the one that must be true.
 *
 * ⚠ `triggerBalanceMinor` IS GENUINELY UNRECOVERABLE HERE, and is passed as a sweep-time reading.
 * The resting balance at fire time is persisted nowhere: the success path reconstructs it as
 * `balanceAfter − reload` from the credit, and this arm has no credit. It is ANALYTICS-ONLY and
 * `publishAutoTopupFailed` reads it exclusively under `if (input.emitAnalytics)` — which is
 * `false` on every call from this module — so nothing is emitted from it and no customer-facing
 * copy asserts it. If this ever emits analytics, that value must be dropped or persisted first.
 */
async function failClosed(
  wallet: CreditWallet,
  triggeringEntryId: string,
  paymentIntentId: string,
  reason: 'declined' | 'requires_action',
  attemptedMinor: number
): Promise<AutoTopupReconcileOutcome> {
  await creditWalletsRepository.clearPendingTopup({ walletId: wallet.id, triggeringEntryId });
  // `emitAnalytics: false` — the SYNC engine owns auto-top-up analytics, exactly the posture of
  // the async belt in `dispatch.ts`. The shared `…:failed` correlationId dedups this notice
  // against any the sync path already sent, so the client sees one message however it arrives.
  await publishAutoTopupFailed({
    walletId: wallet.id,
    companyId: wallet.companyId,
    triggeringEntryId,
    reason,
    attemptedMinor,
    triggerBalanceMinor: wallet.balanceMinor,
    emitAnalytics: false,
  });
  log.warn(
    { ...walletLogFields(wallet), paymentIntentId, failedReason: reason, attemptedMinor },
    'Reconcile: auto-top-up PI cannot complete (canceled / hard-declined / authentication required) — cleared the marker and published the failed notice (the payment_failed webhook never landed)'
  );
  return { outcome: 'failed_closed', paymentIntentId };
}

/**
 * PaymentIntent statuses an OFF-SESSION auto-top-up charge can never leave under its own power.
 *
 * Nothing in this system re-confirms an auto-top-up PaymentIntent — the sync engine is done, and
 * this pass is read-only by construction — so a PI parked in any of these will sit there until
 * Stripe expires it. Treating them as "still in flight" is what made a stuck marker immortal.
 * `requires_capture` is deliberately absent: that money IS authorised and must not be written off.
 */
const CANNOT_COMPLETE_OFF_SESSION: ReadonlySet<string> = new Set([
  'requires_action',
  'requires_payment_method',
  'requires_confirmation',
]);

/**
 * The crossing-time amount the charge was made for, in AUD minor units.
 *
 * Every Balo off-session charge is created with `currency: 'aud'`, so `pi.amount` IS the AUD face
 * value that was attempted. The currency check is not paranoia: crediting or reporting a non-AUD
 * minor amount AS AUD is the same class of bug `retrieveSettlement`'s AUD guard exists for. On a
 * currency mismatch fall back to the wallet's configured reload and say so — a stale-but-AUD
 * figure beats a wrong-currency one.
 */
function attemptedMinorFor(
  wallet: CreditWallet,
  piStatus: { amountMinor: number; currency: string }
): number {
  if (piStatus.currency === 'aud') {
    return piStatus.amountMinor;
  }
  log.warn(
    {
      ...walletLogFields(wallet),
      piCurrency: piStatus.currency,
      piAmountMinor: piStatus.amountMinor,
    },
    'Reconcile: auto-top-up PaymentIntent is not in AUD — falling back to the wallet reload for the failed notice'
  );
  return wallet.topupReloadMinor;
}

/**
 * Reconcile ONE wallet whose auto-top-up in-flight marker has stood past the cutoff.
 *
 * The caller (`jobs/auto-topup-reconcile-sweep.ts`) supplies rows from
 * `findStuckPendingTopups`, which already filters on both marker columns; the guard below is the
 * independent second check, so this function is safe to call with any wallet.
 *
 * `opts.now` is injectable for the same reason `reconcileStuckSettlement` takes one — the aging
 * escalation below is a real branch and must be testable without fake timers.
 */
export async function reconcileStuckAutoTopup(
  wallet: CreditWallet,
  opts: { now?: Date } = {}
): Promise<AutoTopupReconcileOutcome> {
  const now = opts.now ?? new Date();
  const pendingSince = wallet.pendingTopupAt;
  const triggeringEntryId = wallet.pendingTopupTriggeringEntryId;
  if (pendingSince === null || triggeringEntryId === null) {
    return { outcome: 'skipped', reason: 'not_pending' };
  }

  // The ONE key three places agree on: the Stripe idempotency key on the original charge, the
  // webhook's `ledgerKeyForCredit`, and this lookup.
  const crossingKey = deriveIdempotencyKey({
    reason: 'auto_topup',
    walletId: wallet.id,
    triggeringEntryId,
  });

  const paymentIntentId = await resolvePaymentIntentId(
    wallet,
    triggeringEntryId,
    crossingKey,
    pendingSince
  );
  if (paymentIntentId === undefined) {
    // ⚠ WRITE NOTHING. The scan was inconclusive (Stripe unreadable, more than a page of
    // candidates, or no customer to scan). Draining the marker on a false negative would let a
    // later crossing fire a SECOND charge under a different key.
    log.warn(
      { ...walletLogFields(wallet), crossingKey },
      'Reconcile: could not resolve the auto-top-up PaymentIntent conclusively — writing nothing'
    );
    return { outcome: 'alarm', reason: 'payment_intent_unresolvable' };
  }
  if (paymentIntentId === null) {
    // Proven: no charge was ever created, so the throw happened before Stripe received it. This
    // is what drains the row.
    await creditWalletsRepository.clearPendingTopup({ walletId: wallet.id, triggeringEntryId });
    log.warn(
      { ...walletLogFields(wallet), crossingKey },
      'Reconcile: no auto-top-up charge was ever created for this crossing — cleared the marker'
    );
    return { outcome: 'skipped', reason: 'no_charge_found' };
  }

  const piStatus = await retrievePaymentIntentStatus(paymentIntentId);
  if (piStatus === null) {
    log.warn(
      { ...walletLogFields(wallet), paymentIntentId },
      'Reconcile: could not read the auto-top-up PaymentIntent status — deferring to the next tick'
    );
    return { outcome: 'deferred', reason: 'pi_unreadable' };
  }

  if (piStatus.status === 'succeeded') {
    return repairOrClear(wallet, triggeringEntryId, crossingKey, paymentIntentId, piStatus);
  }
  if (piStatus.status === 'canceled' || piStatus.hardDeclined) {
    return failClosed(
      wallet,
      triggeringEntryId,
      paymentIntentId,
      'declined',
      attemptedMinorFor(wallet, piStatus)
    );
  }
  if (CANNOT_COMPLETE_OFF_SESSION.has(piStatus.status)) {
    // ⚠ `requires_action` IS A DEFINITE NON-COMPLETION, NOT AN IN-FLIGHT STATE — and this file
    // used to disagree with the engine that created the charge. `auto-topup.ts` fail-closes on it
    // ("an off-session intent cannot complete SCA"); here it fell through to the defer below,
    // where `hardDeclined` is false for an `authentication_required` error, so the row wrote
    // nothing, logged, and repeated EVERY MINUTE FOREVER — the marker never clearing and the
    // wallet never leaving `findStuckPendingTopups`. Two code paths, opposite conclusions about
    // one status. `requires_payment_method` (where Stripe actually parks an off-session SCA
    // failure, per the skill) and `requires_confirmation` join it: nothing in this system ever
    // re-confirms an auto-top-up PaymentIntent, so none of the three can ever become paid.
    // `requires_capture` is deliberately NOT here — that money IS authorised.
    return failClosed(
      wallet,
      triggeringEntryId,
      paymentIntentId,
      'requires_action',
      attemptedMinorFor(wallet, piStatus)
    );
  }

  // `processing` (or the unreachable `requires_capture`) — genuinely still in flight.
  const stuckForMs = now.getTime() - pendingSince.getTime();
  if (stuckForMs >= TOPUP_RECONCILE_ESCALATE_AFTER_MS) {
    // ⚠ NOTHING MAY DEFER SILENTLY FOREVER. `reconcileStuckSettlement` escalates its equivalent
    // dead end to `log.error` for exactly this reason and this twin dropped it: an `info` repeated
    // every minute is indistinguishable from health. A PaymentIntent that has been `processing`
    // for hours is not a race any more — it needs a human, and only an `error` reaches one.
    log.error(
      { ...walletLogFields(wallet), paymentIntentId, piStatus: piStatus.status, stuckForMs },
      'Reconcile: auto-top-up PaymentIntent has been in flight far past the escalation window — nothing was written; manual handling required'
    );
    return { outcome: 'deferred', reason: 'still_in_flight' };
  }
  log.info(
    { ...walletLogFields(wallet), paymentIntentId, piStatus: piStatus.status, stuckForMs },
    'Reconcile: auto-top-up PaymentIntent is still in flight — writing nothing'
  );
  return { outcome: 'deferred', reason: 'still_in_flight' };
}
