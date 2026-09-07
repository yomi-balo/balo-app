/**
 * BAL-378 (ADR-1040 Lane 2) — `endSession` settlement flow (§7).
 *
 * Final meter → repo `end` (PURE DB: release hold, finalize the expert accrual + audit row,
 * compute the terminal overdraft, set `settlementStatus`) → if overdraft > 0, settle off-session
 * against the COMPANY mandate. Three outcomes: `processing` (credit + session-settled land via
 * the `payment_intent.succeeded` webhook — `dispatch.ts`), `requires_action` (SCA → receivable
 * + dunning), throw (hard decline → receivable + dunning). The expert is ALWAYS paid — the
 * accrual is committed in `end` (or in the presence settlement, BAL-412) BEFORE any charge, and
 * is independent of the PAYMENT outcome. ⚠ ADR-1044 §7 amended WHAT is paid: **"expert paid for
 * time made available, with a 15-minute floor when present"**, not "actual minutes". A missed
 * call accrues NOTHING. See
 * `packages/db/src/invariants/expert-paid-for-time-made-available.test.ts`.
 *
 * ⚠⚠ BAL-412 — `finalizeAndSettle` IS THE SHARED POST-COMMIT TAIL, used by BOTH
 * `endSessionAsSystem` (the `live_capture`/`external` path, below) AND
 * `settleSessionFromPresence` (`./settle-from-presence.ts`, the presence-derived path). It is
 * everything AFTER the money is written to the row — `finalizeBilling`, the in-credit receipt
 * publish, the auto-top-up trigger, and the overdraft settle branch — extracted so there is ONE
 * implementation of that ~80-line tail rather than two drifting copies (SonarCloud's new-code
 * duplication gate). Nothing about the shipped `endSessionAsSystem` behaviour changed by this
 * extraction — `end-session.test.ts`'s existing assertions are the regression guard.
 */
import {
  acquireWalletLock,
  creditLedgerRepository,
  creditReceivablesRepository,
  creditSessionsRepository,
  creditWalletsRepository,
  db,
  deriveIdempotencyKey,
  type CreditReceivableReason,
  type CreditSession,
  type CreditFinalizationPath,
  type CreditSettlementStatus,
} from '@balo/db';
import { CAPABILITIES } from '@balo/shared/authz';
import {
  isWalletMandateActive,
  resolveSettlementInstrument,
  toSettleableSession,
} from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';
import { SETTLEMENT_RECONCILE_MAX_AGE_MINUTES } from '@balo/shared/pricing';
import {
  applyOverdraftSettlementFromStripe,
  createOffSessionCharge,
  retrievePaymentIntentStatus,
} from '../stripe/index.js';
import { triggerAutoTopupBestEffort } from '../credit/auto-topup.js';
import { clearLateOpenedReceivableIfCovered } from '../credit/receivable-coverage.js';
import { authorizeSessionActor } from './authorize-session-actor.js';
import { driveSession } from './meter-driver.js';
import { finalizeBilling } from './finalize-billing.js';
import { publishSessionSettled, publishSettlementFailure } from './notify.js';
import { settlementIdempotencyKey } from './settlement.js';
import type { EndSessionServiceOutcome, EndSessionServiceResult } from './types.js';

// SETTLEMENT_NO_USABLE_MANDATE_MSG and SETTLEMENT_PIN_DISAGREES_MSG are matched by EXACT string
// equality by the BAL-545 Axiom monitors (docs/ops/settlement-consent-instrument-pin-monitors.md).
// SETTLEMENT_MANDATE_REVIVED_MSG has no monitor; it is exported only so its wording is pinned.
// Rewording a monitored one is a four-place change: this constant, the literal in
// `end-session.test.ts`, the monitor's query in Axiom, and the runbook.
export const SETTLEMENT_NO_USABLE_MANDATE_MSG =
  'Overdraft with no usable mandate AT SETTLEMENT TIME — opening receivable + dunning';
export const SETTLEMENT_MANDATE_REVIVED_MSG =
  'Overdraft mandate went from inactive at commit to active at settlement — charging on the fresh mandate';
export const SETTLEMENT_PIN_DISAGREES_MSG =
  'Settlement instrument pin disagrees with the wallet — charging the live instrument (BAL-525: the pin is evidence and preference, never authority)';

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
 *
 * ⚠⚠ R3b (BAL-535, ADR-1040 Amendment 6 §F residual) — THE LATE-RECEIVABLE RESIDUAL. A
 * settlement PI can fail (or this reconcile arm can find it canceled/hard-declined — see
 * `reconcileStuckSettlement`) AFTER a covering top-up has already returned the wallet to a
 * non-negative balance: the settlement failure is real and worth recording, but re-imposing the
 * hold and re-dunning a company that owes nothing reproduces the exact defect R3 exists to
 * remove, and it would look intermittently broken to precisely the clients who used the exit.
 * So the receivable STILL opens (the event is recorded), but a fresh wallet read INSIDE THIS SAME
 * TXN decides whether it self-clears immediately: if the company's own CASH already covers the
 * debt, clear the just-opened row here and suppress the dunning publish.
 * `clearLateOpenedReceivableIfCovered` is the SAME decision `dispatch.ts`'s
 * `handleOverdraftChargeFailed` makes — one implementation, never a second, and it is where the
 * deliberate `created`-blindness (N3), the promo discount (B1) and the audit trace (N2) live.
 *
 * ⚠⚠ M2 (fix round) — THE WALLET LOCK IS THE FIRST STATEMENT OF THIS TRANSACTION. Nothing here
 * calls `applyLedgerEntry`, so before the lock this transaction did not serialise against the
 * credit path at all: T1 could insert the receivable (uncommitted), T2 could credit the wallet
 * and find zero open rows to clear, and T1's fresh wallet read below would still see the
 * pre-credit negative balance — committing an open receivable plus dunning against a company
 * that had paid in full. Taking the same `pg_advisory_xact_lock` the credit path takes makes the
 * two strictly ordered.
 *
 * ⚠ ON DEADLOCK-FREEDOM, STATED HONESTLY (fix round 3). An earlier draft of this comment claimed
 * "one lock class and no second means no ordering cycle can exist". That OVERSTATES the proof:
 * ROW locks on `credit_sessions` and `credit_wallets` are locks too, so this is not a
 * single-lock-class system. What actually holds is narrower and worth stating precisely: the
 * advisory lock is the only ADVISORY one, at most one is taken per transaction (distinct wallets
 * hash to distinct keys), and every writer that touches those rows takes it BEFORE its first row
 * write. So all row-lock acquisition on this wallet happens underneath one globally-ordered
 * gate, and two transactions cannot hold row locks the other needs while waiting on each other.
 * That is a property of the CALLERS, not of the lock — so it is only true for as long as every
 * new writer keeps taking the wallet lock first.
 *
 * ⚠ THIS IS THE SECOND WALLET READ VIA THAT REPOSITORY IN THIS FILE (deliberate, pinned by the
 * invariant suite's drift alarm) — and NEITHER of the two is a mode read. `settleOverdraft`'s
 * (the first) verifies the mandate is still live before charging; THIS one only asks whether the
 * wallet's balance already covers a debt that is about to be recorded as unpaid. Mode is never
 * consulted by either (ADR-1040 Amendment 6 §A.1/§C).
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

  const { created, alreadyCovered } = await db.transaction(async (tx) => {
    // M2 — FIRST statement: serialise this whole transaction against the credit path.
    await acquireWalletLock(tx, session.walletId);
    await creditSessionsRepository.markSettlementResult(tx, {
      sessionId: session.id,
      status: settlementStatus,
      stripePaymentIntentId: paymentIntentId,
    });
    const { receivable, created } = await creditReceivablesRepository.open(
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
    const wallet = await creditWalletsRepository.findById(session.walletId, tx);
    if (wallet === undefined) {
      return { created, alreadyCovered: false };
    }
    const alreadyCovered = await clearLateOpenedReceivableIfCovered(tx, {
      receivable: {
        id: receivable.id,
        companyId: session.companyId,
        sessionId: session.id,
        amountMinor,
      },
      walletId: session.walletId,
      balanceMinor: wallet.balanceMinor,
      created,
      openedBy: 'end_session',
      // The member who ended the session is not the party whose money covered the debt, and the
      // reconcile arm has no actor at all — this is a system clear, like the webhook's.
      actorUserId: null,
      stripePaymentIntentId: paymentIntentId,
    });
    return { created, alreadyCovered };
  });

  if (created && !alreadyCovered) {
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
  /**
   * ⚠⚠ OBSERVATION ONLY — NEVER A GATE. The mandate verdict computed inside the terminal
   * wallet-locked transaction (`end`/`settleFromPresence`), which has since COMMITTED and
   * dropped its lock. BAL-525 (O3): this value is logged so a flip between commit and
   * settlement is greppable, and is NEVER used to decide whether to charge. `null` ⇒ no
   * in-lock observation (the reconcile path, where the commit was hours ago).
   */
  observed: { mandateActiveAtCommit: boolean | null }
): Promise<EndSessionServiceResult> {
  const failed = (status: CreditSettlementStatus): EndSessionServiceResult => ({
    settlementStatus: status,
    overdraftSettledMinor: overdraftMinor,
  });

  // ⚠⚠ THE ASYMMETRY IS DELIBERATE AND PERMANENT (ADR-1040 Amendment 6 §A.1/§C, BAL-535 —
  // SETTLED, not pending): settlement gates on the MANDATE ALONE and must stay that way, on
  // EVERY session — including a `durationSource: 'presence'` session, where grace never opens at
  // all (`settleSessionFromPresence` posts every billable minute directly, with no mandate/mode
  // check of its own). The reason is NOT "grace already vetted this" — that premise is FALSE on
  // the presence path, and a comment that stated it as though it held everywhere was itself part
  // of the gap Amendment 6 closes. The real reason has three parts, independent of whether grace
  // ever opened: (1) the debt is for time an expert ACTUALLY DELIVERED, not exposure Balo chose
  // to take on; (2) the mandate is live consent to exactly this, re-read fresh below, so a
  // revoked mandate still stops the charge; (3) the alternative — gating on the mode — makes the
  // expert deliver a full consultation for nothing, the direct inversion of "expert always gets
  // paid, with no asterisk". On a session where grace DID open (`live_capture` / `external`), the
  // same rule also forecloses a payment-evasion window: a client who switches to "Just notify me"
  // mid-grace is still charged for time already consumed under consent that was live when it
  // accrued.
  //
  // ⚠ BAL-525: the mandate is now re-read on settlement's OWN fresh wallet row, not inherited
  // from the committed terminal transaction — a stale `true` no longer authorizes a charge. The
  // instrument is resolved through the session's pin (evidence and preference, never authority —
  // ADR-1040 Amendment 5; PERMANENTLY so per Amendment 6 §E).
  const wallet = await creditWalletsRepository.findById(session.walletId);
  // ⚠ THE TWO NULL CHECKS BELOW ARE DELIBERATE, NOT REDUNDANT WITH `isWalletMandateActive`. That
  // predicate already implies both ids are non-null when it returns `true` (`settlement.ts`'s
  // docblock), but it returns a plain `boolean`, not a type guard — TypeScript cannot narrow
  // `wallet.stripeCustomerId` / `wallet.stripePaymentMethodId` from it alone. Removing these two
  // checks as an "obvious" simplification breaks the build below, where both are read as
  // non-nullable (`resolveSettlementInstrument`'s `live` field, `createOffSessionCharge`'s args).
  if (
    wallet === undefined ||
    !isWalletMandateActive(wallet) ||
    wallet.stripeCustomerId === null ||
    wallet.stripePaymentMethodId === null
  ) {
    log.warn(
      {
        op: 'settleOverdraft',
        sessionId: session.id,
        walletId: session.walletId,
        overdraftMinor,
        mandateActiveAtCommit: observed.mandateActiveAtCommit,
        mandateActiveNow: false,
      },
      SETTLEMENT_NO_USABLE_MANDATE_MSG
    );
    await openReceivableAndDun(session, overdraftMinor, 'declined', null);
    return failed('failed');
  }

  // BAL-525 (Qodo follow-up) — the MIRROR of the warn above. The wallet had NO usable mandate at
  // commit time (e.g. grace opened under `notify_only`, or the SetupIntent was still `pending`
  // when `end()`/`settleFromPresence()` ran) but the fresh read here — the one this PR added —
  // now finds a live one, so settlement proceeds to charge. That is a real behavioural change
  // this PR introduces (previously a commit-time-false mandate meant the debt could never be
  // charged), so it needs its own greppable, stable line. It is DELIBERATELY un-alerted — no Axiom
  // monitor keys on it (a dashboard count is optional): `info`, not `warn`, because this is the
  // expected-and-correct outcome of re-reading consent live (O3's whole point), not an anomaly an
  // operator needs to act on. BAL-545 exports it as `SETTLEMENT_MANDATE_REVIVED_MSG` so its
  // wording can be pinned verbatim alongside the two monitored lines.
  if (observed.mandateActiveAtCommit === false) {
    log.info(
      {
        op: 'settleOverdraft',
        sessionId: session.id,
        walletId: session.walletId,
        overdraftMinor,
        mandateActiveAtCommit: observed.mandateActiveAtCommit,
        mandateActiveNow: true,
      },
      SETTLEMENT_MANDATE_REVIVED_MSG
    );
  }

  // BAL-525 (O2) — resolve the settlement instrument. By construction the pair actually charged
  // below is ALWAYS the wallet's LIVE pair in this slice: the absent-pin and disagree branches of
  // `resolveSettlementInstrument` return `live` directly, and the agree branch returns a
  // value-identical pair. The pin only selects the `source` label (for the log line below) and
  // arms the disagreement warn — it never redirects a charge away from the live pair. **That is
  // now permanent (ADR-1040 Amendment 6 §E, BAL-535), not pending a ruling** — see
  // `resolveSettlementInstrument`'s docblock and the invariant suite's anti-collapse assertions.
  const instrument = resolveSettlementInstrument({
    pinned: {
      customerId: session.settlementStripeCustomerId,
      paymentMethodId: session.settlementStripePaymentMethodId,
    },
    live: { customerId: wallet.stripeCustomerId, paymentMethodId: wallet.stripePaymentMethodId },
  });

  if (instrument.pinDisagrees) {
    // The detection surface (O2) — the first alarm this class of event has ever had.
    log.warn(
      {
        op: 'settleOverdraft',
        sessionId: session.id,
        walletId: session.walletId,
        overdraftMinor,
        pinnedCustomerId: session.settlementStripeCustomerId,
        pinnedPaymentMethodId: session.settlementStripePaymentMethodId,
        liveCustomerId: wallet.stripeCustomerId,
        livePaymentMethodId: wallet.stripePaymentMethodId,
        pinnedAt: session.settlementInstrumentPinnedAt,
        mandateActiveAtCommit: observed.mandateActiveAtCommit,
      },
      SETTLEMENT_PIN_DISAGREES_MSG
    );
  }

  try {
    const result = await createOffSessionCharge({
      reason: 'overdraft_settlement',
      walletId: session.walletId,
      customerId: instrument.customerId,
      paymentMethodId: instrument.paymentMethodId,
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
        {
          sessionId: session.id,
          paymentIntentId: result.paymentIntentId,
          overdraftMinor,
          instrumentSource: instrument.source,
        },
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
 * BAL-412 — THE SHARED POST-COMMIT TAIL (module docblock's steps 2b/3a/3b). Everything AFTER
 * the session's terminal money row is written: finalize the billing side-effects EXACTLY ONCE
 * (payout obligation + member receipt + expert payout notice + analytics), then either publish
 * the in-credit settled receipt + best-effort auto-top-up trigger, or settle a positive terminal
 * overdraft off-session. Called by BOTH `endSessionAsSystem` (below) and
 * `settleSessionFromPresence` (`./settle-from-presence.ts`) — see the module docblock for why
 * this is ONE implementation rather than two.
 *
 * ⚠ Takes the ALREADY-COMMITTED `session` + its terminal `overdraftMinor` / `mandateActiveAtCommit`
 * — it does NO money arithmetic of its own and writes NO further row beyond what
 * `finalizeBilling` / `settleOverdraft` already do.
 *
 * ⚠ BAL-525: `mandateActiveAtCommit` is OBSERVATION ONLY past this point — it is threaded into
 * `settleOverdraft` purely so a flip between commit and settlement is greppable in the logs.
 * `settleOverdraft` re-verifies the mandate itself on its own fresh wallet read and never trusts
 * this value to decide whether to charge.
 */
export async function finalizeAndSettle(
  session: CreditSession,
  overdraftMinor: number,
  mandateActiveAtCommit: boolean,
  finalizationPath: CreditFinalizationPath,
  now: Date
): Promise<EndSessionServiceResult> {
  // 2b. BAL-399 — finalize the billing side-effects EXACTLY ONCE (payout obligation + member
  //     receipt + expert payout notice + analytics), BEFORE the settle branch so it fires for
  //     in-credit AND overdraft(processing) alike (expert-always-paid ⇒ payout booked at accrual
  //     finalization, independent of the async card outcome). The payout-record UNIQUE dedups.
  await finalizeBilling(session, finalizationPath, now);

  // 3a. In credit — nothing to charge; publish the settled receipt.
  if (overdraftMinor === 0) {
    // BAL-412 (D7) — thread `settlementShape` when this session was presence-settled, so the
    // billing-admin receipt's analytics carry it under its OWN key (never `outcome`).
    await publishSessionSettled(
      toSettleableSession(session),
      now,
      session.settlementShape ?? undefined
    );
    log.info(
      { sessionId: session.id, expertAccruedMinor: session.expertAccruedMinor },
      'Session ended — settled (no charge)'
    );
    // BAL-379: the resting balance just finalized (possibly below the auto-top-up threshold) —
    // consider a between-session reload. Best-effort + POST-COMMIT (the caller already
    // committed): the wrapper never throws, so a trigger fault can never break the settlement
    // return, and the engine re-reads everything under its OWN wallet lock (this site only
    // pokes it with walletId).
    await triggerAutoTopupBestEffort(session.walletId, {
      op: 'finalizeAndSettle',
      sessionId: session.id,
      reason: 'auto_topup_trigger',
    });
    return { settlementStatus: 'not_required', overdraftSettledMinor: 0 };
  }

  // 3b. Overdraft — settle off-session against the company mandate.
  return settleOverdraft(session, overdraftMinor, { mandateActiveAtCommit });
}

/**
 * SYSTEM settlement core (§7): final meter → repo `end` → settle. It performs NO actor
 * authorization — the only callers are the trusted reaper (auto-end of wrapped-idle /
 * max-duration sessions, which acts as the system, not as an actor) and the authorized
 * `endSession` wrapper below. NEVER call this from a route; a route MUST go through `endSession`.
 *
 * ⚠ ONLY for `live_capture` / `external` sessions — a `presence` session's terminal path is
 * `settleSessionFromPresence` (`./settle-from-presence.ts`), never this. Nothing on main routes
 * a `presence` session here (D10).
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
  const { session, overdraftMinor, mandateActive, alreadyEnded } = ended;

  if (alreadyEnded) {
    // BAL-399 durability: a crash (or a finalizeBilling throw) between the end() commit and the
    // payout booking strands a finalized session with NO obligation (the accrual is safe on the
    // row, but the disbursement-layer record BAL-202/203 reads is missing, and the reaper covers
    // only `processing` overdraft sessions — external sessions are excluded). The retry lands here.
    // Replay finalizeBilling — idempotent via the payout `created` guard (created=false → no-op).
    // ONLY for sessions finalized under BAL-399 semantics (billingFinalizedAt stamped — a legacy
    // pre-deploy ended session has it NULL and must NOT get a late payout/receipt); use the
    // PERSISTED finalizationPath, not the incoming param.
    if (session.billingFinalizedAt !== null) {
      await finalizeBilling(session, session.finalizationPath ?? finalizationPath, now);
    }
    return {
      settlementStatus: session.settlementStatus,
      overdraftSettledMinor: session.overdraftSettledMinor ?? 0,
    };
  }

  return finalizeAndSettle(session, overdraftMinor, mandateActive, finalizationPath, now);
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

  // BAL-466 (F1, review fix round) — a `'presence'` session's terminal path is
  // `settleSessionFromPresence` (`./settle-from-presence.ts`), driven by meeting end / the
  // lifecycle sweeps, never this ACTOR-facing route. Every SYSTEM path was taught to skip
  // presence sessions (`enforceMaxDuration`, `findWrappedIdle`/`findStalePending` exclude them);
  // this one never was, because until this PR no presence session existed. Its only gate is
  // CONSUME_CREDITS — any live company member — so an unguarded actor-end would let anyone on
  // the paying company freeze the expert's accrual at wall-clock minutes and skip the ADR-1044
  // floor and the whole presence settlement (`already_settled` at meeting end): a live payment
  // manipulation, not a settlement-timing quirk.
  if (auth.session.durationSource === 'presence') {
    log.warn(
      { sessionId, userId: endedByMemberId },
      'Session actor denied — presence-sourced session is ended by the system only'
    );
    return { ok: false, code: 'forbidden' };
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

/**
 * Settle a session whose settlement PI this reconcile has ALREADY PROVEN `succeeded` — the exact
 * moment the system is about to erase the debt evidence, and therefore the one place the credit
 * must be verified rather than assumed.
 *
 * ⚠⚠ THE BUG THIS SHAPE EXISTS TO CLOSE. This used to mark `settled` and clear the receivable
 * unconditionally, DEFERRING the ledger credit to the `payment_intent.succeeded` webhook. That
 * deferral is only sound if a failed webhook is retried — and a webhook can permanently fail
 * while still returning HTTP 200, in which case Stripe never redelivers. The row then reads
 * `settled` (and `settlement_status` is on the CLIENT allow-list — `credit-views.ts`), dunning
 * stops, the receivable is GONE, and NO ledger row exists for money Stripe actually took. The
 * debt is unrecoverable from the database alone.
 *
 * ⚠ AND THE CLEAR WAS IRREVERSIBLE. `creditReceivablesRepository.open`'s conflict fallback and
 * the partial unique behind it are STATUS-BLIND, so a cleared row permanently occupies the
 * one-per-session slot: every later `open` returns `created:false` ⇒ dunning can never fire for
 * that session again.
 *
 * So the clear is now conditional on the money actually being in the ledger:
 *
 *  · **Ledger row present** — the webhook already credited. Keep the historical idempotent
 *    mark + clear (both are last-writer-wins no-ops on a row the webhook already marked).
 *  · **Ledger row absent** — the REPAIR ARM. Hand the proven-succeeded PI to
 *    `applyOverdraftSettlementFromStripe`, which applies the credit through the ordinary webhook
 *    pipeline; `applyCredit` → `markSettlementSettled` then does the mark + clear IN THE SAME
 *    TRANSACTION AS THE LEDGER WRITE. The clear can no longer outrun the credit, because they
 *    commit together or not at all.
 *
 * ⚠ THIS IS NOT AN ALARM AND CANNOT CRY WOLF. At the 10-minute stuck cutoff a still-in-flight
 * webhook is a RACE, not a fault — and the ledger idempotency key settles it: whoever takes the
 * wallet lock first writes, the other dedups. No double credit either way.
 *
 * ⚠ NO CHARGE HAPPENS ON EITHER ARM. `retrieveSettlement` (inside the repair arm) is read-only;
 * the only charge site in this module is `settleOverdraft`, which this function never reaches.
 *
 * ⚠ THE RE-CHARGE PROTECTION IS `markSettlementResult('settled')`, NOT THE CLEAR — correcting a
 * comment that stood here and mis-attributed it. `findStuckSettling` keys ONLY on
 * `settlement_status='processing'` and never references `credit_receivables`; `reconcileStuckSettlement`'s
 * own `settlementStatus !== 'processing'` early return is the second, independent guard. The
 * receivable contributes ZERO to re-charge safety, which is precisely why making its clear
 * conditional costs nothing.
 */
async function markSettledFromReconcile(
  session: CreditSession,
  paymentIntentId: string
): Promise<void> {
  // The one key three places agree on: the Stripe idempotency key on the original charge
  // (`settlementIdempotencyKey`), the webhook's `ledgerKeyForCredit`, and this lookup.
  const ledgerKey = deriveIdempotencyKey({
    reason: 'overdraft_settlement',
    sessionId: session.id,
  });
  const existingCredit = await creditLedgerRepository.findByIdempotencyKey(ledgerKey);

  if (existingCredit === undefined) {
    // REPAIR ARM — the credit never landed. Apply it (mark + clear ride the same txn inside).
    // A throw BEFORE that txn commits leaves the row `processing` with its receivable intact and
    // propagates to the sweep's per-row catch, which retries next tick — nothing is erased ahead
    // of the money. A throw from a POST-commit publish loses the receipt only, exactly as it
    // would on the webhook path (see `applyOverdraftSettlementFromStripe`'s docblock).
    await applyOverdraftSettlementFromStripe(session, paymentIntentId);
    log.warn(
      {
        sessionId: session.id,
        stripePaymentIntentId: paymentIntentId,
        appliedByReconcile: true,
      },
      'Reconcile: settlement PI succeeded but NO overdraft_settlement ledger credit existed — applied the credit here (the webhook never landed); mark + clear committed with it'
    );
    return;
  }

  // The webhook already credited — the mark + clear are idempotent re-statements of what it did.
  await db.transaction(async (tx) => {
    await creditSessionsRepository.markSettlementResult(tx, {
      sessionId: session.id,
      status: 'settled',
      stripePaymentIntentId: paymentIntentId,
    });
    await creditReceivablesRepository.clear({ sessionId: session.id }, tx);
  });
  // The receipt + analytics stayed with the webhook that applied this credit (it publishes once,
  // deduped-gated) — re-publishing here would double-send it.
  log.info(
    { sessionId: session.id, stripePaymentIntentId: paymentIntentId, ledgerKey },
    'Reconcile: settlement PI already succeeded AND the ledger credit exists — marked settled + cleared any receivable'
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
 * and short-circuit (succeeded → `markSettledFromReconcile`, which VERIFIES the ledger credit
 * exists and applies it first when it does not; canceled / hard-declined → fail + receivable
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
  // BAL-525 — `settleOverdraft` reads the wallet and re-verifies the mandate itself. There is no
  // in-lock observation to pass here: this session committed up to
  // SETTLEMENT_RECONCILE_MAX_AGE_MINUTES ago.
  await settleOverdraft(session, overdraftMinor, { mandateActiveAtCommit: null });
  log.info(
    { sessionId: session.id, overdraftMinor },
    'Reconciled stuck settlement (re-charged within window)'
  );
}
