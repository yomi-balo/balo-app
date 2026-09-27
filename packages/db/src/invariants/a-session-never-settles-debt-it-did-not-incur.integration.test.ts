import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { deriveSessionEstimate } from '@balo/shared/credit';
import { db } from '../client';
import {
  auditEvents,
  creditLedger,
  creditSessions,
  expertProfiles,
  type NewCreditWallet,
} from '../schema';
import {
  creditWalletFactory,
  expertFactory,
  meetingFactory,
  meetingGuestFactory,
  userFactory,
} from '../test/factories';
import { acquireWalletLock } from '../repositories/_shared/wallet-lock';
import { creditLedgerRepository } from '../repositories/credit-ledger';
import { creditReceivablesRepository } from '../repositories/credit-receivables';
import { creditWalletsRepository } from '../repositories/credit-wallets';
import {
  creditSessionsRepository,
  type OpenSessionInput,
  type SettleFromPresenceRepoInput,
} from '../repositories/credit-sessions';

/**
 * ⚠⚠ INVARIANT (integration) — A SESSION NEVER SETTLES DEBT IT DID NOT INCUR. ADR-1040 Amendment 7
 * §A/§B (BAL-474, D1 / D5.1 / D5.2 / D7.3 / D7.4 / D7.8).
 *
 * The pure share (`resolveSessionOverdraftShare`) is pinned by the sibling unit suite. This proves
 * the REPOSITORY writes it — on real wallets whose negative balance already carries OLDER debt
 * (a prior receivable, another session's in-flight charge), which Amendment 7's overdraft-tolerant
 * open now lets a presence session open onto:
 *
 *   · the terminal figure is the session's own share, never the whole wallet (WE1, WE2(b));
 *   · the post-charge `processing` stamp and the failure stamp are compare-and-set, so neither can
 *     overwrite a `settled` row (WE2(d), R4-F4);
 *   · an older debt the settling session leaves with no owner is detected INSIDE the terminal
 *     transaction, excluding the settling session itself (D7.3);
 *   · a no-mandate tolerant open wraps at zero with NO grace, and the floor still bills
 *     (the folded residual #1);
 *   · the gated open is unchanged; never two live sessions for one meeting (AD-4); an on-behalf
 *     open records its attribution in the same transaction (§C.3).
 *
 * Per ADR-1032 this was AUTHORED AND RUN RED before the tolerant open, the share read, the owner
 * check and the CAS stamps existed.
 *
 * Rates: expert 30,000 / h at a 40% fee ⇒ client 700 / min, expert 500 / min — the plan's worked
 * examples, exactly (asserted below via `deriveSessionEstimate`).
 */

const EXPERT_HOURLY = 30_000;
const FEE_BPS = 4_000;
const RATES = deriveSessionEstimate({
  expertHourlyMinor: EXPERT_HOURLY,
  estimatedMinutes: 1,
  baloFeeBps: FEE_BPS,
});
const CLIENT_RATE = RATES.clientRateMinorPerMinute;
const FLOOR = 15;
const HOUR_MS = 60 * 60_000;

interface Ctx {
  walletId: string;
  companyId: string;
  expertProfileId: string;
  memberId: string;
}

async function setup(values: Partial<NewCreditWallet>): Promise<Ctx> {
  const { wallet, companyId } = await creditWalletFactory({ values });
  const member = await userFactory();
  const expert = await expertFactory();
  await db
    .update(expertProfiles)
    .set({ rateCents: EXPERT_HOURLY })
    .where(eq(expertProfiles.id, expert.id));
  return { walletId: wallet.id, companyId, expertProfileId: expert.id, memberId: member.id };
}

const NO_MANDATE = (balanceMinor: number): Partial<NewCreditWallet> => ({ balanceMinor });
const MANDATE_KEEP_GOING = (balanceMinor: number): Partial<NewCreditWallet> => ({
  balanceMinor,
  mandateStatus: 'active',
  stripeCustomerId: 'cus_share',
  stripePaymentMethodId: 'pm_share',
  lowBalanceMode: 'keep_going',
});

/** A Case meeting for the session to bind to (and its engagement, for on-behalf opens). */
async function caseMeeting(): Promise<{ meetingId: string; engagementId: string }> {
  const { meeting, caseEngagementId } = await meetingFactory({
    values: { status: 'ended', endedAt: new Date(Date.now() - 2 * HOUR_MS) },
  });
  if (caseEngagementId === undefined) throw new Error('meeting seed failed');
  return { meetingId: meeting.id, engagementId: caseEngagementId };
}

function openInput(
  ctx: Ctx,
  meeting: { meetingId: string; engagementId: string },
  overrides: Partial<OpenSessionInput> = {}
): OpenSessionInput {
  return {
    walletId: ctx.walletId,
    companyId: ctx.companyId,
    expertProfileId: ctx.expertProfileId,
    initiatingMemberId: ctx.memberId,
    estimatedMinutes: 30,
    baloFeeBps: FEE_BPS,
    meetingId: meeting.meetingId,
    engagementId: meeting.engagementId,
    durationSource: 'presence',
    ...overrides,
  };
}

async function openGated(
  ctx: Ctx,
  estimatedMinutes: number
): Promise<{ id: string; meetingId: string }> {
  const meeting = await caseMeeting();
  const res = await creditSessionsRepository.open(openInput(ctx, meeting, { estimatedMinutes }));
  if (!res.ok) throw new Error(`expected gated open ok, got ${res.code}`);
  return { id: res.session.id, meetingId: meeting.meetingId };
}

async function openTolerant(
  ctx: Ctx,
  overrides: Partial<OpenSessionInput> = {}
): Promise<{ id: string; meetingId: string; toleratedGates: readonly string[] }> {
  const meeting = await caseMeeting();
  const res = await creditSessionsRepository.open(
    openInput(ctx, meeting, { fundingPolicy: 'overdraft_tolerant', ...overrides })
  );
  if (!res.ok) throw new Error(`expected tolerant open ok, got ${res.code}`);
  return { id: res.session.id, meetingId: meeting.meetingId, toleratedGates: res.toleratedGates };
}

/** Settle a presence session as HELD at `minutes` (or as a floor NO-SHOW), from `drawn`. */
function held(
  sessionId: string,
  meetingId: string,
  minutes: number,
  opts: { drawn?: number; now?: Date; shape?: 'held' | 'no_show_client' } = {}
): SettleFromPresenceRepoInput {
  const drawn = opts.drawn ?? 0;
  const shape = opts.shape ?? 'held';
  return {
    sessionId,
    meetingId,
    billableMinutes: minutes,
    actualMinutes: minutes,
    billingFloorMinutes: FLOOR,
    topUpFromTickSeq: drawn + 1,
    topUpToTickSeq: minutes,
    minutesAlreadyDrawn: drawn,
    shape,
    floorApplied: shape === 'no_show_client',
    outcome: shape === 'no_show_client' ? 'no_show_client' : 'completed',
    actorUserId: null,
    now: opts.now ?? new Date(Date.now() - HOUR_MS),
  };
}

/** Mirror `openReceivableAndDun`: one locked transaction, failure stamp then receivable. */
async function failAndOpenReceivable(
  ctx: Ctx,
  sessionId: string,
  amountMinor: number
): Promise<string> {
  return db.transaction(async (tx) => {
    await acquireWalletLock(tx, ctx.walletId);
    await creditSessionsRepository.markSettlementResult(tx, { sessionId, status: 'failed' });
    const { receivable } = await creditReceivablesRepository.open(
      {
        companyId: ctx.companyId,
        walletId: ctx.walletId,
        sessionId,
        amountMinor,
        reason: 'settlement_declined',
      },
      tx
    );
    return receivable.id;
  });
}

async function walletBalance(walletId: string): Promise<number> {
  const wallet = await creditWalletsRepository.findById(walletId);
  return wallet?.balanceMinor ?? Number.NaN;
}

async function consumeSum(sessionId: string): Promise<number> {
  const rows = await db
    .select({ amountMinor: creditLedger.amountMinor })
    .from(creditLedger)
    .where(and(eq(creditLedger.sessionId, sessionId), eq(creditLedger.reason, 'session_consume')));
  return rows.reduce((sum, row) => sum + row.amountMinor, 0);
}

async function consumeCount(sessionId: string): Promise<number> {
  const rows = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.sessionId, sessionId), eq(creditLedger.reason, 'session_consume')));
  return rows.length;
}

describe('INVARIANT (integration): a session never settles debt it did not incur', () => {
  it('fixture rates are the worked examples: client 700 / min, expert 500 / min', () => {
    expect(CLIENT_RATE).toBe(700);
    expect(RATES.expertRateMinorPerMinute).toBe(500);
  });

  it('WE1 — a prior receivable is not re-billed', async () => {
    const ctx = await setup(NO_MANDATE(4_000));
    // S1 — gated, estimate within the balance (5 × 700 = 3,500 ≤ 4,000), held 20 ⇒ −10,000.
    const s1 = await openGated(ctx, 5);
    const s1Settled = await creditSessionsRepository.settleFromPresence(
      held(s1.id, s1.meetingId, 20, { now: new Date(Date.now() - 3 * HOUR_MS) })
    );
    expect(s1Settled.overdraftMinor).toBe(10_000);
    expect(await walletBalance(ctx.walletId)).toBe(-10_000);
    // No mandate ⇒ S1 fails and R1 = 10,000 opens, in one transaction (openReceivableAndDun).
    await failAndOpenReceivable(ctx, s1.id, 10_000);

    // S2 — tolerant: through the hold, the negative balance and the unfunded estimate. NOT
    // `settlement_processing`: S1 is `failed`, not in flight.
    const s2 = await openTolerant(ctx, { estimatedMinutes: 25 });
    expect(s2.toleratedGates).toEqual([
      'account_hold',
      'negative_balance',
      'insufficient_no_mandate',
    ]);

    const s2Settled = await creditSessionsRepository.settleFromPresence(
      held(s2.id, s2.meetingId, 25)
    );
    // S2 consumed 17,500 onto a wallet already −10,000 ⇒ −27,500. Legacy would bill 27,500.
    expect(await walletBalance(ctx.walletId)).toBe(-27_500);
    expect(s2Settled.overdraftMinor).toBe(17_500);
    expect(s2Settled.session.overdraftSettledMinor).toBe(17_500);
    expect(s2Settled.overdraftBasis?.priorDebtLeftMinor).toBe(10_000);
    expect(s2Settled.overdraftBasis?.ownerlessPriorDebtMinor).toBe(0);
    expect(await consumeSum(s2.id)).toBe(-17_500);
  });

  it('WE2(b) — an in-flight settlement is not re-billed', async () => {
    const ctx = await setup(MANDATE_KEEP_GOING(8_000));
    // S1 — held 20 (14,000) on 8,000 ⇒ −6,000, its charge `processing`.
    const s1 = await openGated(ctx, 10);
    const s1Settled = await creditSessionsRepository.settleFromPresence(
      held(s1.id, s1.meetingId, 20, { now: new Date(Date.now() - 3 * HOUR_MS) })
    );
    expect(s1Settled.overdraftMinor).toBe(6_000);
    expect(s1Settled.session.settlementStatus).toBe('processing');

    const s2 = await openTolerant(ctx, { estimatedMinutes: 20 });
    expect(s2.toleratedGates).toEqual(['settlement_processing', 'negative_balance']);

    const s2Settled = await creditSessionsRepository.settleFromPresence(
      held(s2.id, s2.meetingId, 20)
    );
    expect(await walletBalance(ctx.walletId)).toBe(-20_000);
    // THE CAP: S2 is charged its own 14,000, never S1's still-uncredited 6,000 (legacy: 20,000).
    expect(s2Settled.overdraftMinor).toBe(14_000);
    expect(s2Settled.overdraftBasis?.priorDebtLeftMinor).toBe(6_000);
    // S1's uncredited `processing` 6,000 owns the older debt.
    expect(s2Settled.overdraftBasis?.ownerlessPriorDebtMinor).toBe(0);
  });

  it('WE2(d) — a processing stamp can never overwrite a settled row, and the share ignores the label', async () => {
    const ctx = await setup(MANDATE_KEEP_GOING(8_000));
    const s1 = await openGated(ctx, 10);
    await creditSessionsRepository.settleFromPresence(
      held(s1.id, s1.meetingId, 20, { now: new Date(Date.now() - 3 * HOUR_MS) })
    );
    // S2 is admitted while S1's charge is still in flight.
    const s2 = await openTolerant(ctx, { estimatedMinutes: 20 });

    // S1's webhook wins the race: the settlement credit lands and the session is marked settled…
    await creditLedgerRepository.postEntry({
      walletId: ctx.walletId,
      entryType: 'purchase',
      reason: 'overdraft_settlement',
      amountMinor: 6_000,
      idempotencyKey: `overdraft_settlement:${s1.id}`,
      memberId: ctx.memberId,
      sessionId: s1.id,
    });
    await creditSessionsRepository.markSettlementResult(db, {
      sessionId: s1.id,
      status: 'settled',
      stripePaymentIntentId: 'pi_s1',
    });
    expect(await walletBalance(ctx.walletId)).toBe(0);

    // …THEN the charge path's late post-charge stamp arrives. Compare-and-set: it never flips
    // `settled` back to `processing` (D5.2), and a late failure stamp never overwrites it (R4-F4).
    const lateProcessing = await creditSessionsRepository.markSettlementResult(db, {
      sessionId: s1.id,
      status: 'processing',
      stripePaymentIntentId: 'pi_s1',
    });
    expect(lateProcessing.settlementStatus).toBe('settled');
    const lateFailure = await creditSessionsRepository.markSettlementResult(db, {
      sessionId: s1.id,
      status: 'failed',
    });
    expect(lateFailure.settlementStatus).toBe('settled');
    const [s1Row] = await db
      .select({ settlementStatus: creditSessions.settlementStatus })
      .from(creditSessions)
      .where(eq(creditSessions.id, s1.id));
    expect(s1Row?.settlementStatus).toBe('settled');

    // S2 held 20 ⇒ its own 14,000 — no in-flight term to double-count.
    const s2Settled = await creditSessionsRepository.settleFromPresence(
      held(s2.id, s2.meetingId, 20)
    );
    expect(s2Settled.overdraftMinor).toBe(14_000);
    expect(s2Settled.overdraftBasis?.ownerlessPriorDebtMinor).toBe(0);

    // S2's own settlement credit returns the wallet to zero.
    await creditLedgerRepository.postEntry({
      walletId: ctx.walletId,
      entryType: 'purchase',
      reason: 'overdraft_settlement',
      amountMinor: s2Settled.overdraftMinor,
      idempotencyKey: `overdraft_settlement:${s2.id}`,
      memberId: ctx.memberId,
      sessionId: s2.id,
    });
    expect(await walletBalance(ctx.walletId)).toBe(0);
  });

  it('⚠⚠ D7.3 — an ownerless prior debt is detected in the terminal transaction, excluding the settling session', async () => {
    const ctx = await setup(MANDATE_KEEP_GOING(4_000));
    const s1 = await openGated(ctx, 5);
    await creditSessionsRepository.settleFromPresence(
      held(s1.id, s1.meetingId, 20, { now: new Date(Date.now() - 3 * HOUR_MS) })
    );
    const r1 = await failAndOpenReceivable(ctx, s1.id, 10_000);
    // A WRONG clear: R1 is cleared while the wallet still owes its 10,000.
    await creditReceivablesRepository.clear({ receivableId: r1 });
    expect(await walletBalance(ctx.walletId)).toBe(-10_000);

    const s2 = await openTolerant(ctx, { estimatedMinutes: 25 });
    const s2Settled = await creditSessionsRepository.settleFromPresence(
      held(s2.id, s2.meetingId, 25)
    );
    expect(s2Settled.overdraftMinor).toBe(17_500);
    expect(s2Settled.overdraftBasis?.priorDebtLeftMinor).toBe(10_000);
    // Nobody owns the 10,000 any more: R1 is cleared and S1 is `failed`. S2's OWN `processing`
    // 17,500 must not count as an owner — mutation proof: delete the `<> S` exclusion and this
    // reads 0.
    expect(s2Settled.overdraftBasis?.ownerlessPriorDebtMinor).toBe(10_000);
  });

  it('⚠ folded residual #1 — a second no-mandate admission after the balance is consumed opens in overdraft, wraps at zero with NO grace, and the floor still bills', async () => {
    const ctx = await setup(NO_MANDATE(14_000));
    // S1 — gated, estimate within the balance; held 20 consumes the balance to exactly zero.
    const s1 = await openGated(ctx, 5);
    const s1Settled = await creditSessionsRepository.settleFromPresence(
      held(s1.id, s1.meetingId, 20, { now: new Date(Date.now() - 3 * HOUR_MS) })
    );
    expect(s1Settled.overdraftMinor).toBe(0);
    expect(await walletBalance(ctx.walletId)).toBe(0);
    expect(await creditReceivablesRepository.hasOpenReceivable(ctx.companyId)).toBe(false);

    // S2 — another meeting, tolerant: the ONLY gate it passes through is the unfunded estimate.
    const s2 = await openTolerant(ctx, { estimatedMinutes: 30 });
    expect(s2.toleratedGates).toEqual(['insufficient_no_mandate']);

    // The first metered tick would cross zero with no card ⇒ warm wrap, NO grace, nothing posted.
    const connectedAt = new Date(Date.now() - 5 * 60_000);
    await creditSessionsRepository.connectWithTransition(s2.id, { now: connectedAt });
    const metered = await creditSessionsRepository.meterSessionToNow(
      s2.id,
      new Date(connectedAt.getTime() + 60_000 + 30_000),
      { floorMinutes: FLOOR }
    );
    expect(metered.session.status).toBe('wrapped');
    expect(metered.session.wrappedAt).not.toBeNull();
    expect(metered.session.graceEnteredAt).toBeNull();
    expect(metered.ticksPosted).toBe(0);
    expect(await consumeCount(s2.id)).toBe(0);

    // Settled as a client no-show: the FLOOR bills in full — never refused, never unbilled.
    const s2Settled = await creditSessionsRepository.settleFromPresence(
      held(s2.id, s2.meetingId, FLOOR, { shape: 'no_show_client' })
    );
    expect(await consumeCount(s2.id)).toBe(FLOOR);
    expect(s2Settled.overdraftMinor).toBe(FLOOR * CLIENT_RATE);
    expect(s2Settled.mandateActive).toBe(false);
    expect(s2Settled.session.settlementStatus).toBe('processing');
    // No card ⇒ the settlement service opens a receivable of exactly that share.
    await failAndOpenReceivable(ctx, s2.id, s2Settled.overdraftMinor);
    const [receivable] = await creditReceivablesRepository.findOpenByCompany(ctx.companyId);
    expect(receivable?.amountMinor).toBe(FLOOR * CLIENT_RATE);
  });

  it('WE3(a) — promo is spent before any charge', async () => {
    const ctx = await setup(NO_MANDATE(0));
    await creditLedgerRepository.postEntry({
      walletId: ctx.walletId,
      entryType: 'adjustment',
      reason: 'promo',
      amountMinor: 3_000,
      idempotencyKey: `promo:${ctx.walletId}:3000`,
    });
    const s = await openTolerant(ctx, { estimatedMinutes: 20 });
    expect(s.toleratedGates).toEqual(['insufficient_no_mandate']);

    // Ticks 1–4 are funded by the promo; tick 5 would cross zero with no card ⇒ wrap.
    const connectedAt = new Date(Date.now() - 10 * 60_000);
    await creditSessionsRepository.connectWithTransition(s.id, { now: connectedAt });
    const metered = await creditSessionsRepository.meterSessionToNow(
      s.id,
      new Date(connectedAt.getTime() + 5 * 60_000 + 30_000),
      { floorMinutes: FLOOR }
    );
    expect(metered.ticksPosted).toBe(4);
    expect(metered.session.status).toBe('wrapped');

    const settled = await creditSessionsRepository.settleFromPresence(
      held(s.id, s.meetingId, 20, { drawn: 4 })
    );
    expect(await walletBalance(ctx.walletId)).toBe(-11_000);
    expect(settled.overdraftMinor).toBe(11_000);
  });

  it('WE3(c) — RESIDUAL, pinned as CURRENT behaviour (fail-closed): promo spent while held is still discounted', async () => {
    // R-7 — a KNOWN residual, pinned so a change is deliberate: the coverage discount subtracts
    // ALL promo granted since the debt's anchor, including the part a later session spent. The
    // top-up figure is therefore higher than the recorded debt; paying it clears, and the excess
    // stays in the balance. Net wealth is identical; it fails CLOSED.
    const ctx = await setup(NO_MANDATE(4_000));
    const s1 = await openGated(ctx, 5);
    await creditSessionsRepository.settleFromPresence(
      held(s1.id, s1.meetingId, 20, { now: new Date(Date.now() - 3 * HOUR_MS) })
    );
    await failAndOpenReceivable(ctx, s1.id, 10_000);
    await creditLedgerRepository.postEntry({
      walletId: ctx.walletId,
      entryType: 'adjustment',
      reason: 'promo',
      amountMinor: 12_000,
      idempotencyKey: `promo:${ctx.walletId}:12000`,
    });
    expect(await walletBalance(ctx.walletId)).toBe(2_000);

    const s2 = await openTolerant(ctx, { estimatedMinutes: 15 });
    const s2Settled = await creditSessionsRepository.settleFromPresence(
      held(s2.id, s2.meetingId, 15)
    );
    expect(s2Settled.overdraftMinor).toBe(8_500);
    await failAndOpenReceivable(ctx, s2.id, s2Settled.overdraftMinor);

    await creditLedgerRepository.postEntry({
      walletId: ctx.walletId,
      entryType: 'purchase',
      reason: 'manual_purchase',
      amountMinor: 18_500,
      idempotencyKey: `manual_purchase:${ctx.walletId}:18500`,
      memberId: ctx.memberId,
    });
    const partly = await creditReceivablesRepository.readHoldStatus({ walletId: ctx.walletId });
    expect(partly.amountToClearMinor).toBe(2_000);

    await creditLedgerRepository.postEntry({
      walletId: ctx.walletId,
      entryType: 'purchase',
      reason: 'manual_purchase',
      amountMinor: 2_000,
      idempotencyKey: `manual_purchase:${ctx.walletId}:2000`,
      memberId: ctx.memberId,
    });
    const covered = await creditReceivablesRepository.readHoldStatus({ walletId: ctx.walletId });
    expect(covered.amountToClearMinor).toBe(0);
  });

  it('⚠ the GATED open still refuses exactly as before', async () => {
    // GREEN on main — a guard: Amendment 7 changes ONLY the tolerant policy. `POST /sessions`
    // (`live_capture`) and every caller that passes no policy keep every refusal, byte-identical.
    const onHold = await setup(NO_MANDATE(50_000));
    const prior = await openGated(onHold, 10);
    await creditReceivablesRepository.open({
      companyId: onHold.companyId,
      walletId: onHold.walletId,
      sessionId: prior.id,
      amountMinor: 500,
      reason: 'settlement_declined',
    });
    await creditSessionsRepository.cancel(prior.id);
    expect(
      await creditSessionsRepository.open({
        walletId: onHold.walletId,
        companyId: onHold.companyId,
        expertProfileId: onHold.expertProfileId,
        initiatingMemberId: onHold.memberId,
        estimatedMinutes: 10,
      })
    ).toEqual({ ok: false, code: 'account_hold' });

    const negative = await setup(MANDATE_KEEP_GOING(-1_000));
    expect(
      await creditSessionsRepository.open({
        walletId: negative.walletId,
        companyId: negative.companyId,
        expertProfileId: negative.expertProfileId,
        initiatingMemberId: negative.memberId,
        estimatedMinutes: 10,
      })
    ).toEqual({ ok: false, code: 'settlement_pending' });

    const unfunded = await setup(NO_MANDATE(1_000));
    expect(
      await creditSessionsRepository.open({
        walletId: unfunded.walletId,
        companyId: unfunded.companyId,
        expertProfileId: unfunded.expertProfileId,
        initiatingMemberId: unfunded.memberId,
        estimatedMinutes: 10,
      })
    ).toEqual({ ok: false, code: 'insufficient_no_mandate' });
  });

  it('⚠ never two live sessions for one meeting — the in-lock check', async () => {
    const ctx = await setup(NO_MANDATE(50_000));
    const meeting = await caseMeeting();
    const first = await creditSessionsRepository.open(
      openInput(ctx, meeting, { estimatedMinutes: 10 })
    );
    if (!first.ok) throw new Error(`expected open ok, got ${first.code}`);
    await creditSessionsRepository.settleFromPresence(
      held(first.session.id, meeting.meetingId, 20)
    );
    const [ended] = await db
      .select({ status: creditSessions.status })
      .from(creditSessions)
      .where(eq(creditSessions.id, first.session.id));
    expect(ended?.status).toBe('ended');

    // ENDED is not "gone": a second session for the same meeting is refused, gated or tolerant.
    const second = await creditSessionsRepository.open(
      openInput(ctx, meeting, { estimatedMinutes: 10 })
    );
    expect(second).toEqual({
      ok: false,
      code: 'meeting_session_exists',
      existingSessionId: first.session.id,
    });
    const secondTolerant = await creditSessionsRepository.open(
      openInput(ctx, meeting, { estimatedMinutes: 10, fundingPolicy: 'overdraft_tolerant' })
    );
    expect(secondTolerant).toEqual({
      ok: false,
      code: 'meeting_session_exists',
      existingSessionId: first.session.id,
    });

    // A meeting whose ONLY session was cancelled reads as sessionless — it opens.
    const other = await caseMeeting();
    const cancelled = await creditSessionsRepository.open(
      openInput(ctx, other, { estimatedMinutes: 10 })
    );
    if (!cancelled.ok) throw new Error(`expected open ok, got ${cancelled.code}`);
    await creditSessionsRepository.cancel(cancelled.session.id);
    const reopened = await creditSessionsRepository.open(
      openInput(ctx, other, { estimatedMinutes: 10 })
    );
    expect(reopened.ok).toBe(true);
  });

  it('an on-behalf open writes its attribution in the same transaction', async () => {
    const ctx = await setup(NO_MANDATE(50_000));
    const meeting = await caseMeeting();
    const { guest } = await meetingGuestFactory({ meetingId: meeting.meetingId });
    const res = await creditSessionsRepository.open(
      openInput(ctx, meeting, {
        estimatedMinutes: 10,
        fundingPolicy: 'overdraft_tolerant',
        openedBy: 'guest',
        meetingGuestId: guest.id,
      })
    );
    if (!res.ok) throw new Error(`expected open ok, got ${res.code}`);

    const [session] = await db
      .select()
      .from(creditSessions)
      .where(eq(creditSessions.id, res.session.id));
    expect(session?.openedBy).toBe('guest');
    expect(session?.initiatingMemberId).toBe(ctx.memberId);

    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, res.session.id),
          eq(auditEvents.action, 'credit_session.opened_on_behalf')
        )
      );
    expect(rows).toHaveLength(1);
    const [audit] = rows;
    expect(audit?.actorUserId).toBeNull();
    expect(audit?.entityType).toBe('credit_session');
    expect(audit?.metadata).toMatchObject({
      openedBy: 'guest',
      onBehalfOfUserId: ctx.memberId,
      meetingId: meeting.meetingId,
      engagementId: meeting.engagementId,
      meetingGuestId: guest.id,
      fundingPolicy: 'overdraft_tolerant',
      toleratedGates: [],
    });
    expect(audit?.createdAt.getTime()).toBe(session?.createdAt.getTime());
  });
});
