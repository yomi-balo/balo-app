/**
 * BAL-378 (ADR-1040 Lane 2) — `endSession` settlement flow (§7).
 *
 * Final meter → repo `end` (PURE DB: release hold, finalize the expert accrual + audit row,
 * compute the terminal overdraft, set `settlementStatus`) → if overdraft > 0, settle off-session
 * against the COMPANY mandate. Three outcomes: `processing` (credit + session-settled land via
 * the `payment_intent.succeeded` webhook — `dispatch.ts`), `requires_action` (SCA → receivable
 * + dunning), throw (hard decline → receivable + dunning). The expert is ALWAYS paid (accrual
 * committed in `end` before any charge), independent of settlement.
 */
import {
  creditReceivablesRepository,
  creditSessionsRepository,
  creditWalletsRepository,
  db,
  type CreditReceivableReason,
  type CreditSession,
  type CreditFinalizationPath,
  type CreditSettlementStatus,
} from '@balo/db';
import { CAPABILITIES } from '@balo/shared/authz';
import { isWalletMandateActive, toSettleableSession } from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';
import { SETTLEMENT_RECONCILE_MAX_AGE_MINUTES } from '@balo/shared/pricing';
import { createOffSessionCharge, retrievePaymentIntentStatus } from '../stripe/index.js';
import { authorizeSessionActor } from './authorize-session-actor.js';
import { driveSession } from './meter-driver.js';
import { finalizeBilling } from './finalize-billing.js';
import { publishSessionSettled, publishSettlementFailure } from './notify.js';
import { settlementIdempotencyKey } from './settlement.js';
import type { EndSessionServiceOutcome, EndSessionServiceResult } from './types.js';

const log = createLogger('credit-session');

type FailureReason = 'declined' | 'requires_action';

/**
 * Best-effort extraction of a failed off-session charge's PaymentIntent id — a hard-decline
 * `Stripe.errors.StripeCardError` carries `.payment_intent`. Structural (no Stripe import) so
 * the recovery reference is preserved on the receivable even on the throw path (FIX 5).
 */
function extractPaymentIntentId(error: unknown): string | null {
  if (error === null || typeof error !== 'object' || !('payment_intent' in error)) {
    return null;
  }
  const pi = (error as { payment_intent?: unknown }).payment_intent;
  if (pi === null || typeof pi !== 'object' || !('id' in pi)) {
    return null;
  }
  const id = (pi as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

/**
 * Mark the session failed/requires_action + open the receivable (soft hold) in ONE txn, then
 * publish the dunning notice + analytics POST-COMMIT (never inside the txn) — but ONLY when
 * THIS path actually opened the receivable (`created`). The async
 * `payment_intent.payment_failed` webhook opens the SAME session receivable, so gating the
 * publish on `created` guarantees exactly one dunning + one analytics fire per failed
 * session, whichever path opens it first (FIX 5). Idempotent open per session (partial unique).
 */
async function openReceivableAndDun(
  session: CreditSession,
  amountMinor: number,
  reason: FailureReason,
  paymentIntentId: string | null
): Promise<void> {
  const receivableReason: CreditReceivableReason =
    reason === 'requires_action' ? 'settlement_requires_action' : 'settlement_declined';
  const settlementStatus: Extract<CreditSettlementStatus, 'failed' | 'requires_action'> =
    reason === 'requires_action' ? 'requires_action' : 'failed';

  const { created } = await db.transaction(async (tx) => {
    await creditSessionsRepository.markSettlementResult(tx, {
      sessionId: session.id,
      status: settlementStatus,
      stripePaymentIntentId: paymentIntentId,
    });
    return creditReceivablesRepository.open(
      {
        companyId: session.companyId,
        walletId: session.walletId,
        sessionId: session.id,
        amountMinor,
        reason: receivableReason,
        stripePaymentIntentId: paymentIntentId,
      },
      tx
    );
  });

  if (created) {
    await publishSettlementFailure({
      session: toSettleableSession(session),
      reason,
      amountMinor,
      attemptEpochMs: Date.now(),
    });
  }
}

/** Settle a positive terminal overdraft off-session, handling all three charge outcomes. */
async function settleOverdraft(
  session: CreditSession,
  overdraftMinor: number,
  mandateActive: boolean
): Promise<EndSessionServiceResult> {
  const failed = (status: CreditSettlementStatus): EndSessionServiceResult => ({
    settlementStatus: status,
    overdraftSettledMinor: overdraftMinor,
  });

  // Grace only opens WITH a mandate, so this holds — but a mandate revoked mid-grace is possible.
  const wallet = mandateActive
    ? await creditWalletsRepository.findById(session.walletId)
    : undefined;
  if (
    wallet === undefined ||
    wallet.stripeCustomerId === null ||
    wallet.stripePaymentMethodId === null
  ) {
    log.warn(
      { sessionId: session.id, overdraftMinor },
      'Overdraft with no usable mandate — opening receivable + dunning'
    );
    await openReceivableAndDun(session, overdraftMinor, 'declined', null);
    return failed('failed');
  }

  try {
    const result = await createOffSessionCharge({
      reason: 'overdraft_settlement',
      walletId: session.walletId,
      customerId: wallet.stripeCustomerId,
      paymentMethodId: wallet.stripePaymentMethodId,
      currency: 'aud',
      amountMinor: overdraftMinor,
      idempotencyKey: settlementIdempotencyKey(session.id),
      memberId: session.initiatingMemberId,
      sessionId: session.id,
    });

    if (result.status === 'processing') {
      // Stamp the in-flight settlement PI so the reaper can retrieve its REAL status before
      // ever re-charging (FIX 6a) — the credit + session-settled land via the
      // payment_intent.succeeded webhook.
      await creditSessionsRepository.markSettlementResult(db, {
        sessionId: session.id,
        status: 'processing',
        stripePaymentIntentId: result.paymentIntentId,
      });
      log.info(
        { sessionId: session.id, paymentIntentId: result.paymentIntentId, overdraftMinor },
        'Overdraft settlement processing — awaiting webhook'
      );
      return failed('processing');
    }

    // requires_action (SCA) — cannot complete off-session; open a recovery receivable.
    log.warn(
      { sessionId: session.id, paymentIntentId: result.paymentIntentId },
      'Overdraft settlement requires action (SCA) — opening receivable + dunning'
    );
    await openReceivableAndDun(session, overdraftMinor, 'requires_action', result.paymentIntentId);
    return failed('requires_action');
  } catch (error) {
    // A hard-decline StripeCardError carries the failed PI — keep it as the recovery reference.
    const paymentIntentId = extractPaymentIntentId(error);
    log.error(
      {
        sessionId: session.id,
        walletId: session.walletId,
        overdraftMinor,
        paymentIntentId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Overdraft settlement failed (hard decline / error) — opening receivable + dunning'
    );
    await openReceivableAndDun(session, overdraftMinor, 'declined', paymentIntentId);
    return failed('failed');
  }
}

/**
 * SYSTEM settlement core (§7): final meter → repo `end` → settle. It performs NO actor
 * authorization — the only callers are the trusted reaper (auto-end of wrapped-idle /
 * max-duration sessions, which acts as the system, not as an actor) and the authorized
 * `endSession` wrapper below. NEVER call this from a route; a route MUST go through `endSession`.
 */
export async function endSessionAsSystem(
  sessionId: string,
  opts: { now?: Date; finalizationPath?: CreditFinalizationPath } = {}
): Promise<EndSessionServiceResult> {
  const now = opts.now ?? new Date();
  const finalizationPath: CreditFinalizationPath = opts.finalizationPath ?? 'live_capture';
  log.info({ sessionId }, 'Ending session (settlement)');

  // 1. Final meter — post any missing ticks, drive a last transition.
  await driveSession(sessionId, now);

  // 2. Repo end (pure DB): release hold, finalize accrual + audit, compute overdraft, stamp the
  //    billing-finalization markers with the finalization path.
  const ended = await creditSessionsRepository.end(sessionId, { now, finalizationPath });
  const { session, overdraftMinor, expertAccruedMinor, mandateActive, alreadyEnded } = ended;

  if (alreadyEnded) {
    return {
      settlementStatus: session.settlementStatus,
      overdraftSettledMinor: session.overdraftSettledMinor ?? 0,
    };
  }

  // 2b. BAL-399 — finalize the billing side-effects EXACTLY ONCE (payout obligation + member
  //     receipt + expert payout notice + analytics), BEFORE the settle branch so it fires for
  //     in-credit AND overdraft(processing) alike (expert-always-paid ⇒ payout booked at accrual
  //     finalization, independent of the async card outcome). The payout-record UNIQUE dedups.
  await finalizeBilling(session, finalizationPath, now);

  // 3a. In credit — nothing to charge; publish the settled receipt.
  if (overdraftMinor === 0) {
    await publishSessionSettled(toSettleableSession(session), now);
    log.info({ sessionId, expertAccruedMinor }, 'Session ended — settled (no charge)');
    return { settlementStatus: 'not_required', overdraftSettledMinor: 0 };
  }

  // 3b. Overdraft — settle off-session against the company mandate.
  return settleOverdraft(session, overdraftMinor, mandateActive);
}

/**
 * ROUTE-facing end — authorize the actor against the session's company (fail-closed,
 * CONSUME_CREDITS) so a stranger with the session UUID can't force-end it (triggering an
 * off_session card charge on the victim company), then delegate to the system settlement core.
 */
export async function endSession(
  sessionId: string,
  endedByMemberId: string,
  opts: { now?: Date } = {}
): Promise<EndSessionServiceOutcome> {
  const auth = await authorizeSessionActor({
    sessionId,
    userId: endedByMemberId,
    requireCapability: CAPABILITIES.CONSUME_CREDITS,
  });
  if (!auth.ok) {
    return auth;
  }

  // BAL-399: an EXTERNAL session cannot be wall-clock finalized on hang-up — it PARKS awaiting a
  // BAL-133 duration confirmation (no settlement here; the money block stays PENDING). The
  // live-capture path finalizes immediately as before.
  if (auth.session.durationSource === 'external') {
    const parked = await creditSessionsRepository.parkAwaitingDuration(sessionId);
    log.info({ sessionId }, 'External session parked — awaiting duration confirmation');
    return {
      ok: true,
      result: {
        settlementStatus: parked.settlementStatus,
        overdraftSettledMinor: 0,
        awaitingDuration: true,
      },
    };
  }

  const result = await endSessionAsSystem(sessionId, opts);
  return { ok: true, result };
}

/** Mark a session settled + clear any receivable when its PI is already confirmed succeeded. */
async function markSettledFromReconcile(
  session: CreditSession,
  paymentIntentId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    await creditSessionsRepository.markSettlementResult(tx, {
      sessionId: session.id,
      status: 'settled',
      stripePaymentIntentId: paymentIntentId,
    });
    await creditReceivablesRepository.clear({ sessionId: session.id }, tx);
  });
  // The receipt + analytics stay with the payment_intent.succeeded webhook (which applies the
  // ledger credit and publishes once, deduped-gated) — this only stops the reaper re-charging.
  log.info(
    { sessionId: session.id, stripePaymentIntentId: paymentIntentId },
    'Reconcile: settlement PI already succeeded — marked settled + cleared any receivable'
  );
}

/** Past the safe reconcile window (or an unknown end time) → never auto-re-charge. */
function isPastReconcileWindow(session: CreditSession, now: Date): boolean {
  if (session.endedAt === null) {
    return true;
  }
  const ageMinutes = Math.floor((now.getTime() - session.endedAt.getTime()) / 60_000);
  return ageMinutes >= SETTLEMENT_RECONCILE_MAX_AGE_MINUTES;
}

/**
 * Reaper reconciliation of a session stuck in `settlementStatus='processing'` (a crash between
 * the `end` commit and the charge, or before the webhook). A no-op unless still `processing`
 * with a positive overdraft.
 *
 * FIX 6 — before ever re-charging: if a settlement PI was stamped, retrieve its REAL status
 * and short-circuit (succeeded → settle + clear; canceled / hard-declined → fail + receivable
 * + dun). Only a genuinely-still-actionable PI, AND only within
 * `SETTLEMENT_RECONCILE_MAX_AGE_MINUTES` of `endedAt`, is re-charged (the same session-keyed
 * idempotency key returns the same PI). Past that window — near Stripe's ~24h key expiry, where
 * a re-charge would mint a SECOND PaymentIntent → double-charge — it raises a Sentry-visible
 * `log.error` for manual handling instead.
 */
export async function reconcileStuckSettlement(
  session: CreditSession,
  opts: { now?: Date } = {}
): Promise<void> {
  const now = opts.now ?? new Date();
  if (session.settlementStatus !== 'processing') {
    return;
  }
  const overdraftMinor = session.overdraftSettledMinor ?? 0;
  if (overdraftMinor <= 0) {
    return;
  }

  // 1. Check the stamped PI's real status before re-charging (read-only, safe at any age).
  const storedPaymentIntentId = session.stripePaymentIntentId;
  if (storedPaymentIntentId !== null) {
    const piStatus = await retrievePaymentIntentStatus(storedPaymentIntentId);
    if (piStatus !== null) {
      if (piStatus.status === 'succeeded') {
        await markSettledFromReconcile(session, storedPaymentIntentId);
        return;
      }
      if (piStatus.status === 'canceled' || piStatus.hardDeclined) {
        await openReceivableAndDun(session, overdraftMinor, 'declined', storedPaymentIntentId);
        return;
      }
      // else: still in flight / genuinely actionable — fall through to the age-bounded re-charge.
    }
  }

  // 2. Age bound — never re-charge past the safe window (a second PI after key expiry).
  if (isPastReconcileWindow(session, now)) {
    log.error(
      {
        sessionId: session.id,
        overdraftMinor,
        endedAt: session.endedAt,
        stripePaymentIntentId: storedPaymentIntentId,
      },
      'Settlement stuck in processing past the safe reconcile window — manual handling required (not re-charging to avoid a duplicate PaymentIntent)'
    );
    return;
  }

  // 3. Within the window + actionable → re-invoke the session-keyed charge (same PI, no double-charge).
  const wallet = await creditWalletsRepository.findById(session.walletId);
  const mandateActive = wallet !== undefined && isWalletMandateActive(wallet);
  await settleOverdraft(session, overdraftMinor, mandateActive);
  log.info(
    { sessionId: session.id, overdraftMinor },
    'Reconciled stuck settlement (re-charged within window)'
  );
}
