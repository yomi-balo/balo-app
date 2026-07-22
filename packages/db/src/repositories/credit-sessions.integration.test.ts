import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  applyBaloFee,
  deriveMinuteRateCents,
  DEFAULT_BALO_FEE_BPS,
  DEFAULT_OVERDRAFT_CEILING_MINOR,
} from '@balo/shared/pricing';
import { db } from '../client';
import {
  auditEvents,
  creditHolds,
  creditLedger,
  creditSessions,
  expertPayoutRecords,
  expertProfiles,
  type NewCreditWallet,
} from '../schema';
import { creditWalletFactory, expertFactory, userFactory } from '../test/factories';
import {
  creditSessionsRepository,
  CLIENT_SESSION_VIEW_COLUMNS,
  ExternalDurationConflictError,
  InvalidSessionTransitionError,
  SessionNotFoundError,
  type OpenSessionResult,
} from './credit-sessions';
import { expertPayoutRecordsRepository } from './expert-payout-records';
import { toClientMoneyBlock } from './_shared/credit-views';
import { creditLedgerRepository } from './credit-ledger';
import { creditReceivablesRepository } from './credit-receivables';
import { creditHoldsRepository } from './credit-holds';
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

/** `BASE + minutes` + a 30s cushion so `floor((now − connectedAt)/60s)` lands on `minutes`. */
function meterAt(minutes: number): Date {
  return new Date(BASE.getTime() + minutes * 60_000 + 30_000);
}

interface SetupOpts {
  balanceMinor?: number;
  mandate?: boolean;
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

  it('accepts a zero-balance wallet WITH an active mandate (the grace path)', async () => {
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
    await creditSessionsRepository.meterSessionToNow(id, meterAt(3));
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
    await creditSessionsRepository.meterSessionToNow(id, meterAt(24)); // 24×250=6000 vs 5000 → −1000
    const end = await creditSessionsRepository.end(id, { now: meterAt(24) });
    expect(end.overdraftMinor).toBe(1000);
    expect(end.session.settlementStatus).toBe('processing');
    return { sessionId: id, overdraftMinor: end.overdraftMinor };
  }

  it('rejects settlement_pending while a prior overdraft is unsettled (balance < 0, no receivable)', async () => {
    const ctx = await setup({ balanceMinor: 5000, mandate: true, overdraftCeilingMinor: 100_000 });
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
    const ctx = await setup({ balanceMinor: 5000, mandate: true, overdraftCeilingMinor: 100_000 });
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
    const ctx = await setup({ balanceMinor: 5000, mandate: true, overdraftCeilingMinor: 100_000 });
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
    const ctx = await setup({ balanceMinor: 5000, mandate: true, overdraftCeilingMinor: 100_000 });
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

    const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(3));
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

    await creditSessionsRepository.meterSessionToNow(id, meterAt(3));
    const again = await creditSessionsRepository.meterSessionToNow(id, meterAt(3));
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

    const first = await creditSessionsRepository.meterSessionToNow(id, meterAt(1));
    expect(first.transitions.low).toBe(true);
    const marker = first.session.lowWarnedAt?.getTime();
    expect(marker).toBeDefined();

    const second = await creditSessionsRepository.meterSessionToNow(id, meterAt(2));
    expect(second.transitions.low).toBeUndefined(); // not re-crossed
    expect(second.session.lowWarnedAt?.getTime()).toBe(marker); // unchanged
  });
});

describe('creditSessionsRepository.meterSessionToNow — grace / wrap state machine', () => {
  it('enters grace at zero-with-mandate and posts the crossing (negative) tick', async () => {
    // balance 500 → min1 250, min2 0, min3 crosses to −250 → grace.
    const ctx = await setup({ balanceMinor: 500, mandate: true, overdraftCeilingMinor: 100_000 });
    const id = await openOk(ctx, 2);
    await creditSessionsRepository.connect(id, { now: BASE });

    const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(3));
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

    const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(3));
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
    const ctx = await setup({ balanceMinor: 500, mandate: true, overdraftCeilingMinor: 500 });
    const id = await openOk(ctx, 2);
    await creditSessionsRepository.connect(id, { now: BASE });

    const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(6));
    expect(res.session.status).toBe('wrapped');
    expect(res.transitions.ceilingHit).toBe(true);
    expect(res.transitions.wrapped).toBe(true);
    expect(res.session.lastTickSeq).toBe(4); // stopped ON the ceiling-crossing minute
    const wallet = await creditWalletsRepository.findById(ctx.walletId);
    expect(wallet?.balanceMinor).toBe(-500);
  });

  it('wraps on the 30-min (grace-bound) timeout when the ceiling is not reached', async () => {
    const ctx = await setup({ balanceMinor: 250, mandate: true, overdraftCeilingMinor: 1_000_000 });
    const id = await openOk(ctx, 1);
    await creditSessionsRepository.connect(id, { now: BASE });
    // Shrink the grace bound snapshot to 3 min for a fast, deterministic time-bound wrap.
    await db.update(creditSessions).set({ graceBoundMinutes: 3 }).where(eq(creditSessions.id, id));

    // min1 → 0, min2 → grace (−250), grace bound 3 min from min2 → wrap at min5.
    const res = await creditSessionsRepository.meterSessionToNow(id, meterAt(8));
    expect(res.session.status).toBe('wrapped');
    expect(res.transitions.wrapped).toBe(true);
    expect(res.transitions.ceilingHit).toBeUndefined(); // time bound, not ceiling
    expect(res.session.lastTickSeq).toBe(5);
  });
});

// ── end — settlement basis + expert accrual ───────────────────────────────

describe('creditSessionsRepository.end — accrual, overdraft, promo exclusion', () => {
  it('promo is EXCLUDED from the settlement basis (overdraftSettledMinor = |terminal negative|)', async () => {
    const ctx = await setup({ mandate: true, overdraftCeilingMinor: 100_000 });
    // Single fungible balance = 3000 promo + 2000 paid = 5000; drain to a terminal −1000.
    await credit(ctx.walletId, 'promo', 3000);
    await credit(ctx.walletId, 'manual_purchase', 2000, ctx.memberId);

    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    // 24 min × 250 = 6000 charged; 6000 − 5000 = 1000 overdraft (pure cash; promo consumed first).
    await creditSessionsRepository.meterSessionToNow(id, meterAt(24));

    const end = await creditSessionsRepository.end(id, { now: meterAt(24) });
    expect(end.overdraftMinor).toBe(1000);
    expect(end.session.overdraftSettledMinor).toBe(1000); // NOT 1000 + 3000 promo
    expect(end.session.settlementStatus).toBe('processing');
    expect(end.session.status).toBe('ended');
    expect(end.mandateActive).toBe(true);
  });

  it('finalizes the expert accrual + writes the expert_accrued audit row EVEN WITH overdraft', async () => {
    const ctx = await setup({ balanceMinor: 5000, mandate: true, overdraftCeilingMinor: 100_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(24)); // drains to −1000

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
    await creditSessionsRepository.meterSessionToNow(id, meterAt(3));

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
    await creditSessionsRepository.meterSessionToNow(id, meterAt(2));

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
    const ctx = await setup({ balanceMinor: 5000, mandate: true, overdraftCeilingMinor: 100_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(24));
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
    const ctx = await setup({ balanceMinor: 5000, mandate: true, overdraftCeilingMinor: 100_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(24));
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
    await creditSessionsRepository.meterSessionToNow(wrappedId, meterAt(3)); // → wrapped
    await db
      .update(creditSessions)
      .set({ wrappedAt: new Date(BASE.getTime() - 60 * 60_000) })
      .where(eq(creditSessions.id, wrappedId));
    const idle = await creditSessionsRepository.findWrappedIdle(BASE);
    expect(idle.map((s) => s.id)).toContain(wrappedId);

    // Stuck settling — end with overdraft (processing), backdate endedAt.
    const ctx2 = await setup({ balanceMinor: 5000, mandate: true, overdraftCeilingMinor: 100_000 });
    const settleId = await openOk(ctx2, 10);
    await creditSessionsRepository.connect(settleId, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(settleId, meterAt(24));
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

describe('creditSessionsRepository.end — billing-finalization stamping (BAL-399)', () => {
  it('stamps billingFinalizedAt + finalizationPath=live_capture by default', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(3));
    const end = await creditSessionsRepository.end(id, { now: meterAt(3) });

    expect(end.session.billingFinalizedAt).not.toBeNull();
    expect(end.session.finalizationPath).toBe('live_capture');
  });

  it('records an explicit finalizationPath (external/BAL-133 finalizer)', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(2));
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
    const ctx = await setup({ balanceMinor: 500, mandate: true, overdraftCeilingMinor: 100_000 });
    const id = await openOk(ctx, 10);
    await creditSessionsRepository.connect(id, { now: BASE });
    await creditSessionsRepository.meterSessionToNow(id, meterAt(5)); // 5 ticks; minutes 3-5 = grace
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
    await creditSessionsRepository.meterSessionToNow(id, meterAt(3));
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

// ── hasActiveSessionForWallet (BAL-379 auto-top-up safe-to-charge gate) ─────

describe('creditSessionsRepository.hasActiveSessionForWallet', () => {
  it('is false for a wallet with no sessions', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    expect(await creditSessionsRepository.hasActiveSessionForWallet(db, ctx.walletId)).toBe(false);
  });

  // Every non-terminal status blocks a between-session reload (data-driven — one shape).
  for (const status of ['pending', 'active', 'grace', 'wrapped'] as const) {
    it(`is true for a non-terminal '${status}' session`, async () => {
      const ctx = await setup({ balanceMinor: 50_000 });
      const id = await openOk(ctx); // opens 'pending'
      if (status !== 'pending') {
        await db.update(creditSessions).set({ status }).where(eq(creditSessions.id, id));
      }
      expect(await creditSessionsRepository.hasActiveSessionForWallet(db, ctx.walletId)).toBe(true);
    });
  }

  it("is true when a prior (terminal) session's settlement is still 'processing'", async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({ status: 'ended', settlementStatus: 'processing' })
      .where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasActiveSessionForWallet(db, ctx.walletId)).toBe(true);
  });

  it('is false when the only session is terminal and settled', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db
      .update(creditSessions)
      .set({ status: 'ended', settlementStatus: 'settled' })
      .where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasActiveSessionForWallet(db, ctx.walletId)).toBe(false);
  });

  it('is false when the only non-terminal session is soft-deleted', async () => {
    const ctx = await setup({ balanceMinor: 50_000 });
    const id = await openOk(ctx);
    await db.update(creditSessions).set({ deletedAt: new Date() }).where(eq(creditSessions.id, id));
    expect(await creditSessionsRepository.hasActiveSessionForWallet(db, ctx.walletId)).toBe(false);
  });
});
