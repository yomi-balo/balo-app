import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  applyBaloFee,
  deriveMinuteRateCents,
  DEFAULT_BALO_FEE_BPS,
  DEFAULT_OVERDRAFT_CEILING_MINOR,
} from '@balo/shared/pricing';
import { isWalletMandateActive, walletAllowsOverdraftGrace } from '@balo/shared/credit';
import { db, type Database } from '../client';
import {
  auditEvents,
  creditHolds,
  creditLedger,
  creditSessions,
  creditWallets,
  expertPayoutRecords,
  expertProfiles,
  meetings,
  users,
  caseEngagements,
  type AuditEvent,
  type NewCreditWallet,
} from '../schema';
import {
  agencyFactory,
  caseEngagementFactory,
  creditWalletFactory,
  expertFactory,
  meetingFactory,
  userFactory,
} from '../test/factories';
import {
  creditSessionsRepository,
  CLIENT_SESSION_VIEW_COLUMNS,
  ExternalDurationConflictError,
  InvalidSessionTransitionError,
  SessionNotFoundError,
  SettlementDrawDivergedError,
  type OpenSessionResult,
  type SettleFromPresenceRepoInput,
} from './credit-sessions';
import { expertPayoutRecordsRepository } from './expert-payout-records';
import { toClientMoneyBlock } from './_shared/credit-views';
import { creditLedgerRepository } from './credit-ledger';
import { creditReceivablesRepository } from './credit-receivables';
import { creditHoldsRepository } from './credit-holds';
import { meetingContextsRepository } from './meeting-contexts';
import { creditWalletsRepository } from './credit-wallets';

/**
 * Integration tests for `creditSessionsRepository` (BAL-378). Covers the money-invariant
 * scenarios from plan §12: the available-balance gate, promo-excluded-from-settlement, the
 * meter tick + idempotent re-meter, grace entry, ceiling / 30-min wrap (incl. the ≤1-min
 * overshoot), the no-mandate hard stop, one-shot markers, the `end` accrual + audit row (the
 * expert-always-paid record present even with overdraft), `markSettlementResult`, `cancel`,
 * and the reaper-finder queries. Factories only; deterministic `now`.
 */

// Expert A$120/hr → client A$150/hr (25% fee) → 250c/min client, 200c/min expert.
const EXPERT_HOURLY = 12_000;
const CLIENT_RATE_PER_MIN = deriveMinuteRateCents(
  applyBaloFee(EXPERT_HOURLY, DEFAULT_BALO_FEE_BPS)
);
const EXPERT_RATE_PER_MIN = deriveMinuteRateCents(EXPERT_HOURLY);
const BASE = new Date('2027-01-01T00:00:00.000Z');
/**
 * BAL-412 (F13/D6) — the billing floor `meterSessionToNow` now REQUIRES, matching the shipped
 * `MEETING_NO_SHOW_FLOOR_MINUTES` default that `apps/api`'s meter driver injects. It feeds
 * `minutesOfRunway`, which decides `lowWarnedAt`: while a session is still inside the floor the
 * unconsumed remainder is set aside first, so the low warning fires SOONER than the old
 * `floor(balance / rate)` did. That is the intended correction, not a regression.
 */
const METER_FLOOR_MINUTES = 15;

/** `BASE + minutes` + a 30s cushion so `floor((now − connectedAt)/60s)` lands on `minutes`. */
function meterAt(minutes: number): Date {
  return new Date(BASE.getTime() + minutes * 60_000 + 30_000);
}

interface SetupOpts {
  balanceMinor?: number;
  mandate?: boolean;
  /**
   * ⚠⚠ BAL-523 — DELIBERATELY INDEPENDENT OF `mandate`. Never derive one from the other here:
   * "an active mandate implies a card-backed mode" is EXACTLY the coupling BAL-523 removed from
   * production, and re-introducing it in the fixture would make every `mandate: true` wallet
   * grace-capable again, silently un-testing the fix. Omitted ⇒ the schema default
   * `'notify_only'`. See the FIXTURE GUARD test below.
   */
  lowBalanceMode?: 'auto_topup' | 'keep_going' | 'notify_only';
  overdraftCeilingMinor?: number | null;
  estimatedMinutes?: number;
  expertHourlyCents?: number | null;
}

/** Seed a wallet (+optional mandate/balance), an expert with a rate, and a member. */
async function setup(opts: SetupOpts = {}): Promise<{
  walletId: string;
  companyId: string;
  expertProfileId: string;
  memberId: string;
}> {
  const walletValues: Partial<NewCreditWallet> = { balanceMinor: opts.balanceMinor ?? 0 };
  if (opts.mandate === true) {
    walletValues.mandateStatus = 'active';
    walletValues.stripeCustomerId = 'cus_test';
    walletValues.stripePaymentMethodId = 'pm_test';
  }
  if (opts.lowBalanceMode !== undefined) {
    walletValues.lowBalanceMode = opts.lowBalanceMode;
  }
  if (opts.overdraftCeilingMinor !== undefined) {
    walletValues.overdraftCeilingMinor = opts.overdraftCeilingMinor;
  }
  const { wallet, companyId } = await creditWalletFactory({ values: walletValues });
  const member = await userFactory();
  const expert = await expertFactory();
  await db
    .update(expertProfiles)
    .set({
      rateCents: opts.expertHourlyCents === undefined ? EXPERT_HOURLY : opts.expertHourlyCents,
    })
    .where(eq(expertProfiles.id, expert.id));

  return {
    walletId: wallet.id,
    companyId,
    expertProfileId: expert.id,
    memberId: member.id,
  };
}

/** A wallet that may enter overdraft grace — states BOTH facts, at the call site, every time. */
const GRACE_CAPABLE = { mandate: true, lowBalanceMode: 'keep_going' } as const;

describe('setup() fixture contract — BAL-523', () => {
  it('⚠ FIXTURE GUARD: setup({ mandate: true }) alone must NOT produce a grace-capable wallet', async () => {
    const ctx = await setup({ balanceMinor: 500, mandate: true }); // no lowBalanceMode option
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    if (wallet === undefined) throw new Error('seed failed');
    expect(wallet.lowBalanceMode).toBe('notify_only'); // the schema default
    expect(isWalletMandateActive(wallet)).toBe(true); // …with a live mandate
    expect(walletAllowsOverdraftGrace(wallet)).toBe(false); // …and STILL no grace
  });
});

/** `open` a session, asserting acceptance, and return the created session id. */
async function openOk(
  ctx: { walletId: string; companyId: string; expertProfileId: string; memberId: string },
  estimatedMinutes = 10
): Promise<string> {
  const res = await creditSessionsRepository.open({
    walletId: ctx.walletId,
    companyId: ctx.companyId,
    expertProfileId: ctx.expertProfileId,
    initiatingMemberId: ctx.memberId,
    estimatedMinutes,
  });
  if (!res.ok) {
    throw new Error(`expected open ok, got ${res.code}`);
  }
  return res.session.id;
}

/** Seed a real ledger credit (drives `balance_minor` through `applyLedgerEntry`). */
async function credit(
  walletId: string,
  reason: 'promo' | 'manual_purchase',
  amountMinor: number,
  memberId?: string
): Promise<void> {
  await creditLedgerRepository.postEntry({
    walletId,
    entryType: reason === 'promo' ? 'adjustment' : 'purchase',
    reason,
    amountMinor,
    idempotencyKey: `${reason}:${walletId}:${amountMinor}`,
    memberId: reason === 'manual_purchase' ? memberId : undefined,
  });
}

// ── open — the pre-connect funds/mandate gate ─────────────────────────────

describe('creditSessionsRepository.open — gate', () => {
  it('accepts on sufficient available balance (no mandate) and snapshots rates + hold', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const s = res.session;
    expect(s.status).toBe('pending');
    expect(s.settlementStatus).toBe('not_required');
    expect(s.clientRateMinorPerMinute).toBe(CLIENT_RATE_PER_MIN); // 250
    expect(s.expertRateMinorPerMinute).toBe(EXPERT_RATE_PER_MIN); // 200
    expect(s.expertRateMinorPerHour).toBe(EXPERT_HOURLY);
    expect(s.baloFeeBps).toBe(DEFAULT_BALO_FEE_BPS);
    expect(s.effectiveCeilingMinor).toBe(DEFAULT_OVERDRAFT_CEILING_MINOR);
    expect(s.graceBoundMinutes).toBe(30);
    expect(s.holdId).not.toBeNull();

    // The hold reserves estimatedMinutes × clientRate and is linked back to the session.
    const [hold] = await db.select().from(creditHolds).where(eq(creditHolds.id, s.holdId!));
    expect(hold?.amountMinor).toBe(10 * CLIENT_RATE_PER_MIN); // 2500
    expect(hold?.status).toBe('active');
    expect(hold?.sessionId).toBe(s.id);
  });

  it('rejects insufficient_no_mandate when the estimate is unfunded and no mandate exists', async () => {
    const ctx = await setup({ balanceMinor: 1000 }); // estimate 10×250 = 2500 > 1000
    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
    });
    expect(res).toEqual<OpenSessionResult>({ ok: false, code: 'insufficient_no_mandate' });
    // No hold left behind on a rejected open (txn rolled back).
    expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(0);
  });

  // ⚠ R9 — the title used to say "(the grace path)". `setup()` leaves `lowBalanceMode` at its
  // `notify_only` schema default, so post-BAL-523 this wallet is precisely one that will NOT
  // enter grace. What it proves is the CONNECT GATE, which is mandate-only by the 2026-09-04
  // ruling — the grace path is pinned by the ⚠ BAL-523 test just below.
  it('accepts a zero-balance wallet WITH an active mandate (the connect gate is mandate-only)', async () => {
    const ctx = await setup({ balanceMinor: 0, mandate: true });
    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
    });
    expect(res.ok).toBe(true);
  });

  /**
   * ⚠⚠ BAL-523, THE EXECUTABLE STATEMENT OF THE 2026-09-04 RULING. The connect gate is
   * MANDATE-ONLY and must stay that way: `openCaseSessionBestEffort` may never fail a join, so a
   * refusal here creates NO session row — the consultation happens, nothing meters and the expert
   * is unpaid. So a `notify_only` client with a live mandate and an UNFUNDED estimate OPENS and
   * METERS normally, and BAL-523's promise is delivered entirely at the far end: the meter
   * refuses grace at zero and warm-wraps instead of carrying them onto the card.
   *
   * If anyone re-tightens `open()` on `walletAllowsOverdraftGrace`, the first half of this test
   * fails. If anyone loosens grace entry back to the mandate alone, the second half fails.
   */
  it('⚠ BAL-523: a notify_only wallet with a LIVE mandate and an UNFUNDED estimate OPENS, then warm-wraps at zero without entering grace', async () => {
    // balance 500, estimate 10×250 = 2500 ⇒ unfunded; mandate live, mode `notify_only`.
    const ctx = await setup({ balanceMinor: 500, mandate: true, lowBalanceMode: 'notify_only' });
    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    await creditSessionsRepository.connect(res.session.id, { now: BASE });
    // min1 250, min2 0, min3 would cross to −250 → refused, wrapped, nothing posted.
    const metered = await creditSessionsRepository.meterSessionToNow(res.session.id, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    expect(metered.session.status).toBe('wrapped');
    expect(metered.transitions.graceEntered).toBeUndefined();
    expect(metered.session.graceEnteredAt).toBeNull();
    expect(await walletBalance(ctx.walletId)).toBe(0); // never carried past zero
  });

  it('rejects account_hold when the company has an open receivable', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    // Posit a prior failed session's open receivable.
    const priorSessionId = await openOk(ctx);
    await creditReceivablesRepository.open({
      companyId: ctx.companyId,
      walletId: ctx.walletId,
      sessionId: priorSessionId,
      amountMinor: 500,
      reason: 'settlement_declined',
    });

    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
    });
    expect(res).toEqual<OpenSessionResult>({ ok: false, code: 'account_hold' });
  });

  it('rejects expert_rate_missing when the expert has no rate (Q9 hard-stop)', async () => {
    const ctx = await setup({ balanceMinor: 50_000, expertHourlyCents: null });
    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
    });
    expect(res).toEqual<OpenSessionResult>({ ok: false, code: 'expert_rate_missing' });
  });
});

// ── open — one live session per wallet (concurrency / double-charge guard) ─

describe('creditSessionsRepository.open — one live session per wallet', () => {
  function openAgain(ctx: {
    walletId: string;
    companyId: string;
    expertProfileId: string;
    memberId: string;
  }): Promise<OpenSessionResult> {
    return creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
    });
  }

  it('rejects session_in_progress while an ACTIVE session exists on the wallet', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });

    const second = await openAgain(ctx);
    expect(second).toEqual<OpenSessionResult>({ ok: false, code: 'session_in_progress' });
    // The rejected open rolled back — only the first session's hold remains active.
    expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(
      10 * CLIENT_RATE_PER_MIN
    );
  });

  it('rejects session_in_progress while a PENDING (never-connected) session is live', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    await openOk(ctx, 10); // stays pending

    const second = await openAgain(ctx);
    expect(second).toEqual<OpenSessionResult>({ ok: false, code: 'session_in_progress' });
  });

  it('allows a new session once the prior one is CANCELLED (terminal)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.cancel(id, { memberId: ctx.memberId });

    const next = await openAgain(ctx);
    expect(next.ok).toBe(true);
  });

  it('allows a new session once the prior one has ENDED (terminal)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    await creditSessionsRepository.end(id, { now: meterAt(3) });

    const next = await openAgain(ctx);
    expect(next.ok).toBe(true);
  });
});

// ── open — settlement-pending gate (SEQUENTIAL overdraft co-charge guard) ──
//
// `end(A)` computes `overdraftMinor = −balance` (the WHOLE wallet negative) and DEFERS the
// settlement CREDIT to the async `payment_intent.succeeded` webhook (the sole crediting
// authority), so the wallet stays NEGATIVE (settlementStatus='processing') until PI_A lands.
// By then A is `ended` (no `session_in_progress`) with NO receivable yet — so WITHOUT this gate,
// `open(B)` would proceed on a still-negative wallet, B would draw further, and `end(B)` would
// fold A's uncredited overdraft into B's terminal negative → A's overdraft charged a SECOND time.
// The gate blocks any new open while `balance < 0`.

describe('creditSessionsRepository.open — settlement-pending gate', () => {
  function openAgain(ctx: {
    walletId: string;
    companyId: string;
    expertProfileId: string;
    memberId: string;
  }): Promise<OpenSessionResult> {
    return creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
    });
  }

  /** Drive a session to a terminal overdraft: ended, settlementStatus='processing', balance −1000. */
  async function endWithProcessingOverdraft(ctx: {
    walletId: string;
    companyId: string;
    expertProfileId: string;
    memberId: string;
  }): Promise<{ sessionId: string; overdraftMinor: number }> {
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(24), {
      floorMinutes: METER_FLOOR_MINUTES,
    }); // 24×250=6000 vs 5000 → −1000
    const end = await creditSessionsRepository.end(id, { now: meterAt(24) });
    expect(end.overdraftMinor).toBe(1000);
    expect(end.session.settlementStatus).toBe('processing');
    return { sessionId: id, overdraftMinor: end.overdraftMinor };
  }

  it('rejects settlement_pending while a prior overdraft is unsettled (balance < 0, no receivable)', async () => {
    const ctx = await setup({
      balanceMinor: 5000,
      ...GRACE_CAPABLE,
      overdraftCeilingMinor: 100_000,
    });
    await endWithProcessingOverdraft(ctx);

    // The prior session is ENDED (no session_in_progress) and there is NO open receivable — the
    // ONLY thing wrong is the still-negative balance (settlement in flight).
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    expect(wallet?.balanceMinor).toBe(-1000);
    expect(await creditReceivablesRepository.hasOpenReceivable(ctx.companyId)).toBe(false);

    const blocked = await openAgain(ctx);
    expect(blocked).toEqual<OpenSessionResult>({ ok: false, code: 'settlement_pending' });
    // The rejected open rolled back — no stray hold for a phantom second session.
    expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(0);
  });

  it('rejects settlement_pending on the processing predicate even when a positive credit masks the negative balance', async () => {
    const ctx = await setup({
      balanceMinor: 5000,
      ...GRACE_CAPABLE,
      overdraftCeilingMinor: 100_000,
    });
    const { sessionId, overdraftMinor } = await endWithProcessingOverdraft(ctx); // −1000, processing

    // An INDEPENDENT positive credit (manual_purchase / auto_topup — handlers built this lane)
    // lands during the processing window and pushes the balance NON-negative, masking A's still-
    // uncredited overdraft. The overdraft settlement itself has NOT landed: A is still
    // `settlementStatus='processing'`. A balance-only gate would now pass and let B open, whose
    // terminal `end` would fold A's overdraft in and charge it a SECOND time.
    await credit(ctx.walletId, 'manual_purchase', overdraftMinor + 1000, ctx.memberId); // +2000
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    expect(wallet?.balanceMinor).toBe(1000); // ≥ 0 — the proxy is defeated
    expect(await creditReceivablesRepository.hasOpenReceivable(ctx.companyId)).toBe(false);
    const sessionA = await creditSessionsRepository.findById(sessionId);
    expect(sessionA?.settlementStatus).toBe('processing'); // A's overdraft is STILL unsettled

    // The processing-predicate gate blocks the open despite the non-negative balance (this fails
    // against the old balance-only guard, passes with the fix).
    const blocked = await openAgain(ctx);
    expect(blocked).toEqual<OpenSessionResult>({ ok: false, code: 'settlement_pending' });
    expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(0);
  });

  it('allows a new session once the settlement credit lands (balance back to exactly 0)', async () => {
    const ctx = await setup({
      balanceMinor: 5000,
      ...GRACE_CAPABLE,
      overdraftCeilingMinor: 100_000,
    });
    const { sessionId, overdraftMinor } = await endWithProcessingOverdraft(ctx);

    // Simulate the payment_intent.succeeded webhook: the overdraft_settlement credit (== overdraft
    // in the AUD-only model) returns the balance to exactly 0, and the session is marked settled.
    await creditLedgerRepository.postEntry({
      walletId: ctx.walletId,
      entryType: 'purchase',
      reason: 'overdraft_settlement',
      amountMinor: overdraftMinor,
      idempotencyKey: `overdraft_settlement:${sessionId}`,
      memberId: ctx.memberId,
      sessionId,
    });
    await creditSessionsRepository.markSettlementResult(db, {
      sessionId,
      status: 'settled',
      stripePaymentIntentId: 'pi_settle_seq',
    });
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    expect(wallet?.balanceMinor).toBe(0);

    const next = await openAgain(ctx);
    expect(next.ok).toBe(true);
  });

  it('sanity: a normal open on a non-negative wallet (no session, no receivable) still succeeds', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const res = await openAgain(ctx);
    expect(res.ok).toBe(true);
  });

  it('account_hold WINS over settlement_pending when a failed settlement left a receivable', async () => {
    const ctx = await setup({
      balanceMinor: 5000,
      ...GRACE_CAPABLE,
      overdraftCeilingMinor: 100_000,
    });
    const { sessionId, overdraftMinor } = await endWithProcessingOverdraft(ctx);

    // The settlement FAILED → a receivable is opened while the balance is still negative, so BOTH
    // gate conditions hold (open receivable AND balance < 0).
    await creditReceivablesRepository.open({
      companyId: ctx.companyId,
      walletId: ctx.walletId,
      sessionId,
      amountMinor: overdraftMinor,
      reason: 'settlement_declined',
    });
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    expect(wallet?.balanceMinor).toBe(-1000);

    // The soft-hold gate (step 2) is evaluated before the settlement-pending gate (step 2c), so
    // account_hold wins — both are correct blocks; this pins the deterministic ordering.
    const blocked = await openAgain(ctx);
    expect(blocked).toEqual<OpenSessionResult>({ ok: false, code: 'account_hold' });
  });
});

// ── connect ────────────────────────────────────────────────────────────

describe('creditSessionsRepository.connect', () => {
  it('moves pending → active, stamping connectedAt; idempotent on active', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);

    const active = await creditSessionsRepository.connect(id, { now: BASE });
    expect(active.status).toBe('active');
    expect(active.connectedAt?.getTime()).toBe(BASE.getTime());

    // Re-connect is idempotent and does NOT re-anchor the clock.
    const again = await creditSessionsRepository.connect(id, { now: meterAt(5) });
    expect(again.status).toBe('active');
    expect(again.connectedAt?.getTime()).toBe(BASE.getTime());
  });

  it('throws on connecting an ended session (illegal transition)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.end(id, { now: meterAt(1) });
    await expect(creditSessionsRepository.connect(id)).rejects.toBeInstanceOf(
      InvalidSessionTransitionError
    );
  });
});

// ── meterSessionToNow ─────────────────────────────────────────────────────

describe('creditSessionsRepository.meterSessionToNow — tick posting + idempotency', () => {
  it('posts one session_consume tick per whole minute and advances counters', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await creditSessionsRepository.connect(id, { now: BASE });

    const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    expect(res.ticksPosted).toBe(3);
    expect(res.session.lastTickSeq).toBe(3);
    expect(res.session.connectedMinutes).toBe(3);
    expect(res.session.expertAccruedMinor).toBe(3 * EXPERT_RATE_PER_MIN); // 600
    expect(res.session.status).toBe('active');

    // Balance dropped by 3 × client rate; three consume ledger rows exist.
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    expect(res.session.connectedMinutes * CLIENT_RATE_PER_MIN).toBe(750);
    const ledger = await creditLedgerRepository.listByWallet(ctx.walletId);
    expect(ledger.filter((r) => r.reason === 'session_consume')).toHaveLength(3);
    expect(wallet?.balanceMinor).toBe(50_000 - 750);
  });

  it('re-metering to the same instant posts nothing (idempotent tickSeq)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await creditSessionsRepository.connect(id, { now: BASE });

    await creditSessionsRepository.meterSessionToNow(id, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    const again = await creditSessionsRepository.meterSessionToNow(id, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    expect(again.ticksPosted).toBe(0);
    expect(again.transitions).toEqual({});
    expect(again.session.lastTickSeq).toBe(3);

    const consumes = (await creditLedgerRepository.listByWallet(ctx.walletId)).filter(
      (r) => r.reason === 'session_consume'
    );
    expect(consumes).toHaveLength(3); // not doubled
  });

  it('sets the one-shot lowWarnedAt marker exactly once', async () => {
    // balance 2000 → runway 8 min at 250/min; low fires the first tick runway ≤ 8.
    const ctx = await setup({ balanceMinor: 2000 });
    const id = await openOk(ctx, 4);
    await creditSessionsRepository.connect(id, { now: BASE });

    const first = await creditSessionsRepository.meterSessionToNow(id, meterAt(1), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    expect(first.transitions.low).toBe(true);
    const marker = first.session.lowWarnedAt?.getTime();
    expect(marker).toBeDefined();

    const second = await creditSessionsRepository.meterSessionToNow(id, meterAt(2), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    expect(second.transitions.low).toBeUndefined(); // not re-crossed
    expect(second.session.lowWarnedAt?.getTime()).toBe(marker); // unchanged
  });

  /**
   * ⚠⚠ F13/D6 — THE LOW-BALANCE TRIGGER USES `minutesOfRunway`, NOT `floor(balance / rate)`.
   *
   * This was the THIRD copy of the runway formula and the one that actually FIRES the notice
   * (`lowWarnedAt` → `transitions.low` → `session.low_balance`). While the uncorrected copy
   * lived here the system had a SPLIT BRAIN: `DrawdownState` flipped the panel to `low` early
   * (corrected) while the notification still fired on the old, later threshold — and when it
   * did fire, `publishLowBalance` reported the corrected, SMALLER figure. A member was told
   * "About 0 minutes of balance left" at the moment the trigger thought they had 8.
   *
   * The three cases below pin BOTH halves of the correction on the SAME session state.
   */
  describe('the low-balance trigger is the ONE minutesOfRunway formula (F13/D6)', () => {
    it('fires EARLY, inside the floor — the uncorrected formula would not have crossed yet', async () => {
      // rate 250/min. After tick 1: balance = 5000 − 250 = 4750, drawn = 1.
      //   uncorrected: floor(4750 / 250) = 19  → 19 > 8  ⇒ would NOT fire.
      //   corrected:   unconsumed floor = 15 − 1 = 14 ⇒ committed 3500
      //                ⇒ discretionary 1250 ⇒ 5 ≤ 8    ⇒ FIRES.
      const ctx = await setup({ balanceMinor: 5000 });
      const id = await openOk(ctx);
      await creditSessionsRepository.connect(id, { now: BASE });

      const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(1), {
        floorMinutes: METER_FLOOR_MINUTES,
      });
      expect(res.session.lastTickSeq).toBe(1);
      expect(Math.floor((5000 - 250) / 250)).toBeGreaterThan(8); // the OLD threshold: no cross
      expect(res.transitions.low).toBe(true); // the CORRECTED one: crossed
      expect(res.session.lowWarnedAt).not.toBeNull();
    });

    it('floorMinutes is a PARAMETER — at floorMinutes=0 the same state reduces to the old formula', async () => {
      // Identical state, floor injected as 0 ⇒ `minutesOfRunway` reduces bit-for-bit to
      // `floor(balance / rate)` = 19, which is > 8 ⇒ NO warning. Proves the earlier crossing
      // above comes from the floor correction and nothing else.
      const ctx = await setup({ balanceMinor: 5000 });
      const id = await openOk(ctx);
      await creditSessionsRepository.connect(id, { now: BASE });

      const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(1), {
        floorMinutes: 0,
      });
      expect(res.session.lastTickSeq).toBe(1);
      expect(res.transitions.low).toBeUndefined();
      expect(res.session.lowWarnedAt).toBeNull();
    });

    it('past the floor the corrected formula is a NO-OP — drawn ≥ floor sets nothing aside', async () => {
      // 16 ticks at 250 from 10_000 ⇒ balance 6000, drawn 16 ≥ floor 15 ⇒ committed 0 ⇒
      // runway = floor(6000/250) = 24 > 8 ⇒ no warning, exactly as before BAL-412.
      const ctx = await setup({ balanceMinor: 10_000 });
      const id = await openOk(ctx);
      await creditSessionsRepository.connect(id, { now: BASE });

      const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(16), {
        floorMinutes: METER_FLOOR_MINUTES,
      });
      expect(res.session.lastTickSeq).toBe(16);
      expect(res.transitions.low).toBeUndefined();
      expect(res.session.lowWarnedAt).toBeNull();
    });
  });
});

describe('creditSessionsRepository.meterSessionToNow — grace / wrap state machine', () => {
  it('enters grace with an active mandate AND a card-backed mode, posting the crossing (negative) tick', async () => {
    // balance 500 → min1 250, min2 0, min3 crosses to −250 → grace.
    const ctx = await setup({
      balanceMinor: 500,
      ...GRACE_CAPABLE,
      overdraftCeilingMinor: 100_000,
    });
    const id = await openOk(ctx, 2);
    await creditSessionsRepository.connect(id, { now: BASE });

    const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    expect(res.session.status).toBe('grace');
    expect(res.transitions.graceEntered).toBe(true);
    expect(res.session.graceEnteredAt).not.toBeNull();
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    expect(wallet?.balanceMinor).toBe(-250); // overdraft posted
    expect(res.session.connectedMinutes).toBe(3);
  });

  it('stops WITHOUT overdraft at zero when there is NO mandate (wrapped, no grace)', async () => {
    // balance 500, no mandate → min1 250, min2 0, min3 would cross → STOP (no tick, wrapped).
    const ctx = await setup({ balanceMinor: 500, mandate: false });
    const id = await openOk(ctx, 2);
    await creditSessionsRepository.connect(id, { now: BASE });

    const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    expect(res.session.status).toBe('wrapped');
    expect(res.transitions.wrapped).toBe(true);
    expect(res.transitions.graceEntered).toBeUndefined();
    expect(res.session.graceEnteredAt).toBeNull();
    expect(res.session.lastTickSeq).toBe(2); // the crossing minute was NOT posted
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    expect(wallet?.balanceMinor).toBe(0); // never went negative
  });

  it('⚠ BAL-523: stops WITHOUT overdraft at zero when the mandate is LIVE but the mode is notify_only', async () => {
    // balance 500, mandate live but notify_only → min1 250, min2 0, min3 would cross → STOP.
    const ctx = await setup({ balanceMinor: 500, mandate: true, lowBalanceMode: 'notify_only' });
    const id = await openOk(ctx, 2);
    await creditSessionsRepository.connect(id, { now: BASE });

    const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    expect(res.session.status).toBe('wrapped');
    expect(res.transitions.wrapped).toBe(true);
    expect(res.transitions.graceEntered).toBeUndefined();
    expect(res.session.graceEnteredAt).toBeNull();
    expect(res.session.lastTickSeq).toBe(2); // the crossing minute was NOT posted
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    expect(wallet?.balanceMinor).toBe(0); // never went negative
  });

  it('wraps at the overdraft ceiling (ceilingHit), charging the completing minute (≤1-min overshoot)', async () => {
    // ceiling 500: min1 250, min2 0, min3 grace −250, min4 −500 (|−500| ≥ 500) → wrap.
    const ctx = await setup({ balanceMinor: 500, ...GRACE_CAPABLE, overdraftCeilingMinor: 500 });
    const id = await openOk(ctx, 2);
    await creditSessionsRepository.connect(id, { now: BASE });

    const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(6), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    expect(res.session.status).toBe('wrapped');
    expect(res.transitions.ceilingHit).toBe(true);
    expect(res.transitions.wrapped).toBe(true);
    expect(res.session.lastTickSeq).toBe(4); // stopped ON the ceiling-crossing minute
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    expect(wallet?.balanceMinor).toBe(-500);
  });

  it('wraps on the 30-min (grace-bound) timeout when the ceiling is not reached', async () => {
    const ctx = await setup({
      balanceMinor: 250,
      ...GRACE_CAPABLE,
      overdraftCeilingMinor: 1_000_000,
    });
    const id = await openOk(ctx, 1);
    await creditSessionsRepository.connect(id, { now: BASE });
    // Shrink the grace bound snapshot to 3 min for a fast, deterministic time-bound wrap.
    await db.update(creditSessions).set({ graceBoundMinutes: 3 }).where(eq(creditSessions.id, id));

    // min1 → 0, min2 → grace (−250), grace bound 3 min from min2 → wrap at min5.
    const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(8), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    expect(res.session.status).toBe('wrapped');
    expect(res.transitions.wrapped).toBe(true);
    expect(res.transitions.ceilingHit).toBeUndefined(); // time bound, not ceiling
    expect(res.session.lastTickSeq).toBe(5);
  });
});

// ── end — settlement basis + expert accrual ───────────────────────────────

describe('creditSessionsRepository.end — accrual, overdraft, promo exclusion', () => {
  it('promo is EXCLUDED from the settlement basis (overdraftSettledMinor = |terminal negative|)', async () => {
    const ctx = await setup({ ...GRACE_CAPABLE, overdraftCeilingMinor: 100_000 });
    // Single fungible balance = 3000 promo + 2000 paid = 5000; drain to a terminal −1000.
    await credit(ctx.walletId, 'promo', 3000);
    await credit(ctx.walletId, 'manual_purchase', 2000, ctx.memberId);

    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    // 24 min × 250 = 6000 charged; 6000 − 5000 = 1000 overdraft (pure cash; promo consumed first).
    await creditSessionsRepository.meterSessionToNow(id, meterAt(24), {
      floorMinutes: METER_FLOOR_MINUTES,
    });

    const end = await creditSessionsRepository.end(id, { now: meterAt(24) });
    expect(end.overdraftMinor).toBe(1000);
    expect(end.session.overdraftSettledMinor).toBe(1000); // NOT 1000 + 3000 promo
    expect(end.session.settlementStatus).toBe('processing');
    expect(end.session.status).toBe('ended');
    expect(end.mandateActive).toBe(true);
  });

  it('finalizes the expert accrual + writes the expert_accrued audit row EVEN WITH overdraft', async () => {
    const ctx = await setup({
      balanceMinor: 5000,
      ...GRACE_CAPABLE,
      overdraftCeilingMinor: 100_000,
    });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(24), {
      floorMinutes: METER_FLOOR_MINUTES,
    }); // drains to −1000

    const end = await creditSessionsRepository.end(id, { now: meterAt(24) });
    expect(end.overdraftMinor).toBe(1000);
    // Expert paid for every connected minute, independent of the (unsettled) client overdraft.
    expect(end.expertAccruedMinor).toBe(24 * EXPERT_RATE_PER_MIN); // 4800
    expect(end.session.expertAccruedMinor).toBe(4800);

    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, 'credit_session'),
          eq(auditEvents.entityId, id),
          eq(auditEvents.action, 'credit_session.expert_accrued')
        )
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(ctx.memberId);
    expect(audits[0]?.metadata).toMatchObject({
      expertProfileId: ctx.expertProfileId,
      connectedMinutes: 24,
      expertAccruedMinor: 4800,
    });
  });

  it('sets settlementStatus=not_required with no overdraft, and releases the hold', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    });

    const end = await creditSessionsRepository.end(id, { now: meterAt(3) });
    expect(end.overdraftMinor).toBe(0);
    expect(end.session.settlementStatus).toBe('not_required');
    // Hold released → no active reservation remains.
    expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(0);
  });

  it('is idempotent on an already-ended session (no duplicate accrual audit)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(2), {
      floorMinutes: METER_FLOOR_MINUTES,
    });

    const first = await creditSessionsRepository.end(id, { now: meterAt(2) });
    expect(first.alreadyEnded).toBe(false);
    const second = await creditSessionsRepository.end(id, { now: meterAt(2) });
    expect(second.alreadyEnded).toBe(true);

    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.entityId, id), eq(auditEvents.action, 'credit_session.expert_accrued'))
      );
    expect(audits).toHaveLength(1); // not duplicated
  });
});

// ── markSettlementResult / cancel ─────────────────────────────────────────

describe('creditSessionsRepository.markSettlementResult', () => {
  it('marks settled, stamping settledAt + the PaymentIntent', async () => {
    const ctx = await setup({
      balanceMinor: 5000,
      ...GRACE_CAPABLE,
      overdraftCeilingMinor: 100_000,
    });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(24), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    await creditSessionsRepository.end(id, { now: meterAt(24) });

    const marked = await creditSessionsRepository.markSettlementResult(db, {
      sessionId: id,
      status: 'settled',
      stripePaymentIntentId: 'pi_settle',
      now: meterAt(25),
    });
    expect(marked.settlementStatus).toBe('settled');
    expect(marked.settledAt?.getTime()).toBe(meterAt(25).getTime());
    expect(marked.stripePaymentIntentId).toBe('pi_settle');
  });

  it('marks failed without stamping settledAt', async () => {
    const ctx = await setup({
      balanceMinor: 5000,
      ...GRACE_CAPABLE,
      overdraftCeilingMinor: 100_000,
    });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(24), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    await creditSessionsRepository.end(id, { now: meterAt(24) });

    const marked = await creditSessionsRepository.markSettlementResult(db, {
      sessionId: id,
      status: 'failed',
    });
    expect(marked.settlementStatus).toBe('failed');
    expect(marked.settledAt).toBeNull();
  });
});

describe('creditSessionsRepository.cancel', () => {
  it('cancels a pending session and releases its hold; idempotent', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(
      10 * CLIENT_RATE_PER_MIN
    );

    const cancelled = await creditSessionsRepository.cancel(id, { memberId: ctx.memberId });
    expect(cancelled.status).toBe('cancelled');
    expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(0);

    const again = await creditSessionsRepository.cancel(id);
    expect(again.status).toBe('cancelled'); // idempotent
  });

  it('throws when cancelling an active (already-connected) session', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await expect(creditSessionsRepository.cancel(id)).rejects.toBeInstanceOf(
      InvalidSessionTransitionError
    );
  });
});

// ── reads / projection / reaper finders ───────────────────────────────────

describe('creditSessionsRepository — reads + fee/PII projection', () => {
  it('findForClientView excludes the fee/PII columns (no-RLS projection boundary)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);

    const view = await creditSessionsRepository.findForClientView(id);
    expect(view).toBeDefined();
    const keys = Object.keys(view!);
    for (const banned of [
      'expertRateMinorPerHour',
      'expertRateMinorPerMinute',
      'baloFeeBps',
      'expertAccruedMinor',
      'stripePaymentIntentId',
    ]) {
      expect(keys).not.toContain(banned);
      expect(CLIENT_SESSION_VIEW_COLUMNS).not.toHaveProperty(banned);
    }
    // Client-safe fields ARE present.
    expect(keys).toContain('clientRateMinorPerMinute');
    expect(keys).toContain('status');
  });

  it('findById returns undefined for an unknown id; throws SessionNotFoundError on connect', async () => {
    expect(
      await creditSessionsRepository.findById('00000000-0000-0000-0000-000000000000')
    ).toBeUndefined();
    await expect(
      creditSessionsRepository.connect('00000000-0000-0000-0000-000000000000')
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('findMeterable returns active + grace sessions only', async () => {
    const ctxActive = await setup({ balanceMinor: 50_000 });
    const activeId = await openOk(ctxActive, 10);
    await creditSessionsRepository.connect(activeId, { now: BASE });
    // A pending session on its OWN wallet (one live session per wallet is enforced by `open`).
    const ctxPending = await setup({ balanceMinor: 50_000 });
    const pendingId = await openOk(ctxPending, 10); // stays pending

    const meterable = await creditSessionsRepository.findMeterable();
    const ids = meterable.map((s) => s.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(pendingId);
  });

  it('findStalePending / findWrappedIdle / findStuckSettling match on the backdated cutoff', async () => {
    // Stale pending — its own wallet, backdate createdAt.
    const ctxPending = await setup({ balanceMinor: 50_000 });
    const pendingId = await openOk(ctxPending, 2);
    await db
      .update(creditSessions)
      .set({ createdAt: new Date(BASE.getTime() - 60 * 60_000) })
      .where(eq(creditSessions.id, pendingId));
    const stale = await creditSessionsRepository.findStalePending(BASE);
    expect(stale.map((s) => s.id)).toContain(pendingId);

    // Wrapped idle — its own low-balance, no-mandate wallet; drive to wrapped, backdate.
    const ctxWrapped = await setup({ balanceMinor: 500, mandate: false });
    const wrappedId = await openOk(ctxWrapped, 2);
    await creditSessionsRepository.connect(wrappedId, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(wrappedId, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    }); // → wrapped
    await db
      .update(creditSessions)
      .set({ wrappedAt: new Date(BASE.getTime() - 60 * 60_000) })
      .where(eq(creditSessions.id, wrappedId));
    const idle = await creditSessionsRepository.findWrappedIdle(BASE);
    expect(idle.map((s) => s.id)).toContain(wrappedId);

    // Stuck settling — end with overdraft (processing), backdate endedAt.
    const ctx2 = await setup({
      balanceMinor: 5000,
      ...GRACE_CAPABLE,
      overdraftCeilingMinor: 100_000,
    });
    const settleId = await openOk(ctx2, 10);
    await creditSessionsRepository.connect(settleId, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(settleId, meterAt(24), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    await creditSessionsRepository.end(settleId, { now: meterAt(24) });
    await db
      .update(creditSessions)
      .set({ endedAt: new Date(BASE.getTime() - 60 * 60_000) })
      .where(eq(creditSessions.id, settleId));
    const stuck = await creditSessionsRepository.findStuckSettling(BASE);
    expect(stuck.map((s) => s.id)).toContain(settleId);
  });
});

// ── BAL-399: money-block views, finalize stamping, external duration, reaper guards ────────

/** Flip a session to `external` provenance (the meeting layer sets this at open, ADR-1043). */
async function markExternal(sessionId: string): Promise<void> {
  await db
    .update(creditSessions)
    .set({ durationSource: 'external' })
    .where(eq(creditSessions.id, sessionId));
}

describe('creditSessionsRepository — money-block lens projections (BAL-399)', () => {
  it('findForExpertView returns own-earnings columns and excludes client rate / fee / overdraft / Stripe', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);

    const view = await creditSessionsRepository.findForExpertView(id);
    expect(view).toBeDefined();
    const keys = Object.keys(view!);
    for (const banned of [
      'clientRateMinorPerMinute',
      'baloFeeBps',
      'overdraftSettledMinor',
      'stripePaymentIntentId',
    ]) {
      expect(keys).not.toContain(banned);
    }
    expect(keys).toContain('expertRateMinorPerMinute');
    expect(keys).toContain('expertAccruedMinor');
    expect(keys).toContain('billingFinalizedAt');
  });

  it('findForAdminView returns the full row (fee + accrual visible)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);

    const view = await creditSessionsRepository.findForAdminView(id);
    expect(view).toBeDefined();
    expect(view!.baloFeeBps).toBe(DEFAULT_BALO_FEE_BPS);
    expect(view).toHaveProperty('expertAccruedMinor');
    expect(view).toHaveProperty('stripePaymentIntentId');
  });
});

// ── BAL-441: the statement-context projected read ───────────────────────────────────────────

describe('creditSessionsRepository.findStatementContext (BAL-441)', () => {
  it('returns the full context: names, org, case title, meeting/engagement ids', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const agency = await agencyFactory();
    await db
      .update(expertProfiles)
      .set({ agencyId: agency.id, type: 'agency' })
      .where(eq(expertProfiles.id, ctx.expertProfileId));
    const { engagement } = await caseEngagementFactory({
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      caseValues: { title: 'Static analysis walkthrough' },
    });
    const { meeting } = await meetingFactory();
    const id = await openOk(ctx, 10);
    await db
      .update(creditSessions)
      .set({ meetingId: meeting.id, engagementId: engagement.id })
      .where(eq(creditSessions.id, id));

    const row = await creditSessionsRepository.findStatementContext(id);
    expect(row).toBeDefined();
    expect(row!.companyName.length).toBeGreaterThan(0);
    expect(row!.caseTitle).toBe('Static analysis walkthrough');
    expect(row!.agencyName).toBe(agency.name);
    expect(row!.expertProfileType).toBe('agency');
    expect(row!.meetingId).toBe(meeting.id);
    expect(row!.expertFirstName).not.toBeNull();
  });

  it('NULL engagement_id -> caseTitle: null; NULL agency_id -> agencyName: null', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);

    const row = await creditSessionsRepository.findStatementContext(id);
    expect(row).toBeDefined();
    expect(row!.caseTitle).toBeNull();
    expect(row!.agencyName).toBeNull();
    expect(row!.meetingId).toBeNull();
  });

  // ── Soft-delete on the JOINED tables (security audit). Both predicates live in the join `ON`
  // clause, never the `WHERE` — in a `WHERE` they would turn each LEFT JOIN into an INNER one and
  // 404 an otherwise-valid receipt. The stake is not tidiness: without them a closed account's
  // name and a deleted case's title keep rendering on the receipt AND inside the downloadable
  // PDF, so personal data survives a deletion signal in a forwardable file.
  it('a soft-deleted expert USER -> name nulled, but the statement row still resolves', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);

    const [profile] = await db
      .select({ userId: expertProfiles.userId })
      .from(expertProfiles)
      .where(eq(expertProfiles.id, ctx.expertProfileId));
    // Narrow by guard, never `profile!` — SonarCloud analyses without `noUncheckedIndexedAccess`
    // and reports an index-position non-null assertion as "unnecessary" (a false positive that
    // still fails the gate). CLAUDE.md: fix by destructure + guard.
    if (profile === undefined) throw new Error('expected the expert profile row');
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, profile.userId));

    const row = await creditSessionsRepository.findStatementContext(id);
    // The ROW must survive — a deleted expert must not 404 the client's own receipt.
    expect(row).toBeDefined();
    expect(row!.expertFirstName).toBeNull();
    expect(row!.expertLastName).toBeNull();
  });

  it('a soft-deleted CASE -> caseTitle nulled, but the statement row still resolves', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const { engagement } = await caseEngagementFactory({
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      caseValues: { title: 'Static analysis walkthrough' },
    });
    const id = await openOk(ctx, 10);
    await db
      .update(creditSessions)
      .set({ engagementId: engagement.id })
      .where(eq(creditSessions.id, id));

    // Sanity: the title IS projected before the soft delete, so the assertion below is real.
    const before = await creditSessionsRepository.findStatementContext(id);
    expect(before!.caseTitle).toBe('Static analysis walkthrough');

    await db
      .update(caseEngagements)
      .set({ deletedAt: new Date() })
      .where(eq(caseEngagements.engagementId, engagement.id));

    const row = await creditSessionsRepository.findStatementContext(id);
    expect(row).toBeDefined();
    expect(row!.caseTitle).toBeNull();
  });

  it('a soft-deleted session -> undefined', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await db.update(creditSessions).set({ deletedAt: new Date() }).where(eq(creditSessions.id, id));

    expect(await creditSessionsRepository.findStatementContext(id)).toBeUndefined();
  });

  it('the row carries NO rate, email, or workosId key (fee/PII projection boundary)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);

    const row = await creditSessionsRepository.findStatementContext(id);
    expect(row).toBeDefined();
    const keys = Object.keys(row!);
    for (const banned of ['rateCents', 'email', 'workosId', 'expertAccruedMinor', 'baloFeeBps']) {
      expect(keys).not.toContain(banned);
    }
  });
});

describe('creditSessionsRepository.end — billing-finalization stamping (BAL-399)', () => {
  it('stamps billingFinalizedAt + finalizationPath=live_capture by default', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    const end = await creditSessionsRepository.end(id, { now: meterAt(3) });

    expect(end.session.billingFinalizedAt).not.toBeNull();
    expect(end.session.finalizationPath).toBe('live_capture');
  });

  it('records an explicit finalizationPath (external/BAL-133 finalizer)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(2), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    const end = await creditSessionsRepository.end(id, {
      now: meterAt(2),
      finalizationPath: 'confirmed',
    });

    expect(end.session.finalizationPath).toBe('confirmed');
  });
});

describe('creditSessionsRepository — external duration lifecycle (BAL-399)', () => {
  it('parkAwaitingDuration releases the hold and parks the session as wrapped', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await markExternal(id);
    expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(
      10 * CLIENT_RATE_PER_MIN
    );

    const parked = await creditSessionsRepository.parkAwaitingDuration(id);
    expect(parked.status).toBe('wrapped');
    expect(parked.billingFinalizedAt).toBeNull();
    expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(0);

    // Idempotent.
    const again = await creditSessionsRepository.parkAwaitingDuration(id);
    expect(again.status).toBe('wrapped');
  });

  it('applyExternalDuration posts N consume ticks, draws the balance, and is idempotent', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await markExternal(id);
    await creditSessionsRepository.parkAwaitingDuration(id);

    const applied = await creditSessionsRepository.applyExternalDuration(id, 5);
    expect(applied.connectedMinutes).toBe(5);
    expect(applied.lastTickSeq).toBe(5);
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    expect(wallet?.balanceMinor).toBe(50_000 - 5 * CLIENT_RATE_PER_MIN);

    // Replay draws nothing new (ledger UNIQUE dedup).
    await creditSessionsRepository.applyExternalDuration(id, 5);
    const walletAfter = await creditWalletsRepository.findById(ctx.walletId);
    expect(walletAfter?.balanceMinor).toBe(50_000 - 5 * CLIENT_RATE_PER_MIN);

    // The subsequent end() finalizes the expert accrual off the drawn minutes.
    const end = await creditSessionsRepository.end(id, {
      now: meterAt(5),
      finalizationPath: 'confirmed',
    });
    expect(end.expertAccruedMinor).toBe(5 * EXPERT_RATE_PER_MIN);
    expect(end.overdraftMinor).toBe(0);
    expect(end.session.finalizationPath).toBe('confirmed');
  });

  it('draws the FULL confirmed minutes with no ceiling clamp (Owner Decision 3 → overdraft)', async () => {
    // Small balance + mandate: 30 min × 250 = 7500 vs 5000 balance → −2500 overdraft, no clamp.
    // ⚠ BAL-523 — deliberately NOT card-backed. The BAL-133 external finalizer draws the
    // confirmed minutes regardless of mode; only LIVE grace entry gained the mode conjunct. If
    // this ever starts failing, the mode conjunct has leaked into a settlement path.
    const ctx = await setup({ balanceMinor: 5000, mandate: true, overdraftCeilingMinor: 100 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await markExternal(id);
    await creditSessionsRepository.parkAwaitingDuration(id);

    await creditSessionsRepository.applyExternalDuration(id, 30);
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    expect(wallet?.balanceMinor).toBe(5000 - 30 * CLIENT_RATE_PER_MIN); // −2500, unclamped

    const end = await creditSessionsRepository.end(id, { now: meterAt(30) });
    expect(end.overdraftMinor).toBe(30 * CLIENT_RATE_PER_MIN - 5000); // 2500
    expect(end.expertAccruedMinor).toBe(30 * EXPERT_RATE_PER_MIN); // full minutes accrued
    // ⚠ BAL-523 ASYMMETRY, AT `end()` — the return that actually drives the live
    // `settleOverdraft`. This wallet is `notify_only` (the fixture default) with a live mandate
    // and a real 2500 overdraft, so a "consistency" sweep of `end()`'s `mandateActive` onto
    // `walletAllowsOverdraftGrace` would flip this to false and strand a collectable debt.
    expect(end.mandateActive).toBe(true);
  });

  it('bounds tick posting to ONCE — a second finalize with DIFFERENT minutes conflicts (TOCTOU)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await markExternal(id);
    await creditSessionsRepository.parkAwaitingDuration(id);

    // First confirmation draws 30 minutes and flips the session out of the parked state.
    const applied = await creditSessionsRepository.applyExternalDuration(id, 30);
    expect(applied.status).toBe('active');
    const walletAfterFirst = await creditWalletsRepository.findById(ctx.walletId);
    expect(walletAfterFirst?.balanceMinor).toBe(50_000 - 30 * CLIENT_RATE_PER_MIN);

    // A disagreeing second confirmation (45 min) must NOT post more ticks — it conflicts.
    await expect(creditSessionsRepository.applyExternalDuration(id, 45)).rejects.toBeInstanceOf(
      ExternalDurationConflictError
    );
    const walletAfterSecond = await creditWalletsRepository.findById(ctx.walletId);
    expect(walletAfterSecond?.balanceMinor).toBe(50_000 - 30 * CLIENT_RATE_PER_MIN); // unchanged

    // A same-value replay stays idempotent (no throw, no further draw).
    const replay = await creditSessionsRepository.applyExternalDuration(id, 30);
    expect(replay.connectedMinutes).toBe(30);
    const walletAfterReplay = await creditWalletsRepository.findById(ctx.walletId);
    expect(walletAfterReplay?.balanceMinor).toBe(50_000 - 30 * CLIENT_RATE_PER_MIN); // still once
  });
});

describe('creditSessionsRepository — reaper guards exclude external (BAL-399)', () => {
  it('findMeterable excludes an external active session', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await markExternal(id);

    const meterable = await creditSessionsRepository.findMeterable();
    expect(meterable.map((s) => s.id)).not.toContain(id);
  });

  it('findWrappedIdle excludes an external parked session', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await markExternal(id);
    await creditSessionsRepository.parkAwaitingDuration(id);
    await db
      .update(creditSessions)
      .set({ wrappedAt: new Date(BASE.getTime() - 60 * 60_000) })
      .where(eq(creditSessions.id, id));

    const idle = await creditSessionsRepository.findWrappedIdle(BASE);
    expect(idle.map((s) => s.id)).not.toContain(id);
  });
});

describe('creditSessionsRepository — displayed client charge == ledger-settled sum (BAL-399 invariant)', () => {
  it('the money-block amountAudMinor equals Σ session_consume debits, across funded + grace minutes', async () => {
    // 2 funded minutes (balance 500) then a mandate-backed grace/overdraft run — so at least one
    // metered minute is a grace/overdraft minute (balance driven negative), the case that would
    // expose any divergence between the DISPLAYED figure and the actual ledger draw.
    const ctx = await setup({
      balanceMinor: 500,
      ...GRACE_CAPABLE,
      overdraftCeilingMinor: 100_000,
    });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(5), {
      floorMinutes: METER_FLOOR_MINUTES,
    }); // 5 ticks; minutes 3-5 = grace
    await creditSessionsRepository.end(id, { now: meterAt(5) });

    // Wallet went negative — this exercised real grace/overdraft minutes.
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    expect(wallet?.balanceMinor).toBe(500 - 5 * CLIENT_RATE_PER_MIN); // −750

    // Ground truth: Σ of the session's `session_consume` debit amounts in the ledger.
    const ledgerRows = await db
      .select({ amountMinor: creditLedger.amountMinor })
      .from(creditLedger)
      .where(and(eq(creditLedger.sessionId, id), eq(creditLedger.reason, 'session_consume')));
    const ledgerDrawnMinor = ledgerRows.reduce((sum, row) => sum + Math.abs(row.amountMinor), 0);

    // The DISPLAYED client all-in, and the derived connectedMinutes × rate, must equal the ledger.
    const view = await creditSessionsRepository.findForClientMoneyView(id);
    expect(view).toBeDefined();
    const block = toClientMoneyBlock(view!);
    const derivedMinor = view!.connectedMinutes * view!.clientRateMinorPerMinute;

    expect(ledgerDrawnMinor).toBe(5 * CLIENT_RATE_PER_MIN); // 1250 — every minute drew the rate
    expect(derivedMinor).toBe(ledgerDrawnMinor); // connectedMinutes × rate == ledger sum
    expect(block.amountAudMinor).toBe(ledgerDrawnMinor); // displayed == ledger-settled sum
  });
});

describe('creditSessionsRepository.findFinalizedMissingPayout (BAL-399 reconciliation finder)', () => {
  /** Open → connect → meter → end a session (end() stamps billingFinalizedAt; no payout row yet). */
  async function finalizeSession(): Promise<{
    id: string;
    companyId: string;
    expertProfileId: string;
    expertAccruedMinor: number;
    connectedMinutes: number;
  }> {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    const ended = await creditSessionsRepository.end(id, { now: meterAt(3) });
    return {
      id,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      expertAccruedMinor: ended.expertAccruedMinor,
      connectedMinutes: ended.session.connectedMinutes,
    };
  }

  async function bookPayout(s: {
    id: string;
    companyId: string;
    expertProfileId: string;
    expertAccruedMinor: number;
    connectedMinutes: number;
  }): Promise<string> {
    const { record } = await expertPayoutRecordsRepository.record({
      sessionId: s.id,
      expertProfileId: s.expertProfileId,
      companyId: s.companyId,
      amountMinor: s.expertAccruedMinor,
      durationMinutes: s.connectedMinutes,
      finalizationPath: 'live_capture',
      idempotencyKey: `payout:${s.id}`,
    });
    return record.id;
  }

  it('picks up a finalized session with no payout; skips legacy-null / already-booked / too-recent', async () => {
    const cutoff = new Date(BASE.getTime() + 100 * 60_000);

    // A — finalized (billingFinalizedAt ≈ BASE+3.5min < cutoff), no payout → ELIGIBLE.
    const a = await finalizeSession();

    // B — finalized, but a payout obligation IS booked → SKIPPED.
    const b = await finalizeSession();
    await bookPayout(b);

    // C — legacy pre-deploy ended session: billingFinalizedAt NULL → SKIPPED.
    const c = await finalizeSession();
    await db
      .update(creditSessions)
      .set({ billingFinalizedAt: null })
      .where(eq(creditSessions.id, c.id));

    // D — finalized after the cutoff grace (don't race an in-flight finalize) → SKIPPED.
    const d = await finalizeSession();
    await db
      .update(creditSessions)
      .set({ billingFinalizedAt: new Date(BASE.getTime() + 200 * 60_000) })
      .where(eq(creditSessions.id, d.id));

    const foundIds = (await creditSessionsRepository.findFinalizedMissingPayout(cutoff)).map(
      (s) => s.id
    );
    expect(foundIds).toContain(a.id);
    expect(foundIds).not.toContain(b.id); // payout already booked
    expect(foundIds).not.toContain(c.id); // legacy null
    expect(foundIds).not.toContain(d.id); // too recent
  });

  it('still returns a session whose ONLY payout record is soft-deleted (anti-join → still missing)', async () => {
    const s = await finalizeSession();
    const recordId = await bookPayout(s);
    await db
      .update(expertPayoutRecords)
      .set({ deletedAt: new Date() })
      .where(eq(expertPayoutRecords.id, recordId));

    const cutoff = new Date(BASE.getTime() + 100 * 60_000);
    const foundIds = (await creditSessionsRepository.findFinalizedMissingPayout(cutoff)).map(
      (row) => row.id
    );
    expect(foundIds).toContain(s.id); // a soft-deleted obligation must not hide the strand
  });
});

// ── findSettledMissingLedgerCredit — the settled-without-credit alarm ───────

/**
 * ⚠⚠ THE MONEY SHAPE THIS FINDER EXISTS FOR. A session marked `settlement_status='settled'` with
 * NO `overdraft_settlement` ledger row is money Stripe took, a receivable cleared, dunning
 * stopped — and nothing in the ledger to show for it. The reconcile path used to produce exactly
 * this row whenever the `payment_intent.succeeded` webhook permanently failed while returning
 * HTTP 200 (Stripe then never redelivers).
 *
 * ONLY an integration test can prove an anti-join predicate: the join terms
 * (`session_id`, `wallet_id`, `reason`) and the `IS NULL` test are SQL, and a mocked repository
 * would assert nothing about which rows Postgres actually returns.
 */
describe('creditSessionsRepository.findSettledMissingLedgerCredit (settled-without-credit alarm)', () => {
  interface SettledSession {
    id: string;
    walletId: string;
    memberId: string;
  }

  /** The overdraft on a 24-minute session against a 5000c balance at 250c/min. */
  const OVERDRAFT_MINOR = 1000;
  /** Generously past the sweep's 60-minute grace, in `meterAt` terms. */
  const CUTOFF = meterAt(100);

  /**
   * Open → connect → meter past the balance → end with a real overdraft → mark `settled` at
   * `settledAt`. This is EXACTLY the row both `settled` writers produce; whether the ledger
   * credit exists beside it is the variable under test.
   */
  async function settledOverdraftSession(settledAt: Date): Promise<SettledSession> {
    const ctx = await setup({
      balanceMinor: 5000,
      ...GRACE_CAPABLE,
      overdraftCeilingMinor: 100_000,
    });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(24), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    const ended = await creditSessionsRepository.end(id, { now: meterAt(24) });
    expect(ended.overdraftMinor).toBe(OVERDRAFT_MINOR);
    await creditSessionsRepository.markSettlementResult(db, {
      sessionId: id,
      status: 'settled',
      stripePaymentIntentId: `pi_${id}`,
      now: settledAt,
    });
    return { id, walletId: ctx.walletId, memberId: ctx.memberId };
  }

  /** The credit the `payment_intent.succeeded` webhook applies, under the one shared key. */
  async function applyOverdraftCredit(s: SettledSession, walletId = s.walletId): Promise<void> {
    await creditLedgerRepository.postEntry({
      walletId,
      entryType: 'purchase',
      reason: 'overdraft_settlement',
      amountMinor: OVERDRAFT_MINOR,
      idempotencyKey: `overdraft_settlement:${s.id}`,
      memberId: s.memberId,
      sessionId: s.id,
    });
  }

  it('returns the reconcile-shaped rows (settled, no credit) and NEVER the webhook-shaped one', async () => {
    // A + B — settled with no `overdraft_settlement` credit ⇒ CORRUPT, oldest first.
    const b = await settledOverdraftSession(meterAt(40));
    const a = await settledOverdraftSession(meterAt(25));
    // C — the ordinary webhook shape: settled WITH the credit committed beside it ⇒ healthy.
    const c = await settledOverdraftSession(meterAt(30));
    await applyOverdraftCredit(c);

    const found = await creditSessionsRepository.findSettledMissingLedgerCredit(CUTOFF);
    const foundIds = found.map((row) => row.id);

    expect(foundIds).toContain(a.id);
    expect(foundIds).toContain(b.id);
    expect(foundIds).not.toContain(c.id);
    // Oldest-settled first — the alarm reports the longest-standing corruption at the top.
    expect(foundIds.indexOf(a.id)).toBeLessThan(foundIds.indexOf(b.id));
  });

  it('skips a row settled inside the cutoff — an in-flight reconcile is not a corruption', async () => {
    const recent = await settledOverdraftSession(meterAt(200)); // AFTER the cutoff

    const foundIds = (await creditSessionsRepository.findSettledMissingLedgerCredit(CUTOFF)).map(
      (row) => row.id
    );
    expect(foundIds).not.toContain(recent.id);
  });

  it('excludes a soft-deleted session', async () => {
    const s = await settledOverdraftSession(meterAt(25));
    await db
      .update(creditSessions)
      .set({ deletedAt: new Date() })
      .where(eq(creditSessions.id, s.id));

    const foundIds = (await creditSessionsRepository.findSettledMissingLedgerCredit(CUTOFF)).map(
      (row) => row.id
    );
    expect(foundIds).not.toContain(s.id);
  });

  /**
   * ⚠ THE `reason` JOIN TERM IS LOAD-BEARING. A metered session ALWAYS carries `session_consume`
   * ledger rows on the same `(session_id, wallet_id)` pair — without the `reason` term every
   * metered session would look credited and the alarm would report nothing, ever.
   */
  it('a session_consume ledger row on the same session does NOT satisfy the anti-join', async () => {
    const s = await settledOverdraftSession(meterAt(25));
    // The metering above already wrote 24 `session_consume` rows against this exact pair.
    const consumeRows = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(and(eq(creditLedger.sessionId, s.id), eq(creditLedger.reason, 'session_consume')));
    expect(consumeRows.length).toBeGreaterThan(0);

    const foundIds = (await creditSessionsRepository.findSettledMissingLedgerCredit(CUTOFF)).map(
      (row) => row.id
    );
    expect(foundIds).toContain(s.id);
  });

  /**
   * ⚠ THE `wallet_id` JOIN TERM IS ALSO LOAD-BEARING. `credit_ledger.session_id` carries no
   * constraint tying it to the session's own wallet, so a credit mis-attributed to ANOTHER
   * wallet must not be accepted as evidence that THIS session's overdraft was recorded.
   */
  it('a credit mis-attributed to a different wallet does NOT satisfy the anti-join', async () => {
    const s = await settledOverdraftSession(meterAt(25));
    const { wallet: otherWallet } = await creditWalletFactory({ values: { balanceMinor: 0 } });
    await applyOverdraftCredit(s, otherWallet.id);

    const foundIds = (await creditSessionsRepository.findSettledMissingLedgerCredit(CUTOFF)).map(
      (row) => row.id
    );
    expect(foundIds).toContain(s.id);
  });

  /**
   * A legacy row predating the `settled_at` stamp has no reliable clock, so `settled_at <=
   * cutoff` (NULL ⇒ not true) excludes it. Documented, not accidental: reporting a row whose age
   * cannot be established would be a guess, and this alarm's whole value is that it never guesses.
   */
  it('excludes a legacy settled row with a NULL settled_at', async () => {
    const s = await settledOverdraftSession(meterAt(25));
    await db.update(creditSessions).set({ settledAt: null }).where(eq(creditSessions.id, s.id));

    const foundIds = (await creditSessionsRepository.findSettledMissingLedgerCredit(CUTOFF)).map(
      (row) => row.id
    );
    expect(foundIds).not.toContain(s.id);
  });

  it('bounds the batch by `limit`', async () => {
    await settledOverdraftSession(meterAt(25));
    await settledOverdraftSession(meterAt(30));

    const found = await creditSessionsRepository.findSettledMissingLedgerCredit(CUTOFF, 1);
    expect(found).toHaveLength(1);
  });
});

// ── hasActiveSessionForWallet (BAL-379 auto-top-up safe-to-charge gate) ─────

describe('creditSessionsRepository.hasActiveSessionForWallet', () => {
  it('is false for a wallet with no sessions', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    expect(await creditSessionsRepository.hasActiveSessionForWallet(ctx.walletId, db)).toBe(false);
  });

  // Every non-terminal status blocks a between-session reload (data-driven — one shape).
  for (const status of ['pending', 'active', 'grace', 'wrapped'] as const) {
    it(`is true for a non-terminal '${status}' session`, async () => {
      const ctx = await setup({ balanceMinor: 50_000 });
      const id = await openOk(ctx); // opens 'pending'
      if (status !== 'pending') {
        await db.update(creditSessions).set({ status }).where(eq(creditSessions.id, id));
      }
      expect(await creditSessionsRepository.hasActiveSessionForWallet(ctx.walletId, db)).toBe(true);
    });
  }

  it("is true when a prior (terminal) session's settlement is still 'processing'", async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({ status: 'ended', settlementStatus: 'processing' })
      .where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasActiveSessionForWallet(ctx.walletId, db)).toBe(true);
  });

  it('is false when the only session is terminal and settled', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({ status: 'ended', settlementStatus: 'settled' })
      .where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasActiveSessionForWallet(ctx.walletId, db)).toBe(false);
  });

  it('is false when the only non-terminal session is soft-deleted', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db.update(creditSessions).set({ deletedAt: new Date() }).where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasActiveSessionForWallet(ctx.walletId, db)).toBe(false);
  });
});

// ── hasUnsettledOverdraftForWallet (BAL-523 settings re-gate) ───────────────────────────────

describe('creditSessionsRepository.hasUnsettledOverdraftForWallet', () => {
  it('is false for a wallet with no sessions', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    expect(await creditSessionsRepository.hasUnsettledOverdraftForWallet(ctx.walletId, db)).toBe(
      false
    );
  });

  it('is false for a LIVE active session that has never entered grace', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db.update(creditSessions).set({ status: 'active' }).where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasUnsettledOverdraftForWallet(ctx.walletId, db)).toBe(
      false
    );
  });

  it('is true for a session currently IN grace', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({ status: 'grace', graceEnteredAt: new Date() })
      .where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasUnsettledOverdraftForWallet(ctx.walletId, db)).toBe(
      true
    );
  });

  it('is true for a session WRAPPED after having entered grace', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({ status: 'wrapped', graceEnteredAt: new Date() })
      .where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasUnsettledOverdraftForWallet(ctx.walletId, db)).toBe(
      true
    );
  });

  it('is true for an ENDED session whose settlement is still `processing` with a real overdraft', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({ status: 'ended', settlementStatus: 'processing', overdraftSettledMinor: 1000 })
      .where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasUnsettledOverdraftForWallet(ctx.walletId, db)).toBe(
      true
    );
  });

  it('⚠ is true for an ENDED session whose settlement `failed` — the arm hasActiveSessionForWallet MISSES', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({ status: 'ended', settlementStatus: 'failed', overdraftSettledMinor: 1000 })
      .where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasActiveSessionForWallet(ctx.walletId, db)).toBe(false);
    expect(await creditSessionsRepository.hasUnsettledOverdraftForWallet(ctx.walletId, db)).toBe(
      true
    );
  });

  it('is false for an ENDED session that has SETTLED', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({ status: 'ended', settlementStatus: 'settled', overdraftSettledMinor: 1000 })
      .where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasUnsettledOverdraftForWallet(ctx.walletId, db)).toBe(
      false
    );
  });

  // ⚠ FIX ROUND 1 (F8) — arm (b)'s status list was unpinned beyond `failed`: narrowing it to
  // `['processing']` failed exactly one test, and removing ONLY `requires_action` failed none.
  // The `overdraft_settled_minor > 0` conjunct was likewise unpinned. These two close both holes.
  it('⚠ is true for an ENDED session whose settlement is `requires_action` — an SCA challenge the client can still complete', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({ status: 'ended', settlementStatus: 'requires_action', overdraftSettledMinor: 1000 })
      .where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasActiveSessionForWallet(ctx.walletId, db)).toBe(false);
    expect(await creditSessionsRepository.hasUnsettledOverdraftForWallet(ctx.walletId, db)).toBe(
      true
    );
  });

  it('⚠ is false for a `processing` settlement with NO overdraft — the amount conjunct, not just the status', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({ status: 'ended', settlementStatus: 'processing', overdraftSettledMinor: 0 })
      .where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasUnsettledOverdraftForWallet(ctx.walletId, db)).toBe(
      false
    );
  });

  it('is false when the only session with an unsettled overdraft is soft-deleted', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({
        status: 'grace',
        graceEnteredAt: new Date(),
        deletedAt: new Date(),
      })
      .where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasUnsettledOverdraftForWallet(ctx.walletId, db)).toBe(
      false
    );
  });

  // ── arm (0): the balance itself is negative (FIX ROUND 1, F4) ──────────────────────────
  //
  // The grace-keyed arm (a) is blind to every path that draws the wallet negative WITHOUT
  // stamping `grace_entered_at` — the BAL-133 external finalizer and `settleFromPresence`, both
  // of which post unclamped ticks by design (Owner Decision 3). Driven here through the REAL
  // repository call, not a hand-set row, so the gap is proved rather than posited.
  it('⚠ is true while the BAL-133 external finalizer holds the wallet NEGATIVE with grace never entered', async () => {
    const ctx = await setup({ balanceMinor: 5000, mandate: true, overdraftCeilingMinor: 100 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await markExternal(id);
    await creditSessionsRepository.parkAwaitingDuration(id);

    // 30 min × 250 = 7500 vs 5000 → −2500, unclamped, and `active` again.
    const applied = await creditSessionsRepository.applyExternalDuration(id, 30);
    expect(applied.status).toBe('active');
    expect(applied.graceEnteredAt).toBeNull(); // ⚠ arm (a) cannot see this session
    // ⚠ nor can arm (b): the column is still NULL pre-finalization, and `gt(col, 0)` is NULL
    // (not TRUE) on a NULL — so neither of the two original arms matches this row.
    expect(applied.overdraftSettledMinor).toBeNull();
    expect(await walletBalance(ctx.walletId)).toBe(-2500);

    expect(await creditSessionsRepository.hasUnsettledOverdraftForWallet(ctx.walletId, db)).toBe(
      true
    );
  });

  it('⚠ arm (0) does NOT fire on a funded wallet — a live, unfinalized session on a positive balance stays quiet', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await markExternal(id);
    await creditSessionsRepository.parkAwaitingDuration(id);

    const applied = await creditSessionsRepository.applyExternalDuration(id, 30);
    expect(applied.status).toBe('active');
    expect(await walletBalance(ctx.walletId)).toBe(50_000 - 30 * CLIENT_RATE_PER_MIN); // still positive
    expect(await creditSessionsRepository.hasUnsettledOverdraftForWallet(ctx.walletId, db)).toBe(
      false
    );
  });
});

// ── BAL-418 seam: the meeting link + the denormalised engagement (ADR-1045 §3) ──────────
//
// This is the ONLY coverage of the AC "a Case consultation links session → meeting, and
// engagement_id is populated on the session". Before these tests, no caller anywhere passed
// either parameter, so the non-`undefined` branch of both `?? null` had never executed.
describe('creditSessionsRepository.open — meetingId / engagementId (BAL-418)', () => {
  it('persists BOTH the meeting link and the denormalised engagement when supplied', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const { engagement } = await caseEngagementFactory();
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
      meetingId: meeting.id,
      engagementId: engagement.id,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.session.meetingId).toBe(meeting.id);
    expect(res.session.engagementId).toBe(engagement.id);

    // Re-select: the values must be PERSISTED, not merely present on the returned object.
    const [persisted] = await db
      .select({ meetingId: creditSessions.meetingId, engagementId: creditSessions.engagementId })
      .from(creditSessions)
      .where(eq(creditSessions.id, res.session.id));
    expect(persisted?.meetingId).toBe(meeting.id);
    expect(persisted?.engagementId).toBe(engagement.id);
  });

  it('accepts EITHER column alone — their NULLABILITY is independent (no CHECK relates them)', async () => {
    // A `duration_source='external'` session is a real consultation on an outside tool:
    // an engagement and NO Balo meeting. That combination must be storable. This says
    // NOTHING about the both-set case — see the divergence test below.
    const ctx = await setup({ balanceMinor: 50_000 });
    const { engagement } = await caseEngagementFactory();

    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
      engagementId: engagement.id,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.session.engagementId).toBe(engagement.id);
    expect(res.session.meetingId).toBeNull();
  });

  it('REGRESSION: open() without either parameter still succeeds, with both columns NULL', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });

    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.session.meetingId).toBeNull();
    expect(res.session.engagementId).toBeNull();
  });

  it('a wrong-tenant/unknown meeting uuid is rejected by the FK (23503) — this column IS constrained', async () => {
    // Deliberate contrast with `meeting_contexts.context_id`, which is polymorphic, has NO
    // FK, and therefore accepts a foreign uuid SILENTLY (see the tenancy obligation on
    // schema/meeting-contexts.ts). Here the FK does the work.
    const ctx = await setup({ balanceMinor: 50_000 });

    await expect(
      creditSessionsRepository.open({
        walletId: ctx.walletId,
        companyId: ctx.companyId,
        expertProfileId: ctx.expertProfileId,
        initiatingMemberId: ctx.memberId,
        estimatedMinutes: 10,
        meetingId: randomUUID(),
      })
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('DIVERGENCE IS UNDETECTED — a wrong engagementId is accepted, and the two read paths then disagree', async () => {
    // THE GAP THIS PINS: nothing checks that `engagement_id` is the engagement reachable
    // via `meeting_id` → `meeting_contexts.context_id`. It CANNOT be a DB constraint (the
    // predicate is cross-table — see the ruling on schema/credit-sessions.ts), so coherence
    // is the SINGLE WRITE PATH's obligation, carried by BAL-400 (booking) with BAL-129
    // supplying the meeting. If a future writer establishes the invariant, DELETE this test
    // deliberately — do not weaken it into passing.
    const ctx = await setup({ balanceMinor: 50_000 });
    const contextEngagement = (await caseEngagementFactory()).engagement; // the meeting's real subject
    const otherEngagement = (await caseEngagementFactory()).engagement; // an unrelated case
    const meetingEndedAt = new Date(BASE.getTime() - 60 * 60_000);
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: contextEngagement.id }],
      values: {
        status: 'ended',
        outcome: 'completed',
        scheduledStart: new Date(BASE.getTime() - 2 * 60 * 60_000),
        scheduledEnd: meetingEndedAt,
        endedAt: meetingEndedAt,
      },
    });

    // Accepted today: both FKs resolve, and NOTHING relates the two values.
    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
      meetingId: meeting.id,
      engagementId: otherEngagement.id,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.session.engagementId).toBe(otherEngagement.id);

    const sessionEndedAt = new Date(BASE.getTime() + 30 * 60_000);
    await creditSessionsRepository.connect(res.session.id, { now: BASE });
    await creditSessionsRepository.end(res.session.id, { now: sessionEndedAt });

    // THE CONSEQUENCE, on a LIVE reader. BAL-425's sweep resolves through the seam, so this
    // money row's `ended_at` lands on the MEETING's engagement — while money and reporting,
    // which read `engagement_id`, attribute the very same session to the other one.
    const anchors = await meetingContextsRepository.consultationTimestampsForEngagements(
      [contextEngagement.id, otherEngagement.id],
      new Date(BASE.getTime() + 60 * 60_000)
    );
    expect(anchors.get(contextEngagement.id)?.lastCompletedConsultationAt?.getTime()).toBe(
      sessionEndedAt.getTime()
    );
    expect(anchors.get(otherEngagement.id)?.lastCompletedConsultationAt).toBeNull();
  });
});

/**
 * BAL-388 — the MEETING-scoped read behind RULE M. The recap keys its money line on the
 * PRESENCE of a row for this meeting, so ABSENCE is a first-class answer here.
 */
describe('creditSessionsRepository.findIdByMeetingId', () => {
  it('returns the session linked to a meeting', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const sessionId = await openOk(ctx);
    const meetingId = (await meetingFactory()).meeting.id;
    await db.update(creditSessions).set({ meetingId }).where(eq(creditSessions.id, sessionId));

    const found = await creditSessionsRepository.findIdByMeetingId(meetingId);
    expect(found?.id).toBe(sessionId);
  });

  it('PROJECTS TO `id` ALONE - the margin and the un-marked-up expert rate never load', async () => {
    // Its one caller is the recap loader, on a CLIENT-BOUND path. A bare `.select()` here would
    // put `balo_fee_bps` (the literal Balo margin), `expert_rate_minor_per_minute` (the
    // UN-MARKED-UP expert rate), `expert_accrued_minor` and `stripe_payment_intent_id` one
    // careless spread away from a client payload. Asserting the KEY SET (not merely the id) is
    // what makes a widened select fail HERE rather than in production.
    const ctx = await setup({ balanceMinor: 50_000 });
    const sessionId = await openOk(ctx);
    const meetingId = (await meetingFactory()).meeting.id;
    const intentId = 'pi_secret_margin';
    await db
      .update(creditSessions)
      .set({ meetingId, baloFeeBps: 2500, stripePaymentIntentId: intentId })
      .where(eq(creditSessions.id, sessionId));

    const found = await creditSessionsRepository.findIdByMeetingId(meetingId);
    expect(found).toEqual({ id: sessionId });
    expect(Object.keys(found ?? {})).toEqual(['id']);
  });

  it("NEVER matches a row whose meeting_id is NULL — a session with no meeting is not this meeting's", async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    // The session opened here keeps meeting_id NULL; the meeting below is real and linked to
    // nothing. `eq()` compiles to `= $1`, which is never true against NULL.
    await openOk(ctx);
    const unlinkedMeetingId = (await meetingFactory()).meeting.id;

    await expect(
      creditSessionsRepository.findIdByMeetingId(unlinkedMeetingId)
    ).resolves.toBeUndefined();
  });

  it('EXCLUDES a cancelled session — a cancelled row must never render "Charge pending"', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const sessionId = await openOk(ctx);
    const meetingId = (await meetingFactory()).meeting.id;
    await db
      .update(creditSessions)
      .set({ meetingId, status: 'cancelled' })
      .where(eq(creditSessions.id, sessionId));

    await expect(creditSessionsRepository.findIdByMeetingId(meetingId)).resolves.toBeUndefined();
  });

  it('picks the BILLED row over a LATER cancelled retry on the same meeting', async () => {
    // Two sessions on ONE meeting: the older one actually billed, the newer was cancelled.
    // Ordering alone (created_at DESC) would hand back the cancelled retry and the recap would
    // read "Charge pending" forever — the status filter is what decides this.
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = (await meetingFactory()).meeting.id;

    const billedId = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({ meetingId, status: 'ended' })
      .where(eq(creditSessions.id, billedId));

    // Opened SECOND, so `created_at DESC` ranks it first — it must still lose.
    const cancelledId = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({ meetingId, status: 'cancelled' })
      .where(eq(creditSessions.id, cancelledId));

    const found = await creditSessionsRepository.findIdByMeetingId(meetingId);
    expect(found?.id).toBe(billedId);
  });

  it('filters deleted_at IS NULL', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const sessionId = await openOk(ctx);
    const meetingId = (await meetingFactory()).meeting.id;
    await db
      .update(creditSessions)
      .set({ meetingId, deletedAt: new Date() })
      .where(eq(creditSessions.id, sessionId));

    await expect(creditSessionsRepository.findIdByMeetingId(meetingId)).resolves.toBeUndefined();
  });

  it("never returns ANOTHER meeting's session", async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const sessionId = await openOk(ctx);
    const meetingId = (await meetingFactory()).meeting.id;
    const otherMeetingId = (await meetingFactory()).meeting.id;
    await db.update(creditSessions).set({ meetingId }).where(eq(creditSessions.id, sessionId));

    await expect(
      creditSessionsRepository.findIdByMeetingId(otherMeetingId)
    ).resolves.toBeUndefined();
  });
});

/**
 * BAL-421 — `sumExpertEarningsForEngagement`: the ENGAGEMENT-GRAIN expert-earnings
 * aggregate behind the case surface's expert-lens earnings block.
 *
 * Three things are load-bearing here, and each has its own test below:
 *   1. "NO DATA" IS NOT "A$0.00". Nothing writes `engagement_id` on `main` today, so every
 *      real case aggregates to `not_yet` — a state that CANNOT hold a figure.
 *   2. `engagement_id` IS READ AS GIVEN. Never through `meeting_id` → `meeting_contexts`.
 *   3. FEE CONCEALMENT. Expert accrual only — no client rate, charge, fee or margin, and
 *      none derivable from what comes back.
 */
describe('creditSessionsRepository.sumExpertEarningsForEngagement (BAL-421)', () => {
  /** Open a session against an engagement, drive it to a FINALIZED end, return the accrual. */
  async function finalizeSessionOnEngagement(
    ctx: Awaited<ReturnType<typeof setup>>,
    engagementId: string,
    minutes: number
  ): Promise<{ sessionId: string; expectedAccrualMinor: number }> {
    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: minutes + 5,
      engagementId,
    });
    if (!res.ok) throw new Error(`expected open ok, got ${res.code}`);
    await creditSessionsRepository.connect(res.session.id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(res.session.id, meterAt(minutes), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    const ended = await creditSessionsRepository.end(res.session.id, { now: meterAt(minutes) });
    expect(ended.session.billingFinalizedAt).not.toBeNull();
    return { sessionId: res.session.id, expectedAccrualMinor: minutes * EXPERT_RATE_PER_MIN };
  }

  it('THE STATE EVERY CASE IS IN TODAY: no sessions ⇒ `not_yet`, and the figure is NULL, never 0', async () => {
    // The live `openSession` service passes neither `meeting_id` nor `engagement_id`
    // (BAL-400 is the ticket that will), so this is not an edge case — it is the whole
    // platform. If this returned `earningsAudMinor: 0` the case surface would render
    // "A$0.00" — an unbacked MONEY CLAIM — to every expert on Balo.
    const { engagement } = await caseEngagementFactory();

    const agg = await creditSessionsRepository.sumExpertEarningsForEngagement(engagement.id);

    expect(agg.state).toBe('not_yet');
    expect(agg.earningsAudMinor).toBeNull();
    expect(agg.earningsAudMinor).not.toBe(0);
    expect(agg.finalizedSessionCount).toBe(0);
    expect(agg.pendingSessionCount).toBe(0);
  });

  it('an UN-FINALIZED session ⇒ `pending` with a count and STILL no figure', async () => {
    // Mirrors `buildExpertMoneyBlock` ("pending ⇒ every figure is 0", rendered as no
    // figure at all): a session that has not finalized is worth counting and not worth
    // quoting. Its accrual is a moving number nobody is owed yet.
    const ctx = await setup({ balanceMinor: 50_000 });
    const { engagement } = await caseEngagementFactory();
    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
      engagementId: engagement.id,
    });
    expect(res.ok).toBe(true);

    const agg = await creditSessionsRepository.sumExpertEarningsForEngagement(engagement.id);

    expect(agg.state).toBe('pending');
    expect(agg.earningsAudMinor).toBeNull();
    expect(agg.pendingSessionCount).toBe(1);
    expect(agg.finalizedSessionCount).toBe(0);
  });

  it('sums FINALIZED sessions only — an un-finalized sibling is counted but contributes NOTHING to the total', async () => {
    const ctx = await setup({ balanceMinor: 500_000 });
    const { engagement } = await caseEngagementFactory();

    const first = await finalizeSessionOnEngagement(ctx, engagement.id, 3);
    // A SECOND consultation on the same case, still in flight (legal: the first is
    // terminal, so the one-live-session-per-wallet gate lets this one open).
    const pendingRes = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
      engagementId: engagement.id,
    });
    expect(pendingRes.ok).toBe(true);

    const agg = await creditSessionsRepository.sumExpertEarningsForEngagement(engagement.id);

    expect(agg.state).toBe('finalized');
    expect(agg.finalizedSessionCount).toBe(1);
    expect(agg.pendingSessionCount).toBe(1);
    // EXACTLY the finalized accrual — the in-flight session's running accrual is excluded.
    expect(agg.earningsAudMinor).toBe(first.expectedAccrualMinor);
  });

  it('adds up ACROSS finalized sessions on the same case', async () => {
    const ctx = await setup({ balanceMinor: 500_000 });
    const { engagement } = await caseEngagementFactory();

    const a = await finalizeSessionOnEngagement(ctx, engagement.id, 3);
    const b = await finalizeSessionOnEngagement(ctx, engagement.id, 5);

    const agg = await creditSessionsRepository.sumExpertEarningsForEngagement(engagement.id);
    expect(agg.state).toBe('finalized');
    expect(agg.finalizedSessionCount).toBe(2);
    expect(agg.earningsAudMinor).toBe(a.expectedAccrualMinor + b.expectedAccrualMinor);
  });

  it('IGNORES SOFT-DELETED sessions — deleting the only session returns to `not_yet`, not to a zero', async () => {
    const ctx = await setup({ balanceMinor: 500_000 });
    const { engagement } = await caseEngagementFactory();
    const { sessionId } = await finalizeSessionOnEngagement(ctx, engagement.id, 4);

    await db
      .update(creditSessions)
      .set({ deletedAt: new Date() })
      .where(eq(creditSessions.id, sessionId));

    const agg = await creditSessionsRepository.sumExpertEarningsForEngagement(engagement.id);
    expect(agg.state).toBe('not_yet');
    expect(agg.earningsAudMinor).toBeNull();
    expect(agg.finalizedSessionCount).toBe(0);
    expect(agg.pendingSessionCount).toBe(0);
  });

  it('EXCLUDES a CANCELLED session — it must never pin the block in `pending` forever', async () => {
    // The `findIdByMeetingId` ruling, applied at the engagement grain. A cancelled session
    // never bills, so `billing_finalized_at` stays NULL for good; counting it as pending
    // would render "1 consultation still being finalised" for the life of the case, about
    // a consultation that will never produce a cent.
    const ctx = await setup({ balanceMinor: 50_000 });
    const { engagement } = await caseEngagementFactory();
    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
      engagementId: engagement.id,
    });
    if (!res.ok) throw new Error(`expected open ok, got ${res.code}`);
    await creditSessionsRepository.cancel(res.session.id);

    const agg = await creditSessionsRepository.sumExpertEarningsForEngagement(engagement.id);
    expect(agg.state).toBe('not_yet');
    expect(agg.pendingSessionCount).toBe(0);
  });

  it("never counts ANOTHER engagement's sessions", async () => {
    const ctx = await setup({ balanceMinor: 500_000 });
    const mine = await caseEngagementFactory();
    const theirs = await caseEngagementFactory();

    await finalizeSessionOnEngagement(ctx, mine.engagement.id, 3);

    const agg = await creditSessionsRepository.sumExpertEarningsForEngagement(theirs.engagement.id);
    expect(agg.state).toBe('not_yet');
  });

  // ── THE DIVERGENCE GUARD ────────────────────────────────────────────────────────────
  //
  // ⚠⚠ THESE TWO TESTS EXIST TO FAIL if anyone ever "helpfully" rewrites this read to
  // resolve `meeting_id` → `meeting_contexts.context_id` → engagement. Money and reporting
  // consume `engagement_id` AS GIVEN (schema/credit-sessions.ts); only BAL-425's sweep goes
  // through the seam. Re-deriving here would make a divergent pair silently AGREE — hiding
  // the divergence instead of catching it, with no row anywhere that looks wrong. They are
  // the engagement-grain companions to the `open()` divergence test above.

  it('DOES NOT reach through the seam: a session with engagement_id NULL is invisible, even when its MEETING resolves to this case', async () => {
    const ctx = await setup({ balanceMinor: 500_000 });
    const { engagement } = await caseEngagementFactory();
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: {
        status: 'ended',
        outcome: 'completed',
        scheduledStart: new Date(BASE.getTime() - 60 * 60_000),
        scheduledEnd: BASE,
        endedAt: BASE,
      },
    });

    // A REAL, FINALIZED, EARNING session — linked to the meeting, with NO engagement_id.
    // (`open` accepts either column alone; their nullability is independent.)
    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
      meetingId: meeting.id,
    });
    if (!res.ok) throw new Error(`expected open ok, got ${res.code}`);
    expect(res.session.engagementId).toBeNull();
    await creditSessionsRepository.connect(res.session.id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(res.session.id, meterAt(4), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    const ended = await creditSessionsRepository.end(res.session.id, { now: meterAt(4) });
    expect(ended.session.expertAccruedMinor).toBe(4 * EXPERT_RATE_PER_MIN);

    // THE ASSERTION IS ONLY MEANINGFUL IF THE SEAM WOULD HAVE FOUND IT — so prove the seam
    // does resolve this meeting to this engagement first. Without this line the test could
    // pass for the wrong reason (a mis-seeded context) and the guard would be vacuous.
    const anchors = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagement.id],
      meterAt(60)
    );
    expect(anchors.get(engagement.id)?.lastCompletedConsultationAt?.getTime()).toBe(
      meterAt(4).getTime()
    );

    // …and the aggregate STILL reports no data, because it reads `engagement_id` as given.
    const agg = await creditSessionsRepository.sumExpertEarningsForEngagement(engagement.id);
    expect(agg.state).toBe('not_yet');
    expect(agg.earningsAudMinor).toBeNull();
  });

  it('ATTRIBUTES BY engagement_id ALONE: a divergent session counts under the engagement it NAMES, not the one its meeting resolves to', async () => {
    const ctx = await setup({ balanceMinor: 500_000 });
    const meetingSubject = (await caseEngagementFactory()).engagement; // the meeting's real subject
    const named = (await caseEngagementFactory()).engagement; // what the money row NAMES
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: meetingSubject.id }],
    });

    const res = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
      meetingId: meeting.id,
      engagementId: named.id, // DIVERGENT — accepted today; nothing relates the two values.
    });
    if (!res.ok) throw new Error(`expected open ok, got ${res.code}`);
    await creditSessionsRepository.connect(res.session.id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(res.session.id, meterAt(2), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    await creditSessionsRepository.end(res.session.id, { now: meterAt(2) });

    const onNamed = await creditSessionsRepository.sumExpertEarningsForEngagement(named.id);
    expect(onNamed.state).toBe('finalized');
    expect(onNamed.earningsAudMinor).toBe(2 * EXPERT_RATE_PER_MIN);

    // The meeting's own subject earns NOTHING from this row — the divergence stays VISIBLE
    // rather than being papered over by a join.
    const onSubject = await creditSessionsRepository.sumExpertEarningsForEngagement(
      meetingSubject.id
    );
    expect(onSubject.state).toBe('not_yet');
  });

  // ── FEE CONCEALMENT ─────────────────────────────────────────────────────────────────

  it('FEE-SAFE: the figure is the RAW expert accrual, and no client / fee / margin key exists on the result', async () => {
    const ctx = await setup({ balanceMinor: 500_000 });
    const { engagement } = await caseEngagementFactory();
    const minutes = 4;
    await finalizeSessionOnEngagement(ctx, engagement.id, minutes);

    const agg = await creditSessionsRepository.sumExpertEarningsForEngagement(engagement.id);

    // The expert's OWN, UN-MARKED-UP earnings — provably not the all-in client charge.
    expect(agg.earningsAudMinor).toBe(minutes * EXPERT_RATE_PER_MIN);
    expect(agg.earningsAudMinor).not.toBe(minutes * CLIENT_RATE_PER_MIN);

    // Nothing on the shape names — or lets a caller derive — the client side or the margin.
    const keys = Object.keys(agg);
    for (const banned of [
      'clientRateMinorPerMinute',
      'clientChargeAudMinor',
      'baloFeeBps',
      'marginAudMinor',
      'overdraftSettledMinor',
      'stripePaymentIntentId',
    ]) {
      expect(keys).not.toContain(banned);
    }
    expect(keys.sort()).toEqual(
      ['earningsAudMinor', 'finalizedSessionCount', 'pendingSessionCount', 'state'].sort()
    );
  });
});

// ── BAL-412 (ADR-1044 §7) — presence settlement + the 15-minute billing floor ─────────────
//
// ⚠ EVERY FIGURE BELOW IS SUPPLIED BY THE TEST, NOT DERIVED BY THE REPOSITORY. That is the
// contract: `resolveMeetingSettlement` (`@balo/shared/credit`) owns the floor rule, the four
// shapes and the clamps; `settleFromPresence` owns the TRANSACTION. These cases pin the
// transaction — what is written, what is written exactly once, and what is not written at all.

/** ADR-1044 §7's floor, as the settlement layer injects it (whole minutes). */
const FLOOR_MINUTES = 15;

/** Settlement inputs with the boring fields filled in. */
function settlementInput(
  sessionId: string,
  meetingId: string,
  overrides: Partial<SettleFromPresenceRepoInput> = {}
): SettleFromPresenceRepoInput {
  return {
    sessionId,
    meetingId,
    billableMinutes: FLOOR_MINUTES,
    actualMinutes: FLOOR_MINUTES,
    billingFloorMinutes: FLOOR_MINUTES,
    topUpFromTickSeq: 1,
    topUpToTickSeq: FLOOR_MINUTES,
    // F2 — the TOCTOU anchor. Default 0 matches a session that never metered (the common
    // no-show); a case that seeds `last_tick_seq > 0` MUST override it or the repository
    // correctly refuses with `SettlementDrawDivergedError`.
    minutesAlreadyDrawn: 0,
    shape: 'no_show_client',
    // ⚠ F14/R1 — `true`, because the default shape is `no_show_client` and that shape bills the
    // floor **FLAT** (owner ruling, 2026-08-21): the minimum is definitionally what fixed the
    // figure, whatever the expert's wait was, so the pure core can never emit `false` here.
    // `held` cases — including the Q1 no-refund clamp — override both `shape` and this flag.
    floorApplied: true,
    outcome: 'no_show_client',
    actorUserId: null,
    now: meterAt(20),
    ...overrides,
  };
}

/** An ENDED meeting — settlement's precondition (the service refuses a non-terminal one). */
async function endedMeeting(endedAt: Date = meterAt(20)): Promise<string> {
  const { meeting } = await meetingFactory({
    values: { status: 'ended', endedBy: 'expert_host', endedAt },
  });
  return meeting.id;
}

/**
 * A LIVE meeting — the state a `presence` session is metered in. ⚠ Distinct from
 * {@link endedMeeting} and NOT interchangeable with it since F3: `findMeterable` now refuses a
 * `presence` session whose meeting is terminal, so a meter test seeded from an `ended` meeting
 * would assert the opposite of what it means to.
 */
async function liveMeeting(): Promise<string> {
  const { meeting } = await meetingFactory({ values: { status: 'in_progress' } });
  return meeting.id;
}

/** `open` a `presence` session bound to `meetingId`. Asserts acceptance; returns the id. */
async function openPresence(
  ctx: { walletId: string; companyId: string; expertProfileId: string; memberId: string },
  meetingId: string,
  estimatedMinutes = FLOOR_MINUTES
): Promise<string> {
  const res = await creditSessionsRepository.open({
    walletId: ctx.walletId,
    companyId: ctx.companyId,
    expertProfileId: ctx.expertProfileId,
    initiatingMemberId: ctx.memberId,
    estimatedMinutes,
    meetingId,
    durationSource: 'presence',
  });
  if (!res.ok) {
    throw new Error(`expected open ok, got ${res.code}`);
  }
  return res.session.id;
}

/** Every `session_consume` idempotency key written for one session, in tick order. */
async function consumeKeys(sessionId: string): Promise<string[]> {
  const rows = await db
    .select({ key: creditLedger.idempotencyKey })
    .from(creditLedger)
    .where(and(eq(creditLedger.sessionId, sessionId), eq(creditLedger.reason, 'session_consume')))
    .orderBy(asc(creditLedger.seq));
  return rows.map((row) => row.key);
}

/** Audit rows for one session + action. */
async function sessionAudits(sessionId: string, action: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.entityId, sessionId), eq(auditEvents.action, action)));
}

async function walletBalance(walletId: string): Promise<number> {
  const [row] = await db
    .select({ balanceMinor: creditWallets.balanceMinor })
    .from(creditWallets)
    .where(eq(creditWallets.id, walletId));
  return row?.balanceMinor ?? 0;
}

describe('creditSessionsRepository.open — duration provenance (BAL-412 seam)', () => {
  it('defaults to live_capture — every SHIPPED caller is unchanged', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    expect((await creditSessionsRepository.findById(id))?.durationSource).toBe('live_capture');
  });

  it('persists an explicit presence provenance — the INERT seam BAL-466 will use', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);

    const session = await creditSessionsRepository.findById(id);
    expect(session?.durationSource).toBe('presence');
    expect(session?.meetingId).toBe(meetingId);
    // The settlement columns are untouched at open — they are finalization outputs.
    expect(session?.actualMinutes).toBeNull();
    expect(session?.billingFloorMinutes).toBeNull();
    expect(session?.settlementShape).toBeNull();
  });
});

describe('creditSessionsRepository.settleFromPresence — the no-show (from `pending`)', () => {
  it('⚠⚠ SETTLES A NEVER-CONNECTED SESSION: 15 floor ticks, hold released, outcome resolved', async () => {
    // THE CASE THIS TICKET EXISTS FOR. Nothing ever called `connect`, so the session is still
    // `pending` with a NULL `connected_at` — a status `end()` refuses outright.
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);
    expect((await creditSessionsRepository.findById(id))?.status).toBe('pending');

    const res = await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meetingId, { actualMinutes: FLOOR_MINUTES })
    );

    expect(res.alreadySettled).toBe(false);
    expect(res.ticksPosted).toBe(15);
    expect(res.outcomeWritten).toBe(true);
    expect(res.overdraftMinor).toBe(0);
    expect(res.expertAccruedMinor).toBe(15 * EXPERT_RATE_PER_MIN);

    const s = res.session;
    expect(s.status).toBe('ended');
    expect(s.connectedMinutes).toBe(15);
    expect(s.lastTickSeq).toBe(15);
    expect(s.actualMinutes).toBe(15);
    expect(s.billingFloorMinutes).toBe(15);
    expect(s.settlementShape).toBe('no_show_client');
    expect(s.finalizationPath).toBe('presence');
    expect(s.billingFinalizedAt).not.toBeNull();
    expect(s.settlementStatus).toBe('not_required');
    expect(s.expertAccruedMinor).toBe(15 * EXPERT_RATE_PER_MIN);
    // ⚠ `connected_at` STAYS NULL. Nothing downstream reads it for money — the money block
    // reads `connected_minutes` — and inventing a connect instant would be a fabricated fact.
    expect(s.connectedAt).toBeNull();

    // 15 ticks drawn at the snapshotted client rate; the reservation released.
    expect(await walletBalance(ctx.walletId)).toBe(50_000 - 15 * CLIENT_RATE_PER_MIN);
    expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(0);
    expect(await consumeKeys(id)).toEqual(
      Array.from({ length: 15 }, (_, index) => `session_consume:${id}:${index + 1}`)
    );

    // The outcome BAL-134 left NULL is now resolved, on the same transaction.
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
    expect(meeting?.outcome).toBe('no_show_client');
  });

  it('writes BOTH audit rows — the accrual record AND the settlement’s reasoning record', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);
    const actor = await userFactory();

    await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meetingId, {
        actorUserId: actor.id,
        actualMinutes: 6,
        floorApplied: true,
      })
    );

    const accrued = await sessionAudits(id, 'credit_session.expert_accrued');
    expect(accrued).toHaveLength(1);
    expect(accrued[0]?.actorUserId).toBe(actor.id);
    expect(accrued[0]?.metadata).toMatchObject({
      expertProfileId: ctx.expertProfileId,
      connectedMinutes: 15,
      expertAccruedMinor: 15 * EXPERT_RATE_PER_MIN,
    });

    const settled = await sessionAudits(id, 'credit_session.presence_settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]?.entityType).toBe('credit_session');
    expect(settled[0]?.metadata).toMatchObject({
      meetingId,
      shape: 'no_show_client',
      outcome: 'no_show_client',
      outcomeWritten: true,
      actualMinutes: 6,
      billableMinutes: 15,
      floorApplied: true, // 15 billed > 6 delivered — the ONLY durable record of the split
      floorMinutes: 15,
      ticksPosted: 15,
      minutesAlreadyDrawn: 0,
    });
  });
});

describe('creditSessionsRepository.settleFromPresence — the 4 → 15 top-up', () => {
  it('⚠⚠ POSTS EXACTLY 11 NEW TICKS: no double charge, no under-charge', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);

    // A `presence` session METERS LIVE, exactly like `live_capture` (D11 / §4.2). Four
    // minutes are already drawn under keys :1 … :4 before settlement runs.
    await creditSessionsRepository.connect(id, { now: BASE });
    const metered = await creditSessionsRepository.meterSessionToNow(id, meterAt(4), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    expect(metered.ticksPosted).toBe(4);
    expect(await walletBalance(ctx.walletId)).toBe(50_000 - 4 * CLIENT_RATE_PER_MIN);

    const res = await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meetingId, {
        billableMinutes: 15,
        actualMinutes: 4,
        topUpFromTickSeq: 5,
        topUpToTickSeq: 15,
        // F2 — four ticks are already on the ledger, so the row's `last_tick_seq` is 4. The
        // caller MUST declare that; passing the default 0 is exactly the stale pre-read the
        // divergence guard refuses.
        minutesAlreadyDrawn: 4,
        shape: 'held',
        floorApplied: true, // ruleMinutes(15) > actualMinutes(4) — the floor is what raised it
        outcome: 'completed',
      })
    );

    expect(res.ticksPosted).toBe(11);
    // ELEVEN new rows, keys :5 … :15 — the first four are never re-posted.
    expect(await consumeKeys(id)).toEqual(
      Array.from({ length: 15 }, (_, index) => `session_consume:${id}:${index + 1}`)
    );
    // …and the wallet is down by exactly FIFTEEN minutes in total, not 19 and not 4.
    expect(await walletBalance(ctx.walletId)).toBe(50_000 - 15 * CLIENT_RATE_PER_MIN);

    expect(res.session.connectedMinutes).toBe(15); // the FLOORED figure
    expect(res.session.actualMinutes).toBe(4); // …and the delivered one, still recoverable
    expect(res.session.expertAccruedMinor).toBe(15 * EXPERT_RATE_PER_MIN);
  });

  it('⚠ NO REFUND: a rule figure BELOW what was already drawn settles at the drawn figure', async () => {
    // The Q1 residual, executed. The caller (`resolveMeetingSettlement`) has already clamped
    // `billableMinutes` UP to `minutesAlreadyDrawn`, so `topUpFrom > topUpTo` and this method
    // posts NOTHING. The ledger is append-only — settlement can never claw a minute back.
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(10), {
      floorMinutes: METER_FLOOR_MINUTES,
    });

    const res = await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meetingId, {
        billableMinutes: 10, // clamped UP from a rule figure of 6
        actualMinutes: 6,
        topUpFromTickSeq: 11,
        topUpToTickSeq: 10, // from > to ⇒ the loop is empty
        minutesAlreadyDrawn: 10, // F2 — ten ticks are on the ledger; the row agrees
        shape: 'held',
        // ⚠ F14 — **FALSE**, and that is the entire point of threading it. The billed figure
        // (10) EXCEEDS the delivered one (6), so the naive `billable > actual` derivation says
        // "floored" — but no floor was involved: `ruleMinutes` was 6 and the Q1 NO-REFUND CLAMP
        // is what raised it. Recording `true` here would file this overcharge under "the
        // minimum bound", which is the opposite of what happened.
        floorApplied: false,
        outcome: 'completed',
      })
    );

    expect(res.ticksPosted).toBe(0);
    expect(await consumeKeys(id)).toHaveLength(10);
    expect(await walletBalance(ctx.walletId)).toBe(50_000 - 10 * CLIENT_RATE_PER_MIN);
    expect(res.session.connectedMinutes).toBe(10);
    expect(res.session.actualMinutes).toBe(6);

    // ⚠⚠ F14 — THE FORENSIC RECORD TELLS THE TRUTH. Both the persisted column and the audit
    // row must say `false`: this is the only durable evidence distinguishing a Q1 overcharge
    // from a legitimate floor application, and `finalizeBilling`'s `floored:` metric reads it.
    expect(res.session.floorApplied).toBe(false);
    const [audit] = await sessionAudits(id, 'credit_session.presence_settled');
    expect(audit?.metadata).toMatchObject({
      billableMinutes: 10,
      actualMinutes: 6,
      floorApplied: false,
      minutesAlreadyDrawn: 10,
    });
  });
});

// ── F6 — THE D12 INVARIANT, EXECUTED AGAINST THE REAL TRANSACTION ─────────────────────────
//
// ⚠⚠ THE UNIT-LEVEL VERSION OF THIS ASSERTION WAS TAUTOLOGICAL. It computed
// `clientChargeMinor = billableMinutes × CLIENT_RATE` and then asserted
// `clientChargeMinor / CLIENT_RATE === billableMinutes` — an arithmetic identity over its own
// local variables, exercising NO production code. It would have passed unchanged even if
// `settleFromPresence` had used a DIFFERENT figure for the accrual than for the ticks.
//
// The coupling lives in the repository — the tick loop (`for seq = from … to`) and the accrual
// (`billableMinutes × expertRateMinorPerMinute`) — and it is only real if the LEDGER, the
// SESSION ROW and the ACCRUAL all agree after a genuine settlement. ADR-1044 asked for an
// EXECUTABLE invariant; this is it.
describe('⚠ INVARIANT (D12): ledger ticks === connected_minutes === accrual ÷ expert rate', () => {
  /** Assert the three-way identity over one settled session, from the DB alone. */
  async function assertIdenticalFigure(
    sessionId: string,
    expectedBillableMinutes: number
  ): Promise<void> {
    const session = await creditSessionsRepository.findById(sessionId);
    if (session === undefined) throw new Error('settled session vanished');
    const ticks = await consumeKeys(sessionId);

    // 1. The LEDGER (the source of truth, ADR-1040) holds exactly that many draws…
    expect(ticks).toHaveLength(expectedBillableMinutes);
    // 2. …the row's own figure is the SAME number, not a rounded or stale one…
    expect(session.connectedMinutes).toBe(expectedBillableMinutes);
    // 3. …and the expert accrual divides back to it EXACTLY at the snapshotted expert rate.
    //    Distinct rates (700 client / 500 expert here) so "same MINUTES" can never be
    //    mistaken for "same AMOUNT".
    expect(session.expertAccruedMinor % EXPERT_RATE_PER_MIN).toBe(0);
    expect(session.expertAccruedMinor / EXPERT_RATE_PER_MIN).toBe(expectedBillableMinutes);
    // 4. …and the client was charged the SAME minute count at the client rate.
    expect(ticks.length * CLIENT_RATE_PER_MIN).toBe(session.connectedMinutes * CLIENT_RATE_PER_MIN);
  }

  it('holds on a floored no-show settled from `pending` (minutesAlreadyDrawn = 0)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);

    await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meetingId, { actualMinutes: 6, floorApplied: true })
    );

    await assertIdenticalFigure(id, 15);
  });

  // ⚠ THE CASE THE OLD SUITE NEVER REACHED — every one of its cases passed
  // `minutesAlreadyDrawn: 0`, so the top-up branch (where the ticks come from TWO writers) was
  // never exercised at all. Here the live meter posts 4 and settlement posts 11: if the accrual
  // were computed from either half instead of the settled total, this fails.
  it('holds across a TOP-UP, where the meter and settlement each wrote part of the ledger (minutesAlreadyDrawn = 4)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await liveMeeting();
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.connect(id, { now: BASE });
    const metered = await creditSessionsRepository.meterSessionToNow(id, meterAt(4), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    expect(metered.ticksPosted).toBe(4);

    await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meetingId, {
        billableMinutes: 15,
        actualMinutes: 4,
        topUpFromTickSeq: 5,
        topUpToTickSeq: 15,
        minutesAlreadyDrawn: 4,
        shape: 'held',
        floorApplied: true,
        outcome: 'completed',
      })
    );

    await assertIdenticalFigure(id, 15);
  });

  // ⚠ AND THE Q1 CLAMP — the ONE branch that can make the presence-derived figure and the
  // settled figure disagree, and therefore the ONE branch where a wrong accrual basis would
  // actually show up. The rule says 6; ten were already drawn; the settled figure is 10, and
  // the expert must be accrued TEN, not six.
  it('holds when the Q1 no-refund clamp fixed the figure above the rule (minutesAlreadyDrawn = 10)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await liveMeeting();
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(10), {
      floorMinutes: METER_FLOOR_MINUTES,
    });

    await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meetingId, {
        billableMinutes: 10, // clamped UP from a rule figure of 6
        actualMinutes: 6,
        topUpFromTickSeq: 11,
        topUpToTickSeq: 10, // nothing new posted
        minutesAlreadyDrawn: 10,
        shape: 'held',
        floorApplied: false,
        outcome: 'completed',
      })
    );

    await assertIdenticalFigure(id, 10);
  });

  it('holds at ZERO on a missed call — "the expert accrued nothing" is a recorded fact, not a gap', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);

    await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meetingId, {
        billableMinutes: 0,
        actualMinutes: 0,
        topUpFromTickSeq: 1,
        topUpToTickSeq: 0,
        shape: 'missed_call',
        outcome: 'missed_call',
      })
    );

    await assertIdenticalFigure(id, 0);
  });
});

// ── F2 — THE TOCTOU REFUSAL ──────────────────────────────────────────────────────────────
//
// ⚠⚠ `findMeterable` INCLUDES `'presence'` BY DESIGN (D11), so the meter sweep is a DESIGNED
// concurrent writer on `last_tick_seq` — the very column the caller pre-reads OUTSIDE any
// transaction to compute `minutesAlreadyDrawn`. If the meter commits between that pre-read and
// the settlement, every figure the caller computed is stale, and writing them would put
// `connected_minutes` in CONTRADICTION with the append-only ledger: expert under-accrued,
// client receipt understated, delta silently retained — and the caller's Q1 `log.error` firing
// with the stale figure, reading as the benign known-limitation case.
describe('creditSessionsRepository.settleFromPresence — concurrent metering (F2)', () => {
  it('⚠⚠ REFUSES a settlement computed from a stale last_tick_seq, and writes NOTHING', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await liveMeeting();
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.connect(id, { now: BASE });

    // ── the caller's PRE-READ: 18 minutes drawn ──
    await creditSessionsRepository.meterSessionToNow(id, meterAt(18), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    const preRead = await creditSessionsRepository.findById(id);
    expect(preRead?.lastTickSeq).toBe(18);
    const input = settlementInput(id, meetingId, {
      billableMinutes: 18,
      actualMinutes: 18,
      topUpFromTickSeq: 19,
      topUpToTickSeq: 18,
      minutesAlreadyDrawn: 18,
      shape: 'held',
      outcome: 'completed',
    });

    // ── …and the METER SWEEP interleaves, committing ticks 19 and 20 ──
    const metered = await creditSessionsRepository.meterSessionToNow(id, meterAt(20), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    expect(metered.ticksPosted).toBe(2);
    expect(await consumeKeys(id)).toHaveLength(20);

    await expect(creditSessionsRepository.settleFromPresence(input)).rejects.toThrow(
      SettlementDrawDivergedError
    );

    // NOTHING was written: no terminal transition, no marker, no outcome, no audit row — and
    // above all `connected_minutes` was NOT set to 18 while the ledger holds 20 draws.
    const after = await creditSessionsRepository.findById(id);
    expect(after?.status).toBe('active');
    expect(after?.billingFinalizedAt).toBeNull();
    expect(after?.connectedMinutes).toBe(20);
    expect(after?.lastTickSeq).toBe(20);
    expect(await sessionAudits(id, 'credit_session.presence_settled')).toHaveLength(0);
    expect(await sessionAudits(id, 'credit_session.expert_accrued')).toHaveLength(0);
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
    expect(meeting?.outcome).toBeNull();
  });

  it('…and the durability backstop can then settle it against FRESH state, no money lost', async () => {
    // The refusal is only correct if it is RECOVERABLE. The row is left in exactly the shape
    // `findPresenceUnsettled` selects, so the backstop re-reads (20), recomputes, and commits.
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await liveMeeting();
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(18), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    const stale = settlementInput(id, meetingId, {
      billableMinutes: 18,
      actualMinutes: 18,
      topUpFromTickSeq: 19,
      topUpToTickSeq: 18,
      minutesAlreadyDrawn: 18,
      shape: 'held',
      outcome: 'completed',
    });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(20), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    await expect(creditSessionsRepository.settleFromPresence(stale)).rejects.toThrow(
      SettlementDrawDivergedError
    );

    // The meeting terminates and the backstop retries with the fresh figure.
    await db
      .update(meetings)
      .set({ status: 'ended', endedAt: meterAt(20) })
      .where(eq(meetings.id, meetingId));
    const stranded = (await creditSessionsRepository.findPresenceUnsettled(meterAt(60))).map(
      (r) => r.id
    );
    expect(stranded).toContain(id);

    const res = await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meetingId, {
        billableMinutes: 20,
        actualMinutes: 20,
        topUpFromTickSeq: 21,
        topUpToTickSeq: 20,
        minutesAlreadyDrawn: 20,
        shape: 'held',
        outcome: 'completed',
      })
    );

    expect(res.alreadySettled).toBe(false);
    expect(res.session.connectedMinutes).toBe(20);
    // The row and the ledger AGREE, and the expert is accrued all twenty.
    expect(await consumeKeys(id)).toHaveLength(20);
    expect(res.session.expertAccruedMinor).toBe(20 * EXPERT_RATE_PER_MIN);
  });

  it('the guard is on DIVERGENCE, not on non-zero: an agreeing non-zero draw settles normally', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await liveMeeting();
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(4), {
      floorMinutes: METER_FLOOR_MINUTES,
    });

    const res = await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meetingId, {
        billableMinutes: 15,
        actualMinutes: 4,
        topUpFromTickSeq: 5,
        topUpToTickSeq: 15,
        minutesAlreadyDrawn: 4,
        shape: 'held',
        floorApplied: true,
        outcome: 'completed',
      })
    );
    expect(res.ticksPosted).toBe(11);
  });
});

describe('creditSessionsRepository.settleFromPresence — the two ZERO shapes', () => {
  const zeroShapes = [
    { shape: 'missed_call' as const, outcome: 'missed_call' as const },
    // ⚠ D2/D3: `abandoned_wait` has NO `meeting_outcome` label — BAL-412 mints no fourth
    // value — so it lands as `completed` with a ZERO settlement. That is CORRECT, and it is
    // why `settlement_shape` exists: `meetings.outcome` cannot tell the two zeros apart.
    { shape: 'abandoned_wait' as const, outcome: 'completed' as const },
  ];

  for (const { shape, outcome } of zeroShapes) {
    it(`${shape} charges NOTHING, accrues NOTHING and releases the hold in full`, async () => {
      const ctx = await setup({ balanceMinor: 50_000 });
      const meetingId = await endedMeeting();
      const id = await openPresence(ctx, meetingId);

      const res = await creditSessionsRepository.settleFromPresence(
        settlementInput(id, meetingId, {
          billableMinutes: 0,
          actualMinutes: shape === 'missed_call' ? 0 : 8,
          topUpFromTickSeq: 1,
          topUpToTickSeq: 0,
          shape,
          outcome,
        })
      );

      expect(res.ticksPosted).toBe(0);
      expect(res.expertAccruedMinor).toBe(0);
      expect(res.session.connectedMinutes).toBe(0);
      expect(res.session.expertAccruedMinor).toBe(0);
      expect(res.session.settlementShape).toBe(shape);
      expect(res.session.settlementStatus).toBe('not_required');
      // NOT ONE ledger row, and the balance is untouched.
      expect(await consumeKeys(id)).toHaveLength(0);
      expect(await walletBalance(ctx.walletId)).toBe(50_000);
      // The reservation is returned in full.
      expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(0);

      const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
      expect(meeting?.outcome).toBe(outcome);
    });

    it(`${shape} is IDEMPOTENT ON THE ROW MARKER ALONE — there is no ledger key to dedup on`, async () => {
      // ⚠⚠ THE TEST THAT PROVES `billing_finalized_at` IS DOING THE WORK. On a zero shape no
      // `session_consume` row is written at all, so `applyLedgerEntry`'s UNIQUE key cannot be
      // the guard — the row marker read under `FOR UPDATE` is the only thing standing between
      // a retried job and a second hold release.
      const ctx = await setup({ balanceMinor: 50_000 });
      const meetingId = await endedMeeting();
      const id = await openPresence(ctx, meetingId);
      const input = settlementInput(id, meetingId, {
        billableMinutes: 0,
        actualMinutes: 0,
        topUpFromTickSeq: 1,
        topUpToTickSeq: 0,
        shape,
        outcome,
      });

      const first = await creditSessionsRepository.settleFromPresence(input);
      expect(first.alreadySettled).toBe(false);

      const holdIdAfterFirst = first.session.holdId;
      const second = await creditSessionsRepository.settleFromPresence(input);

      expect(second.alreadySettled).toBe(true);
      expect(second.ticksPosted).toBe(0);
      expect(second.outcomeWritten).toBe(false);
      expect(await consumeKeys(id)).toHaveLength(0);
      expect(await sessionAudits(id, 'credit_session.expert_accrued')).toHaveLength(1);
      expect(await sessionAudits(id, 'credit_session.presence_settled')).toHaveLength(1);

      // The hold transitioned ONCE — `released`, and it stayed there.
      if (holdIdAfterFirst !== null) {
        const [hold] = await db
          .select()
          .from(creditHolds)
          .where(eq(creditHolds.id, holdIdAfterFirst));
        expect(hold?.status).toBe('released');
      }
    });
  }
});

describe('creditSessionsRepository.settleFromPresence — idempotency + guards', () => {
  it('a second settlement writes NO ledger row, NO audit row and no second outcome', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);
    const input = settlementInput(id, meetingId);

    const first = await creditSessionsRepository.settleFromPresence(input);
    expect(first.ticksPosted).toBe(15);
    const balanceAfterFirst = await walletBalance(ctx.walletId);

    const second = await creditSessionsRepository.settleFromPresence(input);

    expect(second.alreadySettled).toBe(true);
    expect(second.ticksPosted).toBe(0);
    expect(second.outcomeWritten).toBe(false);
    expect(second.overdraftMinor).toBe(0);
    expect(await walletBalance(ctx.walletId)).toBe(balanceAfterFirst);
    expect(await consumeKeys(id)).toHaveLength(15);
    expect(await sessionAudits(id, 'credit_session.expert_accrued')).toHaveLength(1);
    expect(await sessionAudits(id, 'credit_session.presence_settled')).toHaveLength(1);
  });

  it('treats a LEGACY `ended` session (marker NULL) as already settled — it never re-bills', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    await creditSessionsRepository.end(id, { now: meterAt(3) });
    // A pre-BAL-399 row shape: ended, but with no finalization marker.
    await db
      .update(creditSessions)
      .set({ billingFinalizedAt: null })
      .where(eq(creditSessions.id, id));

    const res = await creditSessionsRepository.settleFromPresence(settlementInput(id, meetingId));

    expect(res.alreadySettled).toBe(true);
    expect(res.ticksPosted).toBe(0);
    expect(await consumeKeys(id)).toHaveLength(3);
  });

  it('refuses a CANCELLED session with InvalidSessionTransitionError', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.cancel(id);

    await expect(
      creditSessionsRepository.settleFromPresence(settlementInput(id, meetingId))
    ).rejects.toThrow(InvalidSessionTransitionError);
    expect(await consumeKeys(id)).toHaveLength(0);
  });

  it('throws SessionNotFoundError for an unknown session', async () => {
    const meetingId = await endedMeeting();
    await expect(
      creditSessionsRepository.settleFromPresence(settlementInput(randomUUID(), meetingId))
    ).rejects.toThrow(SessionNotFoundError);
  });

  it('⚠ REFUSES A MEETING MISMATCH before writing anything — a divergence is caught, not hidden', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const sessionMeetingId = await endedMeeting();
    const otherMeetingId = await endedMeeting();
    const id = await openPresence(ctx, sessionMeetingId);

    await expect(
      creditSessionsRepository.settleFromPresence(settlementInput(id, otherMeetingId))
    ).rejects.toThrow(/belongs to meeting/);

    // Nothing moved: no ticks, no marker, and the OTHER meeting's outcome is untouched.
    expect(await consumeKeys(id)).toHaveLength(0);
    expect((await creditSessionsRepository.findById(id))?.billingFinalizedAt).toBeNull();
    const [other] = await db.select().from(meetings).where(eq(meetings.id, otherMeetingId));
    expect(other?.outcome).toBeNull();
  });

  it('⚠ REJECTS a non-integer or negative figure BEFORE opening a transaction', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);

    await expect(
      creditSessionsRepository.settleFromPresence(
        settlementInput(id, meetingId, { billableMinutes: 15.5 })
      )
    ).rejects.toThrow(/non-negative integer/);
    await expect(
      creditSessionsRepository.settleFromPresence(
        settlementInput(id, meetingId, { actualMinutes: -1 })
      )
    ).rejects.toThrow(/non-negative integer/);

    expect(await consumeKeys(id)).toHaveLength(0);
    expect((await creditSessionsRepository.findById(id))?.status).toBe('pending');
  });

  it('⚠ DOES NOT OVERWRITE an outcome the lifecycle sweep already wrote', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const { meeting } = await meetingFactory({
      values: {
        status: 'ended',
        endedBy: 'system_idle',
        endedAt: meterAt(20),
        outcome: 'missed_call', // BAL-134's sweep got there first
      },
    });
    const id = await openPresence(ctx, meeting.id);

    const res = await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meeting.id, {
        billableMinutes: 0,
        actualMinutes: 0,
        topUpFromTickSeq: 1,
        topUpToTickSeq: 0,
        shape: 'missed_call',
        outcome: 'missed_call',
      })
    );

    // The settlement still completes — only the outcome write is skipped.
    expect(res.alreadySettled).toBe(false);
    expect(res.outcomeWritten).toBe(false);
    expect(res.session.settlementShape).toBe('missed_call');
    const [persisted] = await db.select().from(meetings).where(eq(meetings.id, meeting.id));
    expect(persisted?.outcome).toBe('missed_call');
    expect(await sessionAudits(id, 'credit_session.presence_settled')).toHaveLength(1);
  });

  it('⚠ ADR-1030: a ROLLED-BACK settlement leaves NO audit row, NO tick and NO outcome', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);

    await expect(
      db.transaction(async (tx) => {
        const res = await creditSessionsRepository.settleFromPresence(
          settlementInput(id, meetingId),
          tx as unknown as Database
        );
        expect(res.ticksPosted).toBe(15);
        // Something later in the caller's transaction fails. EVERYTHING must go — the audit
        // rows are the real requirement: a row attesting to a settlement that never committed
        // is worse than no row at all.
        throw new Error('caller failed after settlement');
      })
    ).rejects.toThrow('caller failed after settlement');

    expect(await consumeKeys(id)).toHaveLength(0);
    expect(await sessionAudits(id, 'credit_session.expert_accrued')).toHaveLength(0);
    expect(await sessionAudits(id, 'credit_session.presence_settled')).toHaveLength(0);
    expect(await walletBalance(ctx.walletId)).toBe(50_000);
    const session = await creditSessionsRepository.findById(id);
    expect(session?.status).toBe('pending');
    expect(session?.billingFinalizedAt).toBeNull();
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
    expect(meeting?.outcome).toBeNull();
  });
});

describe('creditSessionsRepository.settleFromPresence — overdraft', () => {
  it('draws the FULL floored figure with NO ceiling clamp, leaving the wallet negative', async () => {
    // Owner Decision 3, applied to the floor: the live ceiling is a UX pause, never a billing
    // cap. Five minutes of balance, a fifteen-minute floor — the overflow becomes an
    // off-session settlement, not a discount.
    // ⚠ BAL-523 — deliberately NOT card-backed (`mandate: true` alone ⇒ the `notify_only`
    // default). `openPresence` estimates FLOOR_MINUTES (3750) against a 1250 balance, so this
    // ALSO pins that the `open()` connect gate stayed mandate-only through BAL-523.
    const ctx = await setup({
      balanceMinor: 5 * CLIENT_RATE_PER_MIN,
      mandate: true,
      overdraftCeilingMinor: 100_000,
    });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);

    const res = await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meetingId, { actualMinutes: 15, shape: 'held', outcome: 'completed' })
    );

    expect(res.ticksPosted).toBe(15);
    expect(res.overdraftMinor).toBe(10 * CLIENT_RATE_PER_MIN);
    expect(res.mandateActive).toBe(true);
    expect(res.session.overdraftSettledMinor).toBe(10 * CLIENT_RATE_PER_MIN);
    expect(res.session.settlementStatus).toBe('processing');
    expect(await walletBalance(ctx.walletId)).toBe(-10 * CLIENT_RATE_PER_MIN);
    // The expert is paid the SAME floored figure regardless of whether the client's card ever
    // settles — the expert-always-paid guarantee, unchanged by ADR-1044 §7.
    expect(res.session.expertAccruedMinor).toBe(15 * EXPERT_RATE_PER_MIN);
  });

  it('⚠ BAL-523 ASYMMETRY: settlement is STILL mandate-only — a wallet the grace predicate REFUSES settles anyway', async () => {
    const ctx = await setup({
      balanceMinor: 5 * CLIENT_RATE_PER_MIN, // 1250
      mandate: true,
      lowBalanceMode: 'notify_only',
      overdraftCeilingMinor: 100_000,
    });
    // ⚠ Read the two predicates on the ACTUAL seeded row, so the asymmetry is executable here and
    // not merely implied by the fixture options: grace entry would refuse this wallet…
    const seeded = await creditWalletsRepository.findById(ctx.walletId);
    if (seeded === undefined) throw new Error('seed failed');
    expect(walletAllowsOverdraftGrace(seeded)).toBe(false);
    expect(isWalletMandateActive(seeded)).toBe(true);

    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId, 5);
    const res = await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meetingId, { actualMinutes: 15, shape: 'held', outcome: 'completed' })
    );
    expect(res.overdraftMinor).toBe(10 * CLIENT_RATE_PER_MIN);
    expect(res.mandateActive).toBe(true); // …but the DEBT is still collectable
    expect(res.session.settlementStatus).toBe('processing');
  });
});

describe('creditSessionsRepository — presence in the reaper finders (BAL-412)', () => {
  it('findMeterable INCLUDES a presence session while its meeting is LIVE — the tick loop still runs under a floor', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await liveMeeting();
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.connect(id, { now: BASE });

    const ids = (await creditSessionsRepository.findMeterable()).map((row) => row.id);
    expect(ids).toContain(id);
  });

  // ── F3 — THE METER STOPS WHEN THE MEETING DOES ──────────────────────────────────────────
  //
  // ⚠⚠ THIS IS A MONEY GUARD, NOT TIDINESS. Both terminal paths call settlement BEST-EFFORT
  // and NON-FATAL, so a settlement that FAULTS leaves the session `active` with its meeting
  // already `ended`. `meterSessionToNow` draws off the WALL CLOCK, `enforceMaxDuration` skips
  // `presence` (Q3), and the Q1 no-refund clamp makes whatever it drew PERMANENT against an
  // append-only ledger. A 20-minute call whose settlement threw at 14:00 would post 15 more
  // ticks and settle at `max(20, 35) = 35` — the client paying 35 minutes for a 20-minute
  // consultation, with no refund primitive in existence to undo it.
  it.each([
    ['ended', 'ended' as const],
    ['cancelled', 'cancelled' as const],
  ])(
    '⚠⚠ findMeterable EXCLUDES a still-active presence session whose meeting is %s',
    async (_label, status) => {
      const ctx = await setup({ balanceMinor: 50_000 });
      const { meeting } = await meetingFactory({
        values:
          status === 'ended'
            ? { status: 'ended', endedBy: 'expert_host', endedAt: meterAt(20) }
            : { status: 'cancelled' },
      });
      const id = await openPresence(ctx, meeting.id);
      await creditSessionsRepository.connect(id, { now: BASE });
      // The session itself is a perfectly ordinary meterable row — status alone cannot tell.
      expect((await creditSessionsRepository.findById(id))?.status).toBe('active');

      const ids = (await creditSessionsRepository.findMeterable()).map((row) => row.id);
      expect(ids).not.toContain(id);
    }
  );

  it('findMeterable EXCLUDES a presence session with NO meeting — there is no presence to reconcile against', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await liveMeeting();
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.connect(id, { now: BASE });
    // Detach it — a shape `open()` cannot produce today, but the LEFT JOIN must fail closed
    // rather than meter money nothing can ever settle.
    await db.update(creditSessions).set({ meetingId: null }).where(eq(creditSessions.id, id));

    const ids = (await creditSessionsRepository.findMeterable()).map((row) => row.id);
    expect(ids).not.toContain(id);
  });

  it('⚠ the join is scoped to `presence` ONLY — a live_capture session with no meeting still meters', async () => {
    // The regression the `or(ne(durationSource,'presence'), …)` arm exists to prevent: every
    // shipped `live_capture` session carries a NULL `meeting_id`, so an INNER join (or an
    // unscoped predicate) would have silently stopped metering the entire shipped fleet.
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });

    const ids = (await creditSessionsRepository.findMeterable()).map((row) => row.id);
    expect(ids).toContain(id);
  });

  // ── F4 — THE REAPER MUST NOT CANCEL THE NO-SHOW IT EXISTS TO SETTLE ─────────────────────
  //
  // ⚠⚠ `cancel()` IS A TRAP DOOR ON THIS PROVENANCE. A client no-show never calls `connect`,
  // so the session sits `pending` — and this reaper's cutoff is anchored on `created_at`, which
  // for a session opened at booking time is routinely stale before the meeting even starts.
  // Cancelling it makes settlement throw `InvalidSessionTransitionError` AND makes
  // `findPresenceUnsettled` (which excludes `cancelled`) unable to recover it: the expert is
  // never paid for the no-show they waited out and `meetings.outcome` is never resolved.
  it('⚠⚠ findStalePending EXCLUDES a stale pending PRESENCE session — cancelling it would strand the no-show', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);
    // Age it well past any cutoff the reaper would use.
    await db
      .update(creditSessions)
      .set({ createdAt: new Date(BASE.getTime() - 24 * 60 * 60_000) })
      .where(eq(creditSessions.id, id));
    expect((await creditSessionsRepository.findById(id))?.status).toBe('pending');

    const ids = (await creditSessionsRepository.findStalePending(meterAt(60))).map((r) => r.id);
    expect(ids).not.toContain(id);

    // …and it is still recoverable by the settlement backstop, which is the whole point.
    const unsettled = (await creditSessionsRepository.findPresenceUnsettled(meterAt(60))).map(
      (r) => r.id
    );
    expect(unsettled).toContain(id);
  });

  it('findStalePending STILL cancels a stale pending live_capture session — the shipped reaper is unchanged', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await db
      .update(creditSessions)
      .set({ createdAt: new Date(BASE.getTime() - 24 * 60 * 60_000) })
      .where(eq(creditSessions.id, id));

    const ids = (await creditSessionsRepository.findStalePending(meterAt(60))).map((r) => r.id);
    expect(ids).toContain(id);
  });

  it('findWrappedIdle EXCLUDES a presence session — its terminator is the meeting sweep', async () => {
    // Auto-ending it here would route it through `end()`, which finalizes at wall-clock
    // minutes with no floor and no outcome — and would then block the real settlement.
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);
    await db
      .update(creditSessions)
      .set({ status: 'wrapped', wrappedAt: BASE })
      .where(eq(creditSessions.id, id));

    const ids = (await creditSessionsRepository.findWrappedIdle(meterAt(60))).map((row) => row.id);
    expect(ids).not.toContain(id);
  });
});

/**
 * BAL-466 (§F) — ⚠⚠ THE END-TO-END PROOF THE THREE SETTLEMENT PATHS ARE NOW REACHABLE.
 *
 * The predicates above were all proven individually under BAL-412, seeded by `openPresence`
 * (which calls `creditSessionsRepository.open({ durationSource: 'presence', meetingId })`
 * directly — the exact call `apps/api`'s `openSession` now forwards from `join-meeting.ts`'s
 * `openCaseSessionBestEffort`, per `open-session.test.ts`'s "is forwarded to
 * creditSessionsRepository.open" and `join-meeting.test.ts`'s "durationSource: 'presence'"
 * assertions). This test is the single, explicit, ONE-TEST proof that opening a session this
 * way carries it through the FULL predicate lifecycle a Case consultation now takes at
 * admission: selected by the live meter while the meeting runs (`active` AND `grace`),
 * selected by the durability backstop once the meeting ends unsettled, and EXCLUDED from the
 * two reaper finders whose job is a different provenance entirely.
 */
describe('creditSessionsRepository — BAL-466, the three settlement paths end to end', () => {
  it('a presence session opened with a meetingId is metered while live, settled once ended, and excluded from the wrong reapers', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await liveMeeting();
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.connect(id, { now: BASE });

    // (a) findMeterable SELECTS it while the meeting is live and status='active'.
    expect((await creditSessionsRepository.findMeterable()).map((r) => r.id)).toContain(id);

    // (a, continued) — and still SELECTS it once metering has pushed it into 'grace'.
    await db.update(creditSessions).set({ status: 'grace' }).where(eq(creditSessions.id, id));
    expect((await creditSessionsRepository.findMeterable()).map((r) => r.id)).toContain(id);

    // (c) the two reaper finders — a DIFFERENT provenance's terminators — do NOT select it.
    expect(
      (await creditSessionsRepository.findStalePending(meterAt(60))).map((r) => r.id)
    ).not.toContain(id);
    expect(
      (await creditSessionsRepository.findWrappedIdle(meterAt(60))).map((r) => r.id)
    ).not.toContain(id);

    // Now the meeting ends, unsettled — the durability backstop's territory.
    await db
      .update(meetings)
      .set({ status: 'ended', endedBy: 'expert_host', endedAt: meterAt(20) })
      .where(eq(meetings.id, meetingId));

    // (a, continued) — a session on an ENDED meeting drops out of the live meter…
    expect((await creditSessionsRepository.findMeterable()).map((r) => r.id)).not.toContain(id);

    // (b) …and findPresenceUnsettled(cutoff) now SELECTS it — the backstop can reach it.
    expect(
      (await creditSessionsRepository.findPresenceUnsettled(meterAt(60))).map((r) => r.id)
    ).toContain(id);
  });
});

describe('creditSessionsRepository.findPresenceUnsettled (BAL-412 durability backstop)', () => {
  const CUTOFF = meterAt(60);

  it('finds a presence session whose meeting ENDED but which never settled', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting(meterAt(20));
    const id = await openPresence(ctx, meetingId);

    const ids = (await creditSessionsRepository.findPresenceUnsettled(CUTOFF)).map((r) => r.id);
    expect(ids).toContain(id);
  });

  it('IGNORES an already-settled session — the marker is the exit condition', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting(meterAt(20));
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.settleFromPresence(settlementInput(id, meetingId));

    const ids = (await creditSessionsRepository.findPresenceUnsettled(CUTOFF)).map((r) => r.id);
    expect(ids).not.toContain(id);
  });

  it('IGNORES a CANCELLED session — its marker stays NULL forever and it would never drain', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting(meterAt(20));
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.cancel(id);

    const ids = (await creditSessionsRepository.findPresenceUnsettled(CUTOFF)).map((r) => r.id);
    expect(ids).not.toContain(id);
  });

  it('IGNORES a soft-deleted session, a live_capture session, and one with no meeting', async () => {
    const ctx = await setup({ balanceMinor: 500_000 });
    const deletedMeetingId = await endedMeeting(meterAt(20));
    const deletedId = await openPresence(ctx, deletedMeetingId);
    await db
      .update(creditSessions)
      .set({ deletedAt: new Date() })
      .where(eq(creditSessions.id, deletedId));

    // A live_capture session on an ended meeting — finalized at hang-up, never from presence.
    const liveCaptureMeetingId = await endedMeeting(meterAt(20));
    const liveCaptureRes = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
      meetingId: liveCaptureMeetingId,
    });
    if (!liveCaptureRes.ok) throw new Error(`expected open ok, got ${liveCaptureRes.code}`);
    await creditSessionsRepository.cancel(liveCaptureRes.session.id);

    // A presence session with NO meeting at all — structurally absent (INNER join).
    const orphanRes = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 10,
      durationSource: 'presence',
    });
    if (!orphanRes.ok) throw new Error(`expected open ok, got ${orphanRes.code}`);

    const ids = (await creditSessionsRepository.findPresenceUnsettled(CUTOFF)).map((r) => r.id);
    expect(ids).not.toContain(deletedId);
    expect(ids).not.toContain(liveCaptureRes.session.id);
    expect(ids).not.toContain(orphanRes.session.id);
  });

  it('IGNORES a still-LIVE meeting, and one that ended AFTER the cutoff (the in-flight grace)', async () => {
    const ctx = await setup({ balanceMinor: 500_000 });
    const { meeting: live } = await meetingFactory({ values: { status: 'in_progress' } });
    const liveId = await openPresence(ctx, live.id);
    await creditSessionsRepository.cancel(liveId); // free the one-live-session-per-wallet gate

    const recentMeetingId = await endedMeeting(meterAt(90)); // after CUTOFF
    const recentId = await openPresence(ctx, recentMeetingId);

    const ids = (await creditSessionsRepository.findPresenceUnsettled(CUTOFF)).map((r) => r.id);
    expect(ids).not.toContain(liveId);
    expect(ids).not.toContain(recentId);
  });

  it('honours the batch bound', async () => {
    const ctx = await setup({ balanceMinor: 500_000 });
    const meetingId = await endedMeeting(meterAt(20));
    await openPresence(ctx, meetingId);

    expect(await creditSessionsRepository.findPresenceUnsettled(CUTOFF, 0)).toHaveLength(0);
  });
});

describe('creditSessionsRepository — legacy rows are unchanged by BAL-412', () => {
  it('a live_capture session finalized the shipped way carries NULL on all three new columns', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(3), {
      floorMinutes: METER_FLOOR_MINUTES,
    });
    await creditSessionsRepository.end(id, { now: meterAt(3) });

    const clientView = await creditSessionsRepository.findForClientMoneyView(id);
    const expertView = await creditSessionsRepository.findForExpertView(id);
    const adminView = await creditSessionsRepository.findForAdminView(id);

    for (const view of [clientView, expertView, adminView]) {
      expect(view?.actualMinutes).toBeNull();
      expect(view?.billingFloorMinutes).toBeNull();
      expect(view?.settlementShape).toBeNull();
    }

    // …and the shipped money block is byte-identical to what it was before the migration.
    expect(clientView).toBeDefined();
    if (clientView !== undefined) {
      const block = toClientMoneyBlock(clientView);
      expect(block.state).toBe('finalized');
      expect(block.durationMinutes).toBe(3);
      expect(block.amountAudMinor).toBe(3 * CLIENT_RATE_PER_MIN);
      expect(block.finalizationPath).toBe('live_capture');
    }
  });

  it('the CLIENT drawdown view carries the three new columns and STILL excludes the fee/PII set', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await endedMeeting();
    const id = await openPresence(ctx, meetingId);
    await creditSessionsRepository.settleFromPresence(
      settlementInput(id, meetingId, { actualMinutes: 6, floorApplied: true })
    );

    const view = await creditSessionsRepository.findForClientView(id);
    expect(view?.actualMinutes).toBe(6);
    expect(view?.billingFloorMinutes).toBe(15);
    expect(view?.settlementShape).toBe('no_show_client');

    // The fee boundary is UNCHANGED — durations and labels are not figures.
    const keys = Object.keys(view ?? {});
    for (const banned of [
      'expertRateMinorPerHour',
      'expertRateMinorPerMinute',
      'expertAccruedMinor',
      'baloFeeBps',
      'stripePaymentIntentId',
    ]) {
      expect(keys).not.toContain(banned);
    }
  });
});

/**
 * ⚠⚠ BAL-410 — THE CREDIT UNWIND OF A CANCELLED MEETING. THE HIGHEST-VALUE COVERAGE IN THAT
 * TICKET, AND THE ONLY PROOF ITS MOST IMPORTANT HALF RAN — nothing on screen changes whether or
 * not the hold is released.
 *
 * Two claims live here:
 *   1. the AC "no ledger entry other than the hold release", asserted as the LEDGER MODEL
 *      ACTUALLY WORKS (see the comment on the first test — do not "fix" it), and
 *   2. `findPendingForCancelledMeetings`, the DURABILITY BACKSTOP. The in-request release in
 *      `apps/api`'s cancel route has no second chance: cancelling removes the meeting from
 *      every reaper, so one transient failure would strand the hold permanently and lock the
 *      company out of every future Case session.
 */
describe('creditSessionsRepository — cancelling a booked meeting’s session (BAL-410)', () => {
  /** A `scheduled` meeting — the state a cancellable booking is in. */
  async function scheduledMeeting(): Promise<string> {
    const { meeting } = await meetingFactory({ values: { status: 'scheduled' } });
    return meeting.id;
  }

  async function cancelMeetingRow(meetingId: string): Promise<void> {
    await db.update(meetings).set({ status: 'cancelled' }).where(eq(meetings.id, meetingId));
  }

  async function ledgerRowCount(walletId: string): Promise<number> {
    const rows = await db.select().from(creditLedger).where(eq(creditLedger.walletId, walletId));
    return rows.length;
  }

  /**
   * ⚠⚠ THE AC, ASSERTED AS THE LEDGER MODEL ACTUALLY WORKS. The ticket says "assert no ledger
   * entry OTHER THAN the hold release" — but a hold release writes NO `credit_ledger` row at
   * all: `creditHoldsRepository` imports only `credit_holds` / `credit_wallets` and never calls
   * `applyLedgerEntry`. A hold RESERVES against the available balance; it moves no money. So
   * the correct, testable form of the AC is: the ledger row count is UNCHANGED across the
   * cancel, AND the hold transitions `active → released`. ⚠ DO NOT "CORRECT" THIS TO EXPECT ONE
   * RELEASE ROW — there is none, and the test would fail.
   */
  it('⚠ AC — releases the hold in full and writes NO credit_ledger row', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await scheduledMeeting();
    const sessionId = await openPresence(ctx, meetingId, 30);

    const heldMinor = 30 * CLIENT_RATE_PER_MIN;
    const balanceBefore = await creditWalletsRepository.findById(ctx.walletId);
    expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(heldMinor);
    // The available balance is REDUCED while the hold stands — that is the thing a stranded
    // hold would reduce forever.
    expect(await creditHoldsRepository.getAvailableBalance(ctx.walletId)).toBe(
      (balanceBefore?.balanceMinor ?? 0) - heldMinor
    );
    const ledgerBefore = await ledgerRowCount(ctx.walletId);

    await cancelMeetingRow(meetingId);
    const cancelled = await creditSessionsRepository.cancel(sessionId, {
      memberId: ctx.memberId,
    });

    expect(cancelled.status).toBe('cancelled');
    // 1. NOT ONE new ledger row.
    expect(await ledgerRowCount(ctx.walletId)).toBe(ledgerBefore);
    // 2. The hold moved `active → released`, stamped with the resolving actor.
    const [hold] = await db
      .select()
      .from(creditHolds)
      .where(eq(creditHolds.id, cancelled.holdId ?? ''));
    expect(hold?.status).toBe('released');
    expect(hold?.resolvedAt).not.toBeNull();
    expect(hold?.memberId).toBe(ctx.memberId);
    // 3. The available balance is back to the pre-hold figure.
    expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(0);
    expect(await creditHoldsRepository.getAvailableBalance(ctx.walletId)).toBe(
      balanceBefore?.balanceMinor ?? 0
    );
  });

  /**
   * ⚠ RETRY IDEMPOTENCY, FOR FREE. `findIdByMeetingId` filters `status <> 'cancelled'`, so the
   * in-request release finds nothing on a second pass — one of the two independent mechanisms
   * that make the whole unwind safe to retry (the other is `cancel`'s own early return).
   */
  it('findIdByMeetingId stops seeing the session once it is cancelled', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await scheduledMeeting();
    const sessionId = await openPresence(ctx, meetingId, 30);

    expect(await creditSessionsRepository.findIdByMeetingId(meetingId)).toEqual({ id: sessionId });

    await creditSessionsRepository.cancel(sessionId, { memberId: ctx.memberId });

    expect(await creditSessionsRepository.findIdByMeetingId(meetingId)).toBeUndefined();
  });

  /**
   * ⚠ THE BAL-412 BOUNDARY. A metering session means the call is UNDERWAY, which is the
   * no-show / settlement path, NOT cancellation. `cancel` refuses it — and releases nothing, so
   * a caller that swallowed the throw would not silently free money mid-call.
   */
  it('REFUSES an already-connected session and releases NOTHING', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await liveMeeting();
    const sessionId = await openPresence(ctx, meetingId, 30);
    await creditSessionsRepository.connect(sessionId, { now: BASE });
    const heldBefore = await creditHoldsRepository.sumActiveByWallet(ctx.walletId);

    await expect(
      creditSessionsRepository.cancel(sessionId, { memberId: ctx.memberId })
    ).rejects.toBeInstanceOf(InvalidSessionTransitionError);

    expect(await creditHoldsRepository.sumActiveByWallet(ctx.walletId)).toBe(heldBefore);
  });
});

describe('creditSessionsRepository.findPendingForCancelledMeetings (BAL-410 backstop)', () => {
  async function meetingWithStatus(status: 'scheduled' | 'cancelled' | 'ended'): Promise<string> {
    const { meeting } = await meetingFactory({
      values:
        status === 'ended' ? { status, endedBy: 'expert_host', endedAt: meterAt(20) } : { status },
    });
    return meeting.id;
  }

  async function cancelMeetingRow(meetingId: string): Promise<void> {
    await db.update(meetings).set({ status: 'cancelled' }).where(eq(meetings.id, meetingId));
  }

  it('finds a PENDING session whose meeting is cancelled', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await meetingWithStatus('scheduled');
    const id = await openPresence(ctx, meetingId, 30);
    await cancelMeetingRow(meetingId);

    const ids = (await creditSessionsRepository.findPendingForCancelledMeetings()).map((r) => r.id);

    expect(ids).toContain(id);
  });

  /**
   * ⚠⚠ NO `duration_source` FILTER, AND THAT IS THE POINT — it is what distinguishes this
   * finder from `findStalePending`, which EXCLUDES `presence` to protect the no-show settlement
   * of an ENDED meeting. On a CANCELLED meeting there is nothing to settle for ANY provenance
   * (`findPresenceUnsettled` requires `status='ended'`), so every one is releasable.
   */
  it('⚠ finds a session of EITHER provenance — live_capture as well as presence', async () => {
    /**
     * ⚠ TWO WALLETS, DELIBERATELY — NOT a tidiness choice. `open()`'s
     * one-live-session-per-wallet gate refuses a second session while the first is still
     * `pending`, and cancelling the MEETING row does not cancel the SESSION — that stranding is
     * the whole premise of this backstop. Seeding both provenances on ONE wallet would assert
     * the gate, not the finder. The finder is not wallet-scoped, so two wallets still prove the
     * "no `duration_source` filter" claim in a single call.
     */
    const presenceCtx = await setup({ balanceMinor: 200_000 });
    const presenceMeetingId = await meetingWithStatus('scheduled');
    const presenceId = await openPresence(presenceCtx, presenceMeetingId, 15);
    await cancelMeetingRow(presenceMeetingId);

    const captureCtx = await setup({ balanceMinor: 200_000 });
    const captureMeetingId = await meetingWithStatus('scheduled');
    const captureRes = await creditSessionsRepository.open({
      walletId: captureCtx.walletId,
      companyId: captureCtx.companyId,
      expertProfileId: captureCtx.expertProfileId,
      initiatingMemberId: captureCtx.memberId,
      estimatedMinutes: 15,
      meetingId: captureMeetingId,
    });
    if (!captureRes.ok) throw new Error(`expected open ok, got ${captureRes.code}`);
    await cancelMeetingRow(captureMeetingId);

    const ids = (await creditSessionsRepository.findPendingForCancelledMeetings()).map((r) => r.id);

    expect(ids).toContain(presenceId);
    expect(ids).toContain(captureRes.session.id);
  });

  it.each(['scheduled', 'ended'] as const)(
    'IGNORES a session whose meeting is %s — only a cancelled meeting frees its hold here',
    async (status) => {
      const ctx = await setup({ balanceMinor: 50_000 });
      const meetingId = await meetingWithStatus(status);
      const id = await openPresence(ctx, meetingId, 15);

      const ids = (await creditSessionsRepository.findPendingForCancelledMeetings()).map(
        (r) => r.id
      );

      expect(ids).not.toContain(id);
    }
  );

  it('IGNORES an already-cancelled session — the exit condition, so the sweep converges', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const meetingId = await meetingWithStatus('scheduled');
    const id = await openPresence(ctx, meetingId, 15);
    await cancelMeetingRow(meetingId);
    await creditSessionsRepository.cancel(id, { memberId: ctx.memberId });

    const ids = (await creditSessionsRepository.findPendingForCancelledMeetings()).map((r) => r.id);

    expect(ids).not.toContain(id);
  });

  it('IGNORES a soft-deleted session and a soft-deleted meeting', async () => {
    const ctx = await setup({ balanceMinor: 200_000 });

    const deletedSessionMeetingId = await meetingWithStatus('scheduled');
    const deletedSessionId = await openPresence(ctx, deletedSessionMeetingId, 15);
    await cancelMeetingRow(deletedSessionMeetingId);
    await db
      .update(creditSessions)
      .set({ deletedAt: new Date() })
      .where(eq(creditSessions.id, deletedSessionId));

    const deletedMeetingId = await meetingWithStatus('scheduled');
    const onDeletedMeetingId = await openPresence(ctx, deletedMeetingId, 15);
    await cancelMeetingRow(deletedMeetingId);
    await db
      .update(meetings)
      .set({ deletedAt: new Date() })
      .where(eq(meetings.id, deletedMeetingId));

    const ids = (await creditSessionsRepository.findPendingForCancelledMeetings()).map((r) => r.id);

    expect(ids).not.toContain(deletedSessionId);
    expect(ids).not.toContain(onDeletedMeetingId);
  });

  it('IGNORES a session with NO meeting at all — structurally absent (INNER join)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const orphanRes = await creditSessionsRepository.open({
      walletId: ctx.walletId,
      companyId: ctx.companyId,
      expertProfileId: ctx.expertProfileId,
      initiatingMemberId: ctx.memberId,
      estimatedMinutes: 15,
    });
    if (!orphanRes.ok) throw new Error(`expected open ok, got ${orphanRes.code}`);

    const ids = (await creditSessionsRepository.findPendingForCancelledMeetings()).map((r) => r.id);

    expect(ids).not.toContain(orphanRes.session.id);
  });

  it('honours the batch limit — the bound a caller must not silently exceed', async () => {
    // ⚠ A WALLET PER SESSION — see the EITHER-provenance test above: a stranded `pending`
    // session blocks the next `open()` on the same wallet, so three sessions need three wallets.
    for (let i = 0; i < 3; i += 1) {
      const ctx = await setup({ balanceMinor: 500_000 });
      const meetingId = await meetingWithStatus('scheduled');
      await openPresence(ctx, meetingId, 15);
      await cancelMeetingRow(meetingId);
    }

    expect(await creditSessionsRepository.findPendingForCancelledMeetings(2)).toHaveLength(2);
  });
});
