import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OffSessionChargeInput,
  OffSessionChargeResult,
  PostCommitEffect,
  SettlementFields,
  StripeEffect,
} from './types.js';

/**
 * BAL-474 F4b — A SETTLEMENT CREDIT COVERS PRIOR DEBT ONLY AFTER THE SESSION SETTLES FIRST
 * (ADR-1040 Amendment 7 §F, plan §A.5 / AD-8 / D8.3), end to end against a real Postgres.
 *
 * Once a session bills only its OWN share (`min(ownConsumed, max(0, −balance))`), an older
 * receivable routinely coexists with a newer session's `processing` settlement. When that
 * session's `overdraft_settlement` credit lands, three things must hold on the SAME webhook
 * transaction, and only a real database can carry them together:
 *
 *   · the credit is a DEBT-COVERING reason, so it may run the wallet-grain coverage clear (the
 *     clear is audited as a SYSTEM act: `actor_user_id` NULL, the settling session in metadata);
 *   · the session settles — and clears its OWN receivable — BEFORE the wallet-grain clear, so
 *     coverage is judged from the anchor of the debts that REMAIN (WE4(d), the anchor move);
 *   · when the session's own receivable was the last one open, exactly one "account clear"
 *     notice goes out, keyed on the ledger entry (D8.3).
 *
 * ⚠ RED POSTURE (plan §9 F4b). Every case whose fixture needs a SECOND session on a held or
 * negative wallet cannot be built on the pre-BAL-474 tree: the gated `open()` refuses it
 * (`account_hold` / `settlement_pending`), and `openAdmittedSession` throws `expected open ok,
 * got …` there. That is the stated posture — "proof by mutation, not RED on main". The D8.3
 * own-receivable case needs no second session, so it runs to its real assertion on the old tree.
 *
 * ⚠ THIS FILE LIVES IN `apps/api` BUT RUNS FROM `packages/db/vitest.config.integration.ts`,
 * inside the harness's one rolled-back transaction per test (`setup-integration.ts`). Seeding
 * goes through production repositories and `seedBookingParties`, never
 * `packages/db/src/test/factories` (TS6059 on `rootDir`).
 *
 * ⚠ THE ANCHOR DEPENDS ON A HARNESS FACT. Every ledger row's `created_at` is `now()` — the
 * harness transaction's START, which precedes each test body. `earliestOpenDebtAnchor` reads
 * `session.ended_at`, which settlement stamps from the `now` it is handed. So a session settled
 * an hour before that `now()` is anchored BEFORE a promo posted in the test, and one settled
 * five minutes after it is anchored AFTER it. WE4(d) relies on exactly that ordering, so it reads
 * the transaction's own `now()` (`transactionNow`) rather than the host clock; every other
 * instant is derived from `new Date()` at test time. No calendar date is hard-coded.
 *
 * Mocks, and only these: the BullMQ queue (so every notification publish is captured with its
 * real `correlationId` and `buildJobId` stays real) and `createOffSessionCharge` (the one Stripe
 * call on the settlement path). Everything else — the ledger, the coverage predicate, the
 * dispatch arms, the audit rows — is the production code.
 */

interface QueuedJob {
  readonly queue: string;
  readonly name: string;
  readonly data: unknown;
}

const { queued, mockGetQueue, mockCreateOffSessionCharge } = vi.hoisted(() => {
  const jobs: QueuedJob[] = [];
  return {
    queued: jobs,
    mockGetQueue: vi.fn((queue: string) => ({
      add: vi.fn(async (name: string, data: unknown) => {
        jobs.push({ queue, name, data });
        return { id: `job-${String(jobs.length)}` };
      }),
    })),
    mockCreateOffSessionCharge:
      vi.fn<(input: OffSessionChargeInput) => Promise<OffSessionChargeResult>>(),
  };
});

vi.mock('../../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/queue.js')>()),
  getQueue: mockGetQueue,
}));
vi.mock('./charges.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./charges.js')>()),
  createOffSessionCharge: mockCreateOffSessionCharge,
}));

import {
  and,
  auditEvents,
  creditLedgerRepository,
  creditReceivables,
  creditReceivablesRepository,
  creditSessionsRepository,
  creditWallets,
  creditWalletsRepository,
  db,
  deriveIdempotencyKey,
  eq,
  expertProfiles,
  inArray,
  meetingsRepository,
  sql,
  type AuditEvent,
  type CreditReceivable,
  type CreditSession,
} from '@balo/db';
import { deriveSessionEstimate } from '@balo/shared/credit';
import { seedBookingParties } from '../../test/fixtures/booking-graph.js';
import { finalizeAndSettle } from '../credit-session/end-session.js';
import { applyStripeEffect } from './dispatch.js';

// ── The plan's rates (§A.4): client 700/min, expert 500/min, floor 15 ─────────────────────

const MS_PER_MINUTE = 60_000;
/** A$300.00/h raw expert rate. */
const EXPERT_HOURLY_MINOR = 30_000;
/** 40% — with the rate above, `deriveSessionEstimate` yields exactly the plan's 700 / 500. */
const BALO_FEE_BPS = 4_000;
const FLOOR_MINUTES = 15;
const PLAN_RATES = deriveSessionEstimate({
  expertHourlyMinor: EXPERT_HOURLY_MINOR,
  estimatedMinutes: 1,
  baloFeeBps: BALO_FEE_BPS,
});

const CLEARED_BY_CREDIT_ACTION = 'credit_receivable.cleared_by_credit';
const RECEIVABLE_CLEARED_EVENT = 'credit.receivable.cleared';

// ── Fixture ──────────────────────────────────────────────────────────────────

interface Ctx {
  readonly companyId: string;
  readonly memberId: string;
  readonly expertProfileId: string;
  readonly engagementId: string;
  readonly walletId: string;
}

function minutesAfter(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * MS_PER_MINUTE);
}

/** `connectedAt + minutes` plus a 30s cushion, so the meter lands exactly on `minutes` ticks. */
function meterInstant(connectedAt: Date, minutes: number): Date {
  return new Date(connectedAt.getTime() + minutes * MS_PER_MINUTE + 30_000);
}

/**
 * One client company with a live member, an expert at the plan's rate, a live case engagement,
 * and a wallet carrying an ACTIVE mandate (every F4b case charges a card). `lowBalanceMode` is
 * stated at every call site: `keep_going` is the card-backed mode that lets the meter enter
 * grace; `notify_only` wraps at zero.
 */
async function seedMandateWallet(opts: {
  balanceMinor: number;
  lowBalanceMode: 'keep_going' | 'notify_only';
}): Promise<Ctx> {
  const parties = await seedBookingParties();
  await db
    .update(expertProfiles)
    .set({ rateCents: EXPERT_HOURLY_MINOR })
    .where(eq(expertProfiles.id, parties.expertProfileId));
  const [wallet] = await db
    .insert(creditWallets)
    .values({
      companyId: parties.companyId,
      balanceMinor: opts.balanceMinor,
      lowBalanceMode: opts.lowBalanceMode,
      mandateStatus: 'active',
      stripeCustomerId: 'cus_bal474_f4b',
      stripePaymentMethodId: 'pm_bal474_f4b',
    })
    .returning({ id: creditWallets.id });
  if (wallet === undefined) {
    throw new Error('fixture: wallet insert returned no row');
  }
  return {
    companyId: parties.companyId,
    memberId: parties.memberUserId,
    expertProfileId: parties.expertProfileId,
    engagementId: parties.caseEngagementId,
    walletId: wallet.id,
  };
}

/** A `case` meeting on the fixture's engagement — each session bills its own meeting. */
async function bookCaseMeeting(ctx: Ctx, startsAt: Date): Promise<string> {
  const { meeting } = await meetingsRepository.create({
    scheduledStart: startsAt,
    scheduledEnd: minutesAfter(startsAt, 30),
    contexts: [{ contextType: 'case', contextId: ctx.engagementId }],
    actorUserId: ctx.memberId,
  });
  return meeting.id;
}

/**
 * The admission-seam open: a client member admitted to a `case` meeting, presence-sourced and
 * overdraft-tolerant (plan §B.1 — every presence-seam open is tolerant).
 */
async function openAdmittedSession(
  ctx: Ctx,
  meetingId: string,
  estimatedMinutes: number
): Promise<string> {
  const res = await creditSessionsRepository.open({
    walletId: ctx.walletId,
    companyId: ctx.companyId,
    expertProfileId: ctx.expertProfileId,
    initiatingMemberId: ctx.memberId,
    estimatedMinutes,
    baloFeeBps: BALO_FEE_BPS,
    meetingId,
    engagementId: ctx.engagementId,
    durationSource: 'presence',
    fundingPolicy: 'overdraft_tolerant',
    openedBy: 'client',
  });
  if (!res.ok) {
    throw new Error(`expected open ok, got ${res.code}`);
  }
  return res.session.id;
}

interface HeldSettlement {
  readonly billableMinutes: number;
  readonly minutesAlreadyDrawn: number;
  readonly now: Date;
}

type ChargeOutcome = 'processing' | 'requires_action' | 'hard_decline' | 'throws_after_confirm';

/** Script the ONE Stripe call the next settlement makes. */
function armCharge(outcome: ChargeOutcome, paymentIntentId: string): void {
  switch (outcome) {
    case 'processing':
      mockCreateOffSessionCharge.mockResolvedValueOnce({ status: 'processing', paymentIntentId });
      return;
    case 'requires_action':
      mockCreateOffSessionCharge.mockResolvedValueOnce({
        status: 'requires_action',
        paymentIntentId,
        clientSecret: `${paymentIntentId}_secret`,
      });
      return;
    case 'hard_decline':
      mockCreateOffSessionCharge.mockRejectedValueOnce(
        Object.assign(new Error('Your card was declined.'), {
          type: 'StripeCardError',
          code: 'card_declined',
          payment_intent: { id: paymentIntentId },
        })
      );
      return;
    case 'throws_after_confirm':
      // The client-side failure AFTER Stripe confirmed the PaymentIntent: the SDK surfaces a
      // connection error, so the service treats it as a decline and opens the receivable —
      // while the money has in fact moved and the success webhook is still to come.
      mockCreateOffSessionCharge.mockRejectedValueOnce(
        Object.assign(new Error('Request was retried but the connection was reset'), {
          type: 'StripeConnectionError',
        })
      );
      return;
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled charge outcome ${String(unhandled)}`);
    }
  }
}

/**
 * Settle a presence session as `held` (the repository write), then run the shared post-commit
 * tail every presence settlement runs (`finalizeAndSettle`: payout booking, then the off-session
 * charge of the session's share, or the receivable + dunning when the charge does not go
 * through). Returns the settled row and THIS session's share.
 */
async function settleAndCollect(
  sessionId: string,
  meetingId: string,
  settlement: HeldSettlement,
  charge: { outcome: ChargeOutcome; paymentIntentId: string }
): Promise<{ session: CreditSession; shareMinor: number }> {
  const settled = await creditSessionsRepository.settleFromPresence({
    sessionId,
    meetingId,
    billableMinutes: settlement.billableMinutes,
    actualMinutes: settlement.billableMinutes,
    billingFloorMinutes: FLOOR_MINUTES,
    topUpFromTickSeq: settlement.minutesAlreadyDrawn + 1,
    topUpToTickSeq: settlement.billableMinutes,
    minutesAlreadyDrawn: settlement.minutesAlreadyDrawn,
    shape: 'held',
    floorApplied: false,
    outcome: 'completed',
    actorUserId: null,
    now: settlement.now,
  });
  armCharge(charge.outcome, charge.paymentIntentId);
  await finalizeAndSettle(
    settled.session,
    settled.overdraftMinor,
    settled.mandateActive,
    'presence',
    settlement.now
  );
  // The card was asked for exactly this session's share — never more.
  expect(mockCreateOffSessionCharge).toHaveBeenLastCalledWith(
    expect.objectContaining({
      reason: 'overdraft_settlement',
      sessionId,
      amountMinor: settled.overdraftMinor,
    })
  );
  return { session: settled.session, shareMinor: settled.overdraftMinor };
}

function settlementFields(amountMinor: number, paymentIntentId: string): SettlementFields {
  return {
    creditAmountMinor: amountMinor,
    chargedCurrency: 'aud',
    chargedAmountMinor: amountMinor,
    fxRate: null,
    stripePaymentIntentId: paymentIntentId,
    stripeChargeId: `ch_${paymentIntentId}`,
    stripeBalanceTransactionId: `txn_${paymentIntentId}`,
  };
}

/** The `payment_intent.succeeded` effect for a session's settlement charge. */
function settlementCredit(
  ctx: Ctx,
  sessionId: string,
  amountMinor: number,
  paymentIntentId: string
): StripeEffect {
  return {
    kind: 'credit',
    reason: 'overdraft_settlement',
    walletId: ctx.walletId,
    memberId: ctx.memberId,
    sessionId,
    triggeringEntryId: null,
    promoCode: null,
    cardOnFile: null,
    settlement: settlementFields(amountMinor, paymentIntentId),
  };
}

/** The `payment_intent.succeeded` effect for an on-session cash top-up. */
function cashTopUp(ctx: Ctx, amountMinor: number, paymentIntentId: string): StripeEffect {
  return {
    kind: 'credit',
    reason: 'manual_purchase',
    walletId: ctx.walletId,
    memberId: ctx.memberId,
    sessionId: null,
    triggeringEntryId: null,
    promoCode: null,
    cardOnFile: null,
    settlement: settlementFields(amountMinor, paymentIntentId),
  };
}

/** The `payment_intent.payment_failed` effect for a session's in-flight settlement charge. */
function asyncSettlementFailure(
  ctx: Ctx,
  sessionId: string,
  paymentIntentId: string
): StripeEffect {
  return {
    kind: 'charge_failed',
    walletId: ctx.walletId,
    paymentIntentId,
    code: 'card_declined',
    outcome: null,
    reason: 'overdraft_settlement',
    sessionId,
    triggeringEntryId: null,
    amountMinor: null,
  };
}

/** Deliver an effect the way the webhook does: one transaction, then the post-commit thunks. */
async function deliverStripeEffect(effect: StripeEffect): Promise<void> {
  let postCommit: PostCommitEffect[] = [];
  await db.transaction(async (tx) => {
    postCommit = await applyStripeEffect(tx, effect);
  });
  for (const run of postCommit) {
    await run();
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The harness transaction's `now()` — the `created_at` every ledger row written in this test
 * carries (Postgres `now()` is fixed at transaction start; nested transactions are savepoints).
 */
async function transactionNow(): Promise<Date> {
  const rows = await db.execute<{ now: Date | string }>(sql`select now() as now`);
  const [row] = rows;
  if (row === undefined) {
    throw new Error('select now() returned no row');
  }
  return row.now instanceof Date ? row.now : new Date(row.now);
}

async function walletBalance(walletId: string): Promise<number> {
  const wallet = await creditWalletsRepository.findById(walletId);
  if (wallet === undefined) {
    throw new Error(`wallet ${walletId} is missing`);
  }
  return wallet.balanceMinor;
}

async function receivableOfSession(sessionId: string): Promise<CreditReceivable> {
  const [row] = await db
    .select()
    .from(creditReceivables)
    .where(eq(creditReceivables.sessionId, sessionId));
  if (row === undefined) {
    throw new Error(`no receivable was opened for session ${sessionId}`);
  }
  return row;
}

async function receivableById(id: string): Promise<CreditReceivable> {
  const [row] = await db.select().from(creditReceivables).where(eq(creditReceivables.id, id));
  if (row === undefined) {
    throw new Error(`receivable ${id} is missing`);
  }
  return row;
}

async function walletReceivableIds(walletId: string): Promise<string[]> {
  const rows = await db
    .select({ id: creditReceivables.id })
    .from(creditReceivables)
    .where(eq(creditReceivables.walletId, walletId));
  return rows.map((row) => row.id);
}

async function auditRows(action: string, entityIds: readonly string[]): Promise<AuditEvent[]> {
  if (entityIds.length === 0) {
    return [];
  }
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), inArray(auditEvents.entityId, [...entityIds])));
}

function payloadOf(data: unknown): Record<string, unknown> {
  if (typeof data === 'object' && data !== null && 'payload' in data) {
    const { payload } = data as { payload: unknown };
    if (typeof payload === 'object' && payload !== null) {
      return payload as Record<string, unknown>;
    }
  }
  throw new Error('a queued notification job carried no payload object');
}

/** Every payload published for `event` since the last reset, in publish order. */
function publishesOf(event: string): Array<Record<string, unknown>> {
  return queued
    .filter((job) => job.queue === 'notification-events' && job.name === event)
    .map((job) => payloadOf(job.data));
}

beforeEach(() => {
  queued.length = 0;
  mockGetQueue.mockClear();
  mockCreateOffSessionCharge.mockReset();
  mockCreateOffSessionCharge.mockImplementation(async () => {
    throw new Error('unexpected createOffSessionCharge call — arm every settlement explicitly');
  });
});

// ── The cases ────────────────────────────────────────────────────────────────

describe('INVARIANT (integration): a settlement credit covers prior debt only after its own session settles (ADR-1040 Amendment 7 §F, AD-8, D8.3)', () => {
  it('⚠ FIXTURE GUARD: the plan rates — A$300/h at a 40% fee is 700/min to the client, 500/min to the expert', () => {
    expect(PLAN_RATES.clientRateMinorPerMinute).toBe(700);
    expect(PLAN_RATES.expertRateMinorPerMinute).toBe(500);
    expect(PLAN_RATES.baloFeeBps).toBe(BALO_FEE_BPS);
  });

  it('WE4(c) — a settlement credit that returns the wallet to zero clears the older receivable', async () => {
    const base = new Date();
    const t1 = minutesAfter(base, -60);
    const ctx = await seedMandateWallet({ balanceMinor: 5_500, lowBalanceMode: 'keep_going' });

    // R1 5,000: S1 held 15 (10,500) from +5,500, its card hard-declined.
    const m1 = await bookCaseMeeting(ctx, minutesAfter(t1, -30));
    const s1 = await openAdmittedSession(ctx, m1, 5);
    const s1Settled = await settleAndCollect(
      s1,
      m1,
      { billableMinutes: 15, minutesAlreadyDrawn: 0, now: t1 },
      { outcome: 'hard_decline', paymentIntentId: `pi_s1_${s1}` }
    );
    expect(s1Settled.shareMinor).toBe(5_000);
    const r1 = await receivableOfSession(s1);
    expect(r1).toMatchObject({ status: 'open', amountMinor: 5_000 });
    expect(await walletBalance(ctx.walletId)).toBe(-5_000);

    // S2 tolerant, connected, metered 5 ticks (grace from tick 1) ⇒ −8,500.
    const m2 = await bookCaseMeeting(ctx, base);
    const s2 = await openAdmittedSession(ctx, m2, 30);
    await creditSessionsRepository.connectWithTransition(s2, { now: base });
    await creditSessionsRepository.meterSessionToNow(s2, meterInstant(base, 5), {
      floorMinutes: FLOOR_MINUTES,
    });
    expect(await walletBalance(ctx.walletId)).toBe(-8_500);

    // A 5,000 cash top-up through the webhook ⇒ −3,500; R1 stays (not covered).
    await deliverStripeEffect(cashTopUp(ctx, 5_000, `pi_topup_${s2}`));
    expect(await walletBalance(ctx.walletId)).toBe(-3_500);
    expect((await receivableById(r1.id)).status).toBe('open');

    // S2 settled held 15 ⇒ share 10,500, `processing`.
    const s2Settled = await settleAndCollect(
      s2,
      m2,
      { billableMinutes: 15, minutesAlreadyDrawn: 5, now: minutesAfter(base, 20) },
      { outcome: 'processing', paymentIntentId: `pi_s2_${s2}` }
    );
    expect(s2Settled.shareMinor).toBe(10_500);
    expect(s2Settled.session.settlementStatus).toBe('processing');

    // S2's settlement credit lands ⇒ wallet 0 ⇒ R1 cleared, as a system act.
    await deliverStripeEffect(settlementCredit(ctx, s2, s2Settled.shareMinor, `pi_s2_${s2}`));

    expect(await walletBalance(ctx.walletId)).toBe(0);
    expect((await receivableById(r1.id)).status).toBe('cleared');
    const clears = await auditRows(
      CLEARED_BY_CREDIT_ACTION,
      await walletReceivableIds(ctx.walletId)
    );
    expect(clears).toHaveLength(1);
    const [clear] = clears;
    expect(clear?.entityId).toBe(r1.id);
    expect(clear?.actorUserId).toBeNull();
    expect(clear?.metadata).toMatchObject({
      creditReason: 'overdraft_settlement',
      settlementSessionId: s2,
    });
  });

  it('WE4(c′) — the no-grace variant', async () => {
    const base = new Date();
    const t1 = minutesAfter(base, -60);
    // A live mandate but NO card-backed mode: the meter wraps at zero, never enters grace.
    const ctx = await seedMandateWallet({ balanceMinor: 5_500, lowBalanceMode: 'notify_only' });

    const m1 = await bookCaseMeeting(ctx, minutesAfter(t1, -30));
    const s1 = await openAdmittedSession(ctx, m1, 5);
    const s1Settled = await settleAndCollect(
      s1,
      m1,
      { billableMinutes: 15, minutesAlreadyDrawn: 0, now: t1 },
      { outcome: 'hard_decline', paymentIntentId: `pi_s1_${s1}` }
    );
    expect(s1Settled.shareMinor).toBe(5_000);
    const r1 = await receivableOfSession(s1);
    expect(r1).toMatchObject({ status: 'open', amountMinor: 5_000 });

    // S2 tolerant; on a negative wallet with no card-backed mode it wraps at tick 1, posting nothing.
    const m2 = await bookCaseMeeting(ctx, base);
    const s2 = await openAdmittedSession(ctx, m2, 30);
    await creditSessionsRepository.connectWithTransition(s2, { now: base });
    const metered = await creditSessionsRepository.meterSessionToNow(s2, meterInstant(base, 3), {
      floorMinutes: FLOOR_MINUTES,
    });
    expect(metered.session.status).toBe('wrapped');
    expect(metered.session.lastTickSeq).toBe(0);
    expect(await walletBalance(ctx.walletId)).toBe(-5_000);

    // S2 settled held 15 ⇒ ends at −15,500, share 10,500 `processing`.
    const s2Settled = await settleAndCollect(
      s2,
      m2,
      { billableMinutes: 15, minutesAlreadyDrawn: 0, now: minutesAfter(base, 20) },
      { outcome: 'processing', paymentIntentId: `pi_s2_${s2}` }
    );
    expect(await walletBalance(ctx.walletId)).toBe(-15_500);
    expect(s2Settled.shareMinor).toBe(10_500);

    // A 5,000 top-up ⇒ −10,500: no clear.
    await deliverStripeEffect(cashTopUp(ctx, 5_000, `pi_topup_${s2}`));
    expect(await walletBalance(ctx.walletId)).toBe(-10_500);
    expect((await receivableById(r1.id)).status).toBe('open');

    // The settlement credit ⇒ 0 ⇒ R1 cleared.
    await deliverStripeEffect(settlementCredit(ctx, s2, s2Settled.shareMinor, `pi_s2_${s2}`));
    expect(await walletBalance(ctx.walletId)).toBe(0);
    expect((await receivableById(r1.id)).status).toBe('cleared');
  });

  it('WE4(d) — the anchor move: the session settles first, then the remaining debt is judged from its own anchor', async () => {
    // Anchored on the DATABASE clock, not the host's: t1 precedes the promo's `created_at`
    // (the harness transaction's `now()`) and t3 follows it, whatever the container's skew.
    const base = await transactionNow();
    const t1 = minutesAfter(base, -60);
    const t3 = minutesAfter(base, 5);
    const ctx = await seedMandateWallet({ balanceMinor: 4_000, lowBalanceMode: 'notify_only' });

    // R1 (`requires_action`) 10,000 at t1: S1 held 20 (14,000) from +4,000, SCA required.
    const m1 = await bookCaseMeeting(ctx, minutesAfter(t1, -30));
    const s1 = await openAdmittedSession(ctx, m1, 5);
    const s1Settled = await settleAndCollect(
      s1,
      m1,
      { billableMinutes: 20, minutesAlreadyDrawn: 0, now: t1 },
      { outcome: 'requires_action', paymentIntentId: `pi_s1_${s1}` }
    );
    expect(s1Settled.shareMinor).toBe(10_000);
    const r1 = await receivableOfSession(s1);
    expect(r1).toMatchObject({
      status: 'open',
      amountMinor: 10_000,
      reason: 'settlement_requires_action',
    });

    // Promo +12,000 at t2 ⇒ +2,000; R1 stays (promo never clears a receivable).
    await creditLedgerRepository.postEntry({
      walletId: ctx.walletId,
      entryType: 'adjustment',
      reason: 'promo',
      amountMinor: 12_000,
      idempotencyKey: `promo:${ctx.walletId}:we4d`,
    });
    expect(await walletBalance(ctx.walletId)).toBe(2_000);

    // S2 declines at t3 ⇒ R2 8,500 (−8,500).
    const m2 = await bookCaseMeeting(ctx, base);
    const s2 = await openAdmittedSession(ctx, m2, 30);
    const s2Settled = await settleAndCollect(
      s2,
      m2,
      { billableMinutes: 15, minutesAlreadyDrawn: 0, now: t3 },
      { outcome: 'hard_decline', paymentIntentId: `pi_s2_${s2}` }
    );
    expect(s2Settled.shareMinor).toBe(8_500);
    expect(await walletBalance(ctx.walletId)).toBe(-8_500);
    const r2 = await receivableOfSession(s2);
    expect(r2).toMatchObject({ status: 'open', amountMinor: 8_500 });

    // S1's PaymentIntent later succeeds (+10,000 ⇒ +1,500).
    await deliverStripeEffect(settlementCredit(ctx, s1, s1Settled.shareMinor, `pi_s1_${s1}`));
    expect(await walletBalance(ctx.walletId)).toBe(1_500);

    expect((await receivableById(r2.id)).status).toBe('cleared');
    const hold = await creditReceivablesRepository.readHoldStatus({ walletId: ctx.walletId });
    expect(hold.onHold).toBe(false);
  });

  it('…and does NOT clear when older debt remains (WE2(c))', async () => {
    const base = new Date();
    const t1 = minutesAfter(base, -60);
    const ctx = await seedMandateWallet({ balanceMinor: 4_500, lowBalanceMode: 'keep_going' });

    // S1 ends with share 6,000 and its PaymentIntent `processing` (wallet −6,000).
    const m1 = await bookCaseMeeting(ctx, minutesAfter(t1, -30));
    const s1 = await openAdmittedSession(ctx, m1, 5);
    const s1Settled = await settleAndCollect(
      s1,
      m1,
      { billableMinutes: 15, minutesAlreadyDrawn: 0, now: t1 },
      { outcome: 'processing', paymentIntentId: `pi_s1_${s1}` }
    );
    expect(s1Settled.shareMinor).toBe(6_000);
    expect(await walletBalance(ctx.walletId)).toBe(-6_000);

    // S2 admitted while S1's charge is in flight; 5 ticks in (−9,500)…
    const m2 = await bookCaseMeeting(ctx, base);
    const s2 = await openAdmittedSession(ctx, m2, 30);
    await creditSessionsRepository.connectWithTransition(s2, { now: base });
    await creditSessionsRepository.meterSessionToNow(s2, meterInstant(base, 5), {
      floorMinutes: FLOOR_MINUTES,
    });
    expect(await walletBalance(ctx.walletId)).toBe(-9_500);

    // …S1's PaymentIntent fails ⇒ R1 6,000.
    await deliverStripeEffect(asyncSettlementFailure(ctx, s1, `pi_s1_${s1}`));
    const r1 = await receivableOfSession(s1);
    expect(r1).toMatchObject({ status: 'open', amountMinor: 6_000 });

    // S2 held 20 ⇒ −20,000, share 14,000.
    const s2Settled = await settleAndCollect(
      s2,
      m2,
      { billableMinutes: 20, minutesAlreadyDrawn: 5, now: minutesAfter(base, 25) },
      { outcome: 'processing', paymentIntentId: `pi_s2_${s2}` }
    );
    expect(await walletBalance(ctx.walletId)).toBe(-20_000);
    expect(s2Settled.shareMinor).toBe(14_000);

    queued.length = 0;
    await deliverStripeEffect(settlementCredit(ctx, s2, s2Settled.shareMinor, `pi_s2_${s2}`));

    // −6,000 = R1: R1 keeps owning S1's debt; nothing clears, nothing announces a clear.
    expect(await walletBalance(ctx.walletId)).toBe(-6_000);
    expect((await receivableById(r1.id)).status).toBe('open');
    expect(
      await auditRows(CLEARED_BY_CREDIT_ACTION, await walletReceivableIds(ctx.walletId))
    ).toHaveLength(0);
    expect(publishesOf(RECEIVABLE_CLEARED_EVENT)).toHaveLength(0);
  });

  it('D8.3 — own receivable only, then the PaymentIntent succeeds ⇒ exactly one account-clear notice', async () => {
    const base = new Date();
    const ctx = await seedMandateWallet({ balanceMinor: 0, lowBalanceMode: 'notify_only' });

    // S's charge throws client-side after Stripe confirmed ⇒ openReceivableAndDun opens R_S.
    const m = await bookCaseMeeting(ctx, base);
    const s = await openAdmittedSession(ctx, m, 30);
    const settled = await settleAndCollect(
      s,
      m,
      { billableMinutes: 15, minutesAlreadyDrawn: 0, now: minutesAfter(base, 20) },
      { outcome: 'throws_after_confirm', paymentIntentId: `pi_s_${s}` }
    );
    expect(settled.shareMinor).toBe(10_500);
    const rS = await receivableOfSession(s);
    expect(rS).toMatchObject({ status: 'open', amountMinor: 10_500 });

    // The overdraft_settlement credit for S ⇒ R_S cleared by markSettlementSettled.
    queued.length = 0;
    await deliverStripeEffect(settlementCredit(ctx, s, settled.shareMinor, `pi_s_${s}`));
    expect((await receivableById(rS.id)).status).toBe('cleared');

    const entry = await creditLedgerRepository.findByIdempotencyKey(
      deriveIdempotencyKey({ reason: 'overdraft_settlement', sessionId: s })
    );
    if (entry === undefined) {
      throw new Error('the overdraft_settlement ledger credit is missing');
    }
    const cleared = publishesOf(RECEIVABLE_CLEARED_EVENT);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({
      correlationId: `receivable_cleared:${entry.id}`,
      clearedBy: 'overdraft_settlement',
    });
  });

  it('D8.3 — own receivable plus an older uncovered receivable still open, then the PaymentIntent succeeds ⇒ no cleared publish', async () => {
    const base = new Date();
    const t1 = minutesAfter(base, -60);
    const ctx = await seedMandateWallet({ balanceMinor: 4_000, lowBalanceMode: 'notify_only' });

    // The older, uncovered debt: S1 held 20 from +4,000 ⇒ R_old 10,000.
    const m1 = await bookCaseMeeting(ctx, minutesAfter(t1, -30));
    const s1 = await openAdmittedSession(ctx, m1, 5);
    await settleAndCollect(
      s1,
      m1,
      { billableMinutes: 20, minutesAlreadyDrawn: 0, now: t1 },
      { outcome: 'hard_decline', paymentIntentId: `pi_s1_${s1}` }
    );
    const rOld = await receivableOfSession(s1);
    expect(rOld).toMatchObject({ status: 'open', amountMinor: 10_000 });

    // S's own receivable, from a client-side throw after Stripe confirmed.
    const m2 = await bookCaseMeeting(ctx, base);
    const s = await openAdmittedSession(ctx, m2, 30);
    const settled = await settleAndCollect(
      s,
      m2,
      { billableMinutes: 15, minutesAlreadyDrawn: 0, now: minutesAfter(base, 20) },
      { outcome: 'throws_after_confirm', paymentIntentId: `pi_s_${s}` }
    );
    expect(settled.shareMinor).toBe(10_500);
    const rS = await receivableOfSession(s);
    expect(rS).toMatchObject({ status: 'open', amountMinor: 10_500 });

    queued.length = 0;
    await deliverStripeEffect(settlementCredit(ctx, s, settled.shareMinor, `pi_s_${s}`));

    expect(await walletBalance(ctx.walletId)).toBe(-10_000);
    expect((await receivableById(rS.id)).status).toBe('cleared');
    expect((await receivableById(rOld.id)).status).toBe('open');
    expect(publishesOf(RECEIVABLE_CLEARED_EVENT)).toHaveLength(0);
  });
});
