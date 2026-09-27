/**
 * BAL-378 (ADR-1040 Lane 2) — the SINGLE-AUTHORITY publish + analytics path for in-session
 * drawdown / settlement events. Called by the meter driver (transition notices), `endSession`
 * (settlement outcomes), the settlement webhook (`dispatch.ts`), and the nudge route.
 *
 * Feature code NEVER sends email/SMS directly (notification-engine contract) — it publishes a
 * domain event via `notificationEvents.publish`. Server analytics fire via `trackServer`
 * (`distinct_id = companyId`). Defined here ONCE so the payload/analytics shapes never drift
 * across the meter driver, `endSession`, and the webhook (Sonar new-code duplication gate).
 */
import {
  acquireWalletLock,
  creditReceivablesRepository,
  db,
  expertsRepository,
  usersRepository,
  meetingsRepository,
  meetingPresenceRepository,
  partyMembershipsRepository,
  type CreditSession,
  // BAL-412 (F17) — the four settlement shapes come from the pgEnum's own derived type, never
  // re-spelled inline (CLAUDE.md's repeated-string-union rule). This file already imports from
  // `@balo/db`, so it costs no new dependency.
  type CreditSettlementShape,
} from '@balo/db';
import { trackServer, SESSION_SERVER_EVENTS } from '@balo/analytics/server';
import * as Sentry from '@sentry/node';
import { CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import {
  minutesOfRunway,
  type DebtCoveringCreditReason,
  type HoldStatus,
  type SettleableSession,
} from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';
import { notificationEvents } from '../../notifications/publisher.js';
import { resolveBillingFloorMinutes } from '../../config/billing-floor.js';
import {
  clearCoveredHold,
  type CoverageHealResult,
  type CoverageHealTrigger,
} from '../credit/receivable-coverage.js';
import { ceilingRoomMinor, graceRemainingMinutes, overdraftMagnitude } from './settlement.js';

const log = createLogger('credit-session');

/** Active transaction handle — the type `acquireWalletLock` and the repositories' `exec` take. */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * BAL-378 / BAL-474 — re-remind a wallet on hold at most once per this window (< 24h so the daily
 * 09:00 tick always fires). It lives HERE, beside the claim that enforces it, and the daily sweep
 * imports it — a service never imports from `jobs/`.
 */
export const DUNNING_CADENCE_HOURS = 20;

export type { SettleableSession };

/** Long UTC date for the settled receipt copy (matches the credit-email date convention). */
function formatSettledOn(now: Date): string {
  return now.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Resolve the expert's display name (best-effort — degrades to 'your expert'). */
async function resolveExpertName(expertProfileId: string): Promise<string> {
  const profile = await expertsRepository.findProfileById(expertProfileId);
  if (profile === undefined) {
    return 'your expert';
  }
  const user = await usersRepository.findById(profile.userId);
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : 'your expert';
}

/**
 * BAL-474 (ADR-1040 Amendment 7 §C.3, D5.7) — MAY A BOOKER-ADDRESSED NOTICE STILL GO TO THIS
 * SESSION'S `initiatingMemberId`?
 *
 * A member's own admission (`openedBy === 'client'`) always may: they are the person in the call,
 * and the open re-checked their `CONSUME_CREDITS` moments ago. A `guest` / `system` session is
 * opened ON BEHALF of the booker, who is attribution only (D4) and may have LEFT the company since
 * they booked — so a notice carrying company billing data (balances, receipts) is addressed to
 * them only while they are still a live member of the billing company. `PARTICIPATE` is the base
 * member capability every company role holds, so "still a member" is the whole test. ONE helper for
 * every booker-addressed publisher, so the five cannot disagree.
 */
async function bookerMayBeAddressed(
  session: Pick<CreditSession, 'id' | 'companyId' | 'initiatingMemberId' | 'openedBy'>,
  notice: string
): Promise<boolean> {
  if (session.openedBy === 'client') {
    return true;
  }
  const role = await partyMembershipsRepository.getMemberRole(
    'company',
    session.companyId,
    session.initiatingMemberId
  );
  const may = role !== undefined && roleHasCapability(role, CAPABILITIES.PARTICIPATE);
  if (!may) {
    log.info(
      { sessionId: session.id, openedBy: session.openedBy, notice },
      'Booker-addressed notice skipped — the booker of an on-behalf session is no longer a member of the billing company'
    );
  }
  return may;
}

/** Low-runway warning (self, in-app). One-shot per session. */
export async function publishLowBalance(
  session: CreditSession,
  balanceMinor: number
): Promise<void> {
  if (!(await bookerMayBeAddressed(session, 'session.low_balance'))) {
    return;
  }
  // BAL-412 (D6) — the CORRECTED runway formula: `resolveBillingFloorMinutes()` reads the
  // SAME env-overridable floor the settlement layer snapshots, and `connectedMinutes` is what
  // the balance has already been drawn down by (drawn, not elapsed — see `runway.ts`).
  await notificationEvents.publish('session.low_balance', {
    correlationId: `${session.id}:low_balance`,
    sessionId: session.id,
    userId: session.initiatingMemberId,
    companyId: session.companyId,
    minutesRemaining: minutesOfRunway({
      balanceMinor,
      ratePerMinuteMinor: session.clientRateMinorPerMinute,
      floorMinutes: resolveBillingFloorMinutes(),
      minutesAlreadyDrawn: session.connectedMinutes,
    }),
    balanceMinor,
    ratePerMinuteMinor: session.clientRateMinorPerMinute,
  });
}

/** Entered card-backed grace (self in-app + SMS; admin ping) + GRACE_ENTERED analytics. */
export async function publishGraceEntered(
  session: CreditSession,
  balanceMinor: number,
  now: Date
): Promise<void> {
  const ceilingRoom = ceilingRoomMinor(session, balanceMinor);
  // BAL-474 (D5.7) — a departed booker of an on-behalf session drops out of the SELF arm only; the
  // billing-admin ping still goes out, so the payload simply omits `userId`.
  const bookerMay = await bookerMayBeAddressed(session, 'session.grace_entered');
  await notificationEvents.publish('session.grace_entered', {
    correlationId: `${session.id}:grace_entered`,
    sessionId: session.id,
    ...(bookerMay ? { userId: session.initiatingMemberId } : {}),
    companyId: session.companyId,
    graceRemainingMinutes: graceRemainingMinutes(session, now),
    ceilingRoomMinor: ceilingRoom,
  });
  trackServer(SESSION_SERVER_EVENTS.GRACE_ENTERED, {
    session_id: session.id,
    company_id: session.companyId,
    wallet_id: session.walletId,
    ceiling_room_minor: ceilingRoom,
    distinct_id: session.companyId,
  });
}

/** Approaching the wrap (self, in-app + SMS). One-shot per session. */
export async function publishNearWrap(session: CreditSession, now: Date): Promise<void> {
  if (!(await bookerMayBeAddressed(session, 'session.near_wrap'))) {
    return;
  }
  await notificationEvents.publish('session.near_wrap', {
    correlationId: `${session.id}:near_wrap`,
    sessionId: session.id,
    userId: session.initiatingMemberId,
    companyId: session.companyId,
    graceRemainingMinutes: graceRemainingMinutes(session, now),
  });
}

/** The wrap was caused by the overdraft ceiling — GRACE_CEILING_HIT analytics (no notice). */
export function trackCeilingHit(session: CreditSession, balanceMinor: number): void {
  trackServer(SESSION_SERVER_EVENTS.GRACE_CEILING_HIT, {
    session_id: session.id,
    company_id: session.companyId,
    wallet_id: session.walletId,
    overdraft_minor: overdraftMagnitude(balanceMinor),
    distinct_id: session.companyId,
  });
}

/**
 * Settled (in-credit at end OR the overdraft charge succeeded) — billing-admin receipt.
 *
 * ⚠ `settlementShape` is BAL-412's OPTIONAL third argument (D7) — present only when the caller
 * settled from presence. It feeds ONLY the analytics `settlement_outcome` key, a SEPARATE key
 * from `outcome` above (the PAYMENT outcome, unchanged) — the two must never be confused.
 */
export async function publishSessionSettled(
  session: SettleableSession,
  now: Date,
  settlementShape?: CreditSettlementShape
): Promise<void> {
  const overdraft = session.overdraftSettledMinor ?? 0;
  const expertName = await resolveExpertName(session.expertProfileId);
  await notificationEvents.publish('session.settled', {
    correlationId: `${session.id}:settled`,
    sessionId: session.id,
    companyId: session.companyId,
    walletId: session.walletId,
    overdraftSettledMinor: overdraft,
    expertName,
    settledOn: formatSettledOn(now),
  });
  trackServer(SESSION_SERVER_EVENTS.SESSION_SETTLED, {
    session_id: session.id,
    company_id: session.companyId,
    outcome: 'success',
    overdraft_settled_minor: overdraft,
    opened_by: session.openedBy,
    distinct_id: session.companyId,
    ...(settlementShape === undefined ? {} : { settlement_outcome: settlementShape }),
  });
}

/** Why a hold-dunning notice is being considered (`HoldStatus` is read fresh either way). */
export type HoldDunningTrigger = 'receivable_opened' | 'daily_reminder';

/**
 * What {@link claimHoldDunningNotice} decided, all under ONE wallet-locked snapshot.
 *
 *   `not_on_hold`      — no open receivable: nothing to say (the hold cleared since the sweep listed it).
 *   `healed`           — on hold but the balance already covers it: the covered-but-held state. The
 *                        claim HEALS it (an audited system clear) instead of warning about it.
 *   `already_reminded` — the daily arm only: another sweep reminded this wallet inside the cadence.
 *   `claimed`          — publish this: the figure was read and (on the daily arm) stamped together.
 */
export type HoldDunningClaim =
  | { readonly kind: 'not_on_hold' }
  | { readonly kind: 'healed'; readonly healed: CoverageHealResult }
  | { readonly kind: 'already_reminded' }
  | { readonly kind: 'claimed'; readonly status: HoldStatus };

/**
 * The ONE caller of {@link clearCoveredHold} in this file — the dunning claim and the booking
 * guard's `healCoveredHoldNow` both come through it, so "heal a covered hold" has one definition
 * and the account-hold invariant's count of hold-releasing call sites stays exact.
 */
async function healInTx(
  tx: DbTx,
  input: {
    walletId: string;
    status: HoldStatus;
    trigger: CoverageHealTrigger;
    now: Date;
  }
): Promise<CoverageHealResult> {
  return clearCoveredHold(tx, {
    walletId: input.walletId,
    balanceMinor: input.status.balanceMinor,
    trigger: input.trigger,
    now: input.now,
  });
}

/**
 * Post-commit "account clear" notice for a heal, keyed on the FIRST cleared receivable id (D8.4).
 * A receivable clears exactly once, so the id is unique per write; a per-wallet key would be
 * deduplicated by BullMQ against a retained job and silence every later heal on the wallet. A
 * heal that cleared nothing announces nothing.
 */
async function publishHealedNotice(walletId: string, healed: CoverageHealResult): Promise<void> {
  const [operationId] = healed.clearedIds;
  if (operationId === undefined || healed.companyId === undefined) {
    return;
  }
  await publishReceivableCleared({
    operationId,
    companyId: healed.companyId,
    walletId,
    receivableCount: healed.clearedIds.length,
    clearedMinor: healed.clearedMinor,
    balanceAfterMinor: healed.balanceMinor,
    clearedBy: 'coverage_heal',
  });
}

/**
 * BAL-474 (ADR-1040 Amendment 7 §G.2, D7.1, D7.2) — CLAIM A HOLD-DUNNING NOTICE under the wallet
 * advisory lock, in ONE transaction: read the top-up figure from one consistent snapshot, decide
 * whether it may be sent, and (on the daily arm) stamp the cadence — then let the CALLER publish
 * post-commit. Two sweeps racing on one wallet therefore cannot both quote a figure, and the figure
 * a client is told is never torn against a top-up that committed between two reads.
 *
 * The wallet lock is the FIRST statement (every credit writer takes it first). The figure comes
 * from `readHoldStatus` — the one reader — and is never re-derived here.
 *
 * ⚠ A covered-but-held wallet (`amountToClearMinor === 0`) is HEALED here, not warned about: a
 * notice would have to quote A$0.00, and the hold is the thing that is wrong.
 *
 * ⚠ ONLY THE DAILY ARM STAMPS (D7.1). A `receivable_opened` notice is never throttled — a new debt
 * always deserves a fresh notice with the new total — and it never writes `last_dunning_at`, so an
 * off-cycle notice can never push the next daily reminder back.
 */
export async function claimHoldDunningNotice(input: {
  walletId: string;
  trigger: HoldDunningTrigger;
  now: Date;
}): Promise<HoldDunningClaim> {
  const { walletId, trigger, now } = input;
  return db.transaction(async (tx): Promise<HoldDunningClaim> => {
    await acquireWalletLock(tx, walletId);
    const status = await creditReceivablesRepository.readHoldStatus({ walletId }, tx);
    if (!status.onHold) {
      return { kind: 'not_on_hold' };
    }
    if (status.amountToClearMinor === 0) {
      return {
        kind: 'healed',
        healed: await healInTx(tx, { walletId, status, trigger: 'dunning_claim', now }),
      };
    }
    if (trigger === 'daily_reminder') {
      const last = await creditReceivablesRepository.lastDailyDunningAt(walletId, tx);
      if (
        last !== undefined &&
        last.getTime() > now.getTime() - DUNNING_CADENCE_HOURS * MS_PER_HOUR
      ) {
        return { kind: 'already_reminded' };
      }
      await creditReceivablesRepository.stampDailyDunning(walletId, now, tx);
    }
    return { kind: 'claimed', status };
  });
}

/**
 * BAL-474 — heal a covered-but-held wallet at BOOKING time (D8.1): the booking API guard calls this
 * when the funding verdict is `covered_hold`, so no client ever sees a hold that owes nothing.
 * Same lock, same snapshot reader, same `healInTx` as the dunning claim — one heal, two entry
 * points. Returns `{ healed: true }` only when it actually cleared receivables; the cleared notice
 * is published post-commit. A throw propagates: the guard treats it as a failed heal.
 */
export async function healCoveredHoldNow(input: {
  walletId: string;
  trigger: 'booking_guard';
  now: Date;
}): Promise<{ healed: boolean }> {
  const { walletId, trigger, now } = input;
  const healed = await db.transaction(async (tx) => {
    await acquireWalletLock(tx, walletId);
    const status = await creditReceivablesRepository.readHoldStatus({ walletId }, tx);
    if (!status.onHold || status.amountToClearMinor !== 0) {
      return undefined;
    }
    return healInTx(tx, { walletId, status, trigger, now });
  });
  if (healed === undefined || healed.clearedIds.length === 0) {
    return { healed: false };
  }
  await publishHealedNotice(walletId, healed);
  return { healed: true };
}

/** What {@link publishHoldDunningNotice} did — so a sweep counts only the notices it really sent. */
export type HoldDunningOutcome =
  | 'not_on_hold'
  | 'already_reminded'
  | 'healed'
  | 'published'
  | 'publish_failed';

/**
 * BAL-474 (ADR-1040 Amendment 7 §G.2) — publish ONE wallet-grain dunning notice stating the top-up
 * that clears the hold (D6.2: "neutral about number of over-runs but state the total amount
 * needed"). The notice is CLAIMED first ({@link claimHoldDunningNotice}: figure + daily stamp under
 * the wallet lock, one transaction) and published post-commit, so the publish never sits inside a
 * database transaction.
 *
 * `correlationKey` is per WRITE — the receivable id on `receivable_opened`, `{walletId}:{epochMs}` on
 * `daily_reminder` — so BullMQ's jobId dedup never swallows a genuinely new notice.
 *
 * A publish failure is logged (`error` + Sentry) and NOT thrown: the daily stamp stays, so a lost
 * reminder is delayed by one cadence rather than retried in a loop, and a lost `receivable_opened`
 * notice is picked up by the next daily claim (an unstamped wallet is due at once).
 */
export async function publishHoldDunningNotice(input: {
  walletId: string;
  companyId: string;
  trigger: HoldDunningTrigger;
  correlationKey: string;
  now: Date;
}): Promise<HoldDunningOutcome> {
  const { walletId, companyId, trigger, correlationKey, now } = input;
  const claim = await claimHoldDunningNotice({ walletId, trigger, now });
  const fields = { walletId, companyId, trigger };

  if (claim.kind === 'not_on_hold') {
    log.info(fields, 'Hold dunning skipped — the wallet is no longer on hold');
    return 'not_on_hold';
  }
  if (claim.kind === 'already_reminded') {
    log.info(
      fields,
      'Hold dunning skipped — another sweep already reminded this wallet inside the cadence'
    );
    return 'already_reminded';
  }
  try {
    if (claim.kind === 'healed') {
      log.info(
        { ...fields, clearedCount: claim.healed.clearedIds.length },
        'Hold dunning replaced by a heal — the balance already covered the debt'
      );
      await publishHealedNotice(walletId, claim.healed);
      return 'healed';
    }
    await notificationEvents.publish('session.settlement_failed', {
      correlationId: `hold_dunning:${correlationKey}`,
      companyId,
      walletId,
      topUpNeededMinor: claim.status.amountToClearMinor,
      promoGrantedSinceDebtMinor: claim.status.promoGrantedSinceDebtMinor,
      confirmationWasRequested: claim.status.confirmationWasRequested,
      asOfIso: now.toISOString(),
      trigger,
    });
    log.info(
      { ...fields, topUpNeededMinor: claim.status.amountToClearMinor },
      'Hold dunning notice published'
    );
    return 'published';
  } catch (error: unknown) {
    log.error(
      {
        ...fields,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Failed to publish the hold dunning notice (the claim stands; the next daily reminder retries)'
    );
    Sentry.captureException(error, { extra: fields });
    return 'publish_failed';
  }
}

/**
 * A settlement could not complete (hard decline / SCA / async fail) and a receivable opened — the
 * PER-SESSION analytics (`SESSION_SETTLED{outcome}` + `RECEIVABLE_OPENED`), then the wallet-grain
 * dunning notice (post-commit; the receivable itself is opened by the caller in its own txn).
 *
 * ⚠ BAL-474 (D7.1) — NEVER THROTTLED. Every new receivable produces a fresh notice with the new
 * total, at once. Its callers are the two receivable-opening paths only (`end-session.ts`'s
 * `openReceivableAndDun` and `dispatch.ts`'s `handleOverdraftChargeFailed`); the daily reminder
 * no longer calls it, so these two analytics now count distinct failures and opens.
 *
 * The analytics fire BEFORE the notice, outside its claim: a database fault in the claim must not
 * lose the metric.
 */
export async function publishSettlementFailure(input: {
  /** `openedBy` labels the analytics; the rest identify the wallet the notice is about. */
  session: Pick<SettleableSession, 'id' | 'companyId' | 'walletId' | 'openedBy'>;
  reason: 'declined' | 'requires_action';
  amountMinor: number;
  /** The receivable that just opened — the notice's per-write identity. */
  receivableId: string;
  now: Date;
}): Promise<void> {
  const { session, reason, amountMinor, receivableId, now } = input;
  trackServer(SESSION_SERVER_EVENTS.SESSION_SETTLED, {
    session_id: session.id,
    company_id: session.companyId,
    outcome: reason === 'requires_action' ? 'requires_action' : 'fail',
    overdraft_settled_minor: amountMinor,
    opened_by: session.openedBy,
    distinct_id: session.companyId,
  });
  trackServer(SESSION_SERVER_EVENTS.RECEIVABLE_OPENED, {
    session_id: session.id,
    company_id: session.companyId,
    amount_minor: amountMinor,
    reason: reason === 'requires_action' ? 'settlement_requires_action' : 'settlement_declined',
    distinct_id: session.companyId,
  });
  await publishHoldDunningNotice({
    walletId: session.walletId,
    companyId: session.companyId,
    trigger: 'receivable_opened',
    correlationKey: receivableId,
    now,
  });
}
/**
 * BAL-412 (F16) — the presence-settlement CONTEXT the two ordinary receipts carry, derived ONCE
 * from the already-settled session row.
 *
 * ⚠⚠ IT EXISTS BECAUSE A `no_show_client` RECEIPT IS OTHERWISE INDISTINGUISHABLE FROM AN
 * ORDINARY ONE. Without these fields the client who never joined receives "Your 15-minute
 * session with {expert} came to A$X" — a claim about a call that did not happen — and the expert
 * receives an unremarkable earnings notice with no indication of why. `missed_call` got its own
 * bespoke apologetic event (`session.missed_call`); `no_show_client` is settled through the
 * ORDINARY events, so the context has to travel on them. The templates add ONE factual sentence
 * off `settlementShape` (see `templates/index.ts` / `in-app-templates.ts`).
 *
 * All three are OPTIONAL on the payloads and OMITTED (never `null`) for `live_capture` /
 * `external` and every row written before migration 0071 — so the shipped receipt is unchanged.
 *
 * FEE-SAFE ON BOTH SIDES: a shape LABEL and two DURATIONS, never a second figure. That is what
 * lets one helper serve both the client-lens and expert-lens payload (the alternative — two
 * copies of the same three-field spread — would also trip the new-code duplication gate).
 */
function presenceContext(session: CreditSession): {
  settlementShape?: CreditSettlementShape;
  actualMinutes?: number;
  billingFloorMinutes?: number;
} {
  if (session.settlementShape === null) {
    return {};
  }
  return {
    settlementShape: session.settlementShape,
    ...(session.actualMinutes === null ? {} : { actualMinutes: session.actualMinutes }),
    ...(session.billingFloorMinutes === null
      ? {}
      : { billingFloorMinutes: session.billingFloorMinutes }),
  };
}

/**
 * BAL-399 — the acting member's PERSONAL consultation receipt (recipient 'self', email + in-app).
 * Published once from `finalizeBilling`. Carries the all-in charge (connectedMinutes × client rate)
 * — NO expert rate/accrual/margin (fee concealment). Distinct from the billing-admin
 * `session.settled` fan-out (Owner Decision O1).
 *
 * BAL-412 (F16): also carries the presence-settlement context, so a `no_show_client` receipt can
 * say WHY it is a receipt for a call the client never joined. See {@link presenceContext}.
 */
export async function publishPaymentCharged(session: CreditSession, now: Date): Promise<void> {
  if (!(await bookerMayBeAddressed(session, 'payment.charged'))) {
    return;
  }
  const expertName = await resolveExpertName(session.expertProfileId);
  await notificationEvents.publish('payment.charged', {
    correlationId: `${session.id}:payment_charged`,
    userId: session.initiatingMemberId,
    companyId: session.companyId,
    sessionId: session.id,
    amountAudMinor: session.connectedMinutes * session.clientRateMinorPerMinute,
    durationMinutes: session.connectedMinutes,
    expertName,
    chargedOn: formatSettledOn(now),
    ...presenceContext(session),
  });
}

/**
 * BAL-399 — the delivering expert's own-earnings notice (recipient 'expert', email + in-app).
 * Published once from `finalizeBilling`. Carries the expert's OWN earnings (= expertAccruedMinor)
 * — NO client charge/markup/margin (fee concealment).
 *
 * BAL-412 (F16): also carries the presence-settlement context — the AC's "no-show settled →
 * expert → in-app (accrual confirmation)". See {@link presenceContext}.
 */
export async function publishPayoutRecorded(session: CreditSession, now: Date): Promise<void> {
  await notificationEvents.publish('payout.recorded', {
    correlationId: `${session.id}:payout_recorded`,
    expertProfileId: session.expertProfileId,
    sessionId: session.id,
    amountAudMinor: session.expertAccruedMinor,
    durationMinutes: session.connectedMinutes,
    recordedOn: formatSettledOn(now),
    ...presenceContext(session),
  });
}

/**
 * BAL-412 (ADR-1044 §7, D8) — the expert never joined. TWO recipients on ONE publish: the
 * acting member (recipient 'self', APOLOGETIC) and the delivering expert (recipient 'expert',
 * FACTUAL) — see `SessionMissedCallPayload`'s docblock. Called from `finalizeBilling`, gated on
 * `settlementShape === 'missed_call'`.
 *
 * ⚠ `session.meetingId === null` should be unreachable for a presence-settled session (D11 —
 * `settleFromPresence` always names the meeting it settled from), but this is a best-effort
 * notification path: guard defensively and skip rather than publish a payload missing its
 * `scheduledOn` anchor.
 *
 * ⚠ `_now` IS UNUSED, deliberately kept in the signature for call-site parity with the other
 * `publish*` functions `finalizeBilling` calls uniformly — `scheduledOn` anchors on the
 * MEETING's `scheduledStart` (the call's actual scheduled time), never "now" (when settlement
 * happened, which can be well after the meeting).
 *
 * ⚠ `clientSideEverPresent` is read from the meeting's presence rows here, because the session
 * row cannot answer it (see {@link readClientSideEverPresent}).
 */
export async function publishSessionMissedCall(session: CreditSession, _now: Date): Promise<void> {
  if (session.meetingId === null) {
    log.warn(
      { sessionId: session.id },
      'publishSessionMissedCall — session has no meetingId (unreachable for a presence-settled session) — skipping'
    );
    return;
  }
  const meeting = await meetingsRepository.findById(session.meetingId);
  if (meeting === undefined) {
    log.warn(
      { sessionId: session.id, meetingId: session.meetingId },
      'publishSessionMissedCall — meeting not found — skipping'
    );
    return;
  }
  // BAL-474 (D5.7) — a departed booker of an on-behalf session drops out of the client SELF arm
  // only; the delivering expert is still told, so the payload simply omits `userId`.
  const [expertName, clientSideEverPresent, bookerMay] = await Promise.all([
    resolveExpertName(session.expertProfileId),
    readClientSideEverPresent(session.id, meeting.id),
    bookerMayBeAddressed(session, 'session.missed_call'),
  ]);
  await notificationEvents.publish('session.missed_call', {
    correlationId: `${session.id}:missed_call`,
    sessionId: session.id,
    meetingId: session.meetingId,
    ...(bookerMay ? { userId: session.initiatingMemberId } : {}),
    companyId: session.companyId,
    expertProfileId: session.expertProfileId,
    expertName,
    scheduledOn: formatSettledOn(meeting.scheduledStart),
    clientSideEverPresent,
  });
}

/**
 * Did anybody on the client side ever turn up to the missed call's meeting? A credit session
 * cannot say — it opens when the call page mints a join grant, before any Daily connection — so
 * this reads the presence rows through `factsByMeetingIds`, the same `summarisePresence`
 * reduction settlement ran.
 *
 * ⚠ NEVER THROWS. It runs inside `finalizeBilling`'s best-effort block, where a throw would lose
 * the whole notice (both recipients). A failed read degrades to `null` (unknown), which keeps the
 * copy that names the expert — a client who waited must never be told nobody turned up.
 */
async function readClientSideEverPresent(
  sessionId: string,
  meetingId: string
): Promise<boolean | null> {
  try {
    const facts = await meetingPresenceRepository.factsByMeetingIds([meetingId]);
    return facts.get(meetingId)?.clientSideEverPresent ?? null;
  } catch (err: unknown) {
    log.error(
      {
        op: 'publishSessionMissedCall',
        sessionId,
        meetingId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      'Failed to read meeting presence for the missed-call notice (publishing with presence unknown)'
    );
    return null;
  }
}

/**
 * BAL-535 (ADR-1040 Amendment 6 §F) — a covering CASH credit cleared the company's open
 * receivables, releasing its soft account hold. Publish + analytics defined ONCE here (mirroring
 * `publishSettlementFailure`'s `RECEIVABLE_OPENED` shape) so the payload/analytics shapes for
 * the money-in half of that pairing cannot drift from the money-out half.
 *
 * ⚠ ONE NOTICE PER CLEAR OPERATION, NOT PER ROW (fix round N4). A wallet can hold several open
 * receivables — `credit-receivables.integration.test.ts` proves it — and the previous shape
 * returned one thunk per cleared row, so three rows sent three identical "your account is clear"
 * emails, each quoting the same balance. `correlationId` is therefore keyed on the OPERATION
 * (`receivable_cleared:{operationId}`), one per write.
 *
 * ⚠ BAL-474 (D8.4) — `operationId` IS A PER-WRITE IDENTITY, NEVER A PER-WALLET KEY. On a credit
 * arm (a cash top-up, a settlement charge) it is the LEDGER ENTRY that covered the debt: one per
 * clear operation and itself idempotency-keyed, so a webhook replay collapses onto the same BullMQ
 * jobId. On a heal (no ledger entry) it is the FIRST cleared receivable id — a receivable clears
 * exactly once, so two heals on one wallet get two different ids. A per-wallet key would be
 * deduplicated by BullMQ against a retained job and silence every later heal.
 *
 * ⚠ `balanceAfterMinor` IS THE DISPLAY FIGURE, and it is the caller's job to pass the TRUE final
 * one (M3): on a `manual_purchase` the promo grant lands after the clear's predicate ran, and
 * this email reaches the same MANAGE_BILLING holder as the top-up receipt seconds later. The
 * predicate's own (pre-promo, promo-discounted) figures live on the `audit_events` row instead —
 * different questions, so never one field.
 *
 * Called as a `PostCommitEffect` thunk from the Stripe webhook (`dispatch.ts`), whose post-commit
 * loop has NO surrounding try/catch of its own (unlike `applyStripeEffect`'s txn) — so, mirroring
 * `publishTopupReceipt`'s posture in that same file, this SELF-CATCHES and never re-throws: the
 * money (the clear) is already committed, and re-throwing would make Stripe retry the WHOLE
 * webhook for a notification hiccup.
 *
 * ⚠ THE ANALYTICS FIRE BEFORE — AND OUTSIDE — THE PUBLISH TRY (fix round L1), exactly as
 * `publishTopupReceipt`'s `emitManualPurchaseCredited` does deliberately. Inside it, a queue
 * outage lost the METRIC as well as the email, and its pair `RECEIVABLE_OPENED` sits on a
 * throwing path — so §J's "how many holds clear without ops touching them" would have counted
 * opens reliably and clears short. `trackServer` is a no-op without an API key and `capture`
 * only enqueues, so this cannot itself be what fails.
 */
export async function publishReceivableCleared(input: {
  /** The write's identity: the covering ledger entry, or the first cleared receivable id on a heal. */
  operationId: string;
  companyId: string;
  walletId: string;
  /** How many open receivables this one operation cleared (`>= 1`). */
  receivableCount: number;
  /** Sum of the cleared receivables' recorded amounts (AUD minor) — the consultations' figure. */
  clearedMinor: number;
  /** The TRUE final wallet balance the client will see (AUD minor). */
  balanceAfterMinor: number;
  clearedBy: DebtCoveringCreditReason | 'coverage_heal';
}): Promise<void> {
  const {
    operationId,
    companyId,
    walletId,
    receivableCount,
    clearedMinor,
    balanceAfterMinor,
    clearedBy,
  } = input;
  // ⚠ ITS OWN try, not the publish's. Outside the publish so a queue outage cannot lose the
  // metric (L1); contained so an analytics hiccup cannot escape into the post-commit loop, which
  // has no try/catch of its own and would answer 500 and make Stripe retry a COMMITTED webhook.
  // Exactly `emitManualPurchaseCredited`'s posture in `dispatch.ts`.
  try {
    trackServer(SESSION_SERVER_EVENTS.RECEIVABLE_CLEARED, {
      company_id: companyId,
      wallet_id: walletId,
      receivable_count: receivableCount,
      cleared_minor: clearedMinor,
      balance_after_minor: balanceAfterMinor,
      cleared_by: clearedBy,
      distinct_id: companyId,
    });
  } catch (err: unknown) {
    log.warn(
      {
        op: 'publishReceivableCleared',
        operationId,
        error: err instanceof Error ? err.message : String(err),
        // CLAUDE.md's caught-error rule is message + STACK + ids. `join-meeting.ts` states it
        // outright ("THE STACK IS REQUIRED, NOT OPTIONAL"): without it the original throw site
        // is unrecoverable from the log, which is the whole point of logging at a boundary
        // that swallows.
        stack: err instanceof Error ? err.stack : undefined,
      },
      'Failed to emit receivable_cleared (hold released; analytics best-effort)'
    );
  }
  try {
    await notificationEvents.publish('credit.receivable.cleared', {
      correlationId: `receivable_cleared:${operationId}`,
      companyId,
      walletId,
      receivableCount,
      clearedMinor,
      balanceAfterMinor,
      clearedBy,
    });
  } catch (err: unknown) {
    log.error(
      {
        op: 'publishReceivableCleared',
        operationId,
        companyId,
        walletId,
        receivableCount,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      'Failed to publish credit.receivable.cleared (hold released; notification best-effort)'
    );
  }
}

/** Member nudge asking billing admins to top up (in-app fan-out). Re-notifiable per click. */
export async function publishTopupNudge(
  session: { id: string; companyId: string },
  requestedByUserId: string,
  requestedByName: string,
  nowMs: number
): Promise<void> {
  await notificationEvents.publish('session.topup_nudge', {
    correlationId: `${session.id}:topup_nudge:${nowMs}`,
    sessionId: session.id,
    companyId: session.companyId,
    requestedByUserId,
    requestedByName,
  });
}
