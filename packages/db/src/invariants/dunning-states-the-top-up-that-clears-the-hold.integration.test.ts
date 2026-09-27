import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { creditCoversOutstandingDebt } from '@balo/shared/credit';
import { db } from '../client';
import { expertProfiles } from '../schema';
import { creditWalletFactory, expertFactory, userFactory } from '../test/factories';
import { creditLedgerRepository } from '../repositories/credit-ledger';
import { creditReceivablesRepository } from '../repositories/credit-receivables';
import { creditSessionsRepository } from '../repositories/credit-sessions';

/**
 * ⚠⚠ INVARIANT (integration) — THE DUNNING FIGURE IS THE TOP-UP THAT CLEARS THE HOLD, READ FROM A
 * REAL WALLET. ADR-1040 Amendment 7 §G (BAL-474, D6.2 / D7.1 / D7.2). The pure half — the figure
 * is exactly the coverage predicate's shortfall, over a grid — is the sibling unit suite; this
 * half proves `creditReceivablesRepository.readHoldStatus` reads that figure off a wallet carrying
 * SEVERAL debts and a promo, and that the daily reminder's due set is wallet-grain and fair.
 *
 * ⚠ The notice-level cases (a second debt at 16:00 gets a fresh notice at once; a covered-but-
 * held wallet is healed by the claim and by the booking guard) need `apps/api`'s `notify.ts`, which
 * a `packages/db` file must not import — they live in
 * `apps/api/src/jobs/receivable-dunning-sweep.integration.test.ts`.
 *
 * Per ADR-1032 this was AUTHORED AND RUN RED before `readHoldStatus`,
 * `listWalletsDueForDailyDunning` and `stampDailyDunning` existed.
 */

const EXPERT_HOURLY = 12_000;
const HOUR_MS = 60 * 60_000;

interface DebtWallet {
  walletId: string;
  companyId: string;
  memberId: string;
  sessionIds: [string, string];
}

/**
 * A wallet with TWO real, ENDED sessions (so two receivables can be recorded against them). The
 * sessions are opened, connected and ended through the repository while the wallet is at zero and
 * carries a mandate — the gated open admits them — and both END an hour before the test, so the
 * coverage anchor (`MIN(ended_at)`) precedes every ledger write the test then makes.
 */
async function seedTwoEndedSessions(): Promise<DebtWallet> {
  const { wallet, companyId } = await creditWalletFactory({
    values: {
      balanceMinor: 0,
      mandateStatus: 'active',
      stripeCustomerId: 'cus_dunning',
      stripePaymentMethodId: 'pm_dunning',
    },
  });
  const member = await userFactory();
  const expert = await expertFactory();
  await db
    .update(expertProfiles)
    .set({ rateCents: EXPERT_HOURLY })
    .where(eq(expertProfiles.id, expert.id));

  const endedAt = new Date(Date.now() - HOUR_MS);
  const ids: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const res = await creditSessionsRepository.open({
      walletId: wallet.id,
      companyId,
      expertProfileId: expert.id,
      initiatingMemberId: member.id,
      estimatedMinutes: 10,
    });
    if (!res.ok) throw new Error(`open failed: ${res.code}`);
    await creditSessionsRepository.connectWithTransition(res.session.id, {
      now: new Date(endedAt.getTime() - 30 * 60_000),
    });
    await creditSessionsRepository.end(res.session.id, { now: endedAt });
    ids.push(res.session.id);
  }
  const [first, second] = ids;
  if (first === undefined || second === undefined) throw new Error('seed failed');
  return { walletId: wallet.id, companyId, memberId: member.id, sessionIds: [first, second] };
}

/** Post a session's consumption through the ledger primitive — the debt IS the balance. */
async function consume(
  ctx: DebtWallet,
  sessionId: string,
  amountMinor: number,
  tag: string
): Promise<void> {
  await creditLedgerRepository.postEntry({
    walletId: ctx.walletId,
    entryType: 'consume',
    reason: 'session_consume',
    amountMinor: -amountMinor,
    idempotencyKey: `session_consume:${sessionId}:${tag}`,
    memberId: ctx.memberId,
    sessionId,
  });
}

async function cash(ctx: DebtWallet, amountMinor: number, tag: string): Promise<void> {
  await creditLedgerRepository.postEntry({
    walletId: ctx.walletId,
    entryType: 'purchase',
    reason: 'manual_purchase',
    amountMinor,
    idempotencyKey: `manual_purchase:${ctx.walletId}:${tag}`,
    memberId: ctx.memberId,
  });
}

async function promo(ctx: DebtWallet, amountMinor: number): Promise<void> {
  await creditLedgerRepository.postEntry({
    walletId: ctx.walletId,
    entryType: 'adjustment',
    reason: 'promo',
    amountMinor,
    idempotencyKey: `promo:${ctx.walletId}:${amountMinor}`,
  });
}

async function openReceivable(
  ctx: DebtWallet,
  sessionId: string,
  amountMinor: number
): Promise<string> {
  const { receivable } = await creditReceivablesRepository.open({
    companyId: ctx.companyId,
    walletId: ctx.walletId,
    sessionId,
    amountMinor,
    reason: 'settlement_declined',
  });
  return receivable.id;
}

describe('INVARIANT (integration): the dunning figure is the top-up that clears the hold', () => {
  it('two debts on one wallet — the figure is the WHOLE top-up, not one receivable', async () => {
    const ctx = await seedTwoEndedSessions();
    const [s1, s2] = ctx.sessionIds;
    await consume(ctx, s1, 10_000, 'r1');
    await openReceivable(ctx, s1, 10_000);
    await consume(ctx, s2, 14_000, 'r2');
    await openReceivable(ctx, s2, 14_000);

    const status = await creditReceivablesRepository.readHoldStatus({ walletId: ctx.walletId });
    expect(status.onHold).toBe(true);
    expect(status.openReceivableCount).toBe(2);
    expect(status.balanceMinor).toBe(-24_000);
    expect(status.promoGrantedSinceDebtMinor).toBe(0);
    expect(status.amountToClearMinor).toBe(24_000);
    expect(status.confirmationWasRequested).toBe(false);
  });

  it("⚠ paying ONE receivable's amount does not clear — the figure moves to what is still owed", async () => {
    const ctx = await seedTwoEndedSessions();
    const [s1, s2] = ctx.sessionIds;
    await consume(ctx, s1, 10_000, 'r1');
    await openReceivable(ctx, s1, 10_000);
    await consume(ctx, s2, 14_000, 'r2');
    await openReceivable(ctx, s2, 14_000);

    // R1's own amount — the figure a per-receivable notice would have quoted.
    await cash(ctx, 10_000, 'r1-amount');

    const status = await creditReceivablesRepository.readHoldStatus({ walletId: ctx.walletId });
    expect(status.onHold).toBe(true);
    expect(status.balanceMinor).toBe(-14_000);
    expect(
      creditCoversOutstandingDebt(status.balanceMinor, status.promoGrantedSinceDebtMinor)
    ).toBe(false);
    expect(status.amountToClearMinor).toBe(14_000);
  });

  it('with a 5,000 promo since the debt, the figure is 29,000 — and paying exactly that covers', async () => {
    const ctx = await seedTwoEndedSessions();
    const [s1, s2] = ctx.sessionIds;
    // The promo lands after the debt's anchor (both sessions ended an hour ago) and is then spent.
    await promo(ctx, 5_000);
    await consume(ctx, s1, 15_000, 'r1');
    await openReceivable(ctx, s1, 10_000);
    await consume(ctx, s2, 14_000, 'r2');
    await openReceivable(ctx, s2, 14_000);

    const before = await creditReceivablesRepository.readHoldStatus({ walletId: ctx.walletId });
    expect(before.balanceMinor).toBe(-24_000);
    expect(before.promoGrantedSinceDebtMinor).toBe(5_000);
    expect(before.amountToClearMinor).toBe(29_000);

    // One cent short is not enough — the figure is the SMALLEST top-up that clears.
    await cash(ctx, 28_999, 'short');
    const short = await creditReceivablesRepository.readHoldStatus({ walletId: ctx.walletId });
    expect(creditCoversOutstandingDebt(short.balanceMinor, short.promoGrantedSinceDebtMinor)).toBe(
      false
    );
    expect(short.amountToClearMinor).toBe(1);

    await cash(ctx, 1, 'last-cent');
    const after = await creditReceivablesRepository.readHoldStatus({ walletId: ctx.walletId });
    expect(creditCoversOutstandingDebt(after.balanceMinor, after.promoGrantedSinceDebtMinor)).toBe(
      true
    );
    expect(after.amountToClearMinor).toBe(0);
  });

  it('a card confirmation that was requested is reported as a PAST fact', async () => {
    const ctx = await seedTwoEndedSessions();
    const [s1] = ctx.sessionIds;
    await consume(ctx, s1, 10_000, 'r1');
    await creditReceivablesRepository.open({
      companyId: ctx.companyId,
      walletId: ctx.walletId,
      sessionId: s1,
      amountMinor: 10_000,
      reason: 'settlement_requires_action',
    });
    const status = await creditReceivablesRepository.readHoldStatus({ walletId: ctx.walletId });
    expect(status.confirmationWasRequested).toBe(true);
  });

  it('a wallet with nothing open is not on hold and quotes no figure', async () => {
    const ctx = await seedTwoEndedSessions();
    const status = await creditReceivablesRepository.readHoldStatus({ walletId: ctx.walletId });
    expect(status.onHold).toBe(false);
    expect(status.openReceivableCount).toBe(0);
    expect(status.amountToClearMinor).toBe(0);
    expect(status.promoGrantedSinceDebtMinor).toBe(0);
  });

  it('⚠ V4-F5 — the daily due set is wallet-grain and fair: never-reminded first, then the oldest stamp', async () => {
    const now = new Date();
    const notRemindedSince = new Date(now.getTime() - 20 * HOUR_MS);

    const neverReminded = await seedTwoEndedSessions();
    await openReceivable(neverReminded, neverReminded.sessionIds[0], 1_000);
    // A second open receivable on the SAME wallet — wallet grain means ONE row, not two.
    await openReceivable(neverReminded, neverReminded.sessionIds[1], 2_000);

    const oldest = await seedTwoEndedSessions();
    await openReceivable(oldest, oldest.sessionIds[0], 1_000);
    await creditReceivablesRepository.stampDailyDunning(
      oldest.walletId,
      new Date(now.getTime() - 72 * HOUR_MS),
      db
    );

    const newer = await seedTwoEndedSessions();
    await openReceivable(newer, newer.sessionIds[0], 1_000);
    await creditReceivablesRepository.stampDailyDunning(
      newer.walletId,
      new Date(now.getTime() - 48 * HOUR_MS),
      db
    );

    const firstBatch = await creditReceivablesRepository.listWalletsDueForDailyDunning(
      notRemindedSince,
      2
    );
    expect(firstBatch).toEqual([
      { walletId: neverReminded.walletId, companyId: neverReminded.companyId },
      { walletId: oldest.walletId, companyId: oldest.companyId },
    ]);

    // Those two are reminded today; the leftover leads the next batch.
    await creditReceivablesRepository.stampDailyDunning(neverReminded.walletId, now, db);
    await creditReceivablesRepository.stampDailyDunning(oldest.walletId, now, db);
    const secondBatch = await creditReceivablesRepository.listWalletsDueForDailyDunning(
      notRemindedSince,
      2
    );
    expect(secondBatch).toEqual([{ walletId: newer.walletId, companyId: newer.companyId }]);
  });

  it('a wallet reminded inside the cadence is not due; lastDailyDunningAt reads the stamp', async () => {
    const now = new Date();
    const ctx = await seedTwoEndedSessions();
    await openReceivable(ctx, ctx.sessionIds[0], 1_000);
    expect(await creditReceivablesRepository.lastDailyDunningAt(ctx.walletId, db)).toBeUndefined();

    const stamped = await creditReceivablesRepository.stampDailyDunning(
      ctx.walletId,
      new Date(now.getTime() - HOUR_MS),
      db
    );
    expect(stamped).toHaveLength(1);
    expect(
      (await creditReceivablesRepository.lastDailyDunningAt(ctx.walletId, db))?.getTime()
    ).toBe(now.getTime() - HOUR_MS);

    const due = await creditReceivablesRepository.listWalletsDueForDailyDunning(
      new Date(now.getTime() - 20 * HOUR_MS)
    );
    expect(due.map((row) => row.walletId)).not.toContain(ctx.walletId);
  });
});
