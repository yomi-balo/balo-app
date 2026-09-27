import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { creditHolds, expertProfiles } from '../schema';
import { creditWalletFactory, expertFactory, userFactory } from '../test/factories';
import { creditHoldsRepository, InvalidHoldTransitionError } from './credit-holds';
import { creditSessionsRepository } from './credit-sessions';
import { creditWalletsRepository } from './credit-wallets';

/**
 * Integration tests for `creditHoldsRepository` (BAL-376). Covers invariant #5:
 * available = balance − Σ active holds; settled/released holds don't subtract. A hold
 * moves NO money (no ledger / audit rows). Factories only.
 */

describe('creditHoldsRepository.place', () => {
  it('places an active hold with attribution', async () => {
    const { wallet } = await creditWalletFactory({ values: { balanceMinor: 50_000 } });
    const member = await userFactory();
    const hold = await creditHoldsRepository.place({
      walletId: wallet.id,
      // sessionId omitted (nullable): the session_id FK (BAL-378) rejects an unlinked uuid;
      // an open-gate hold is placed null and linked to its session afterwards.
      memberId: member.id,
      amountMinor: 8000,
    });
    expect(hold.status).toBe('active');
    expect(hold.amountMinor).toBe(8000);
    expect(hold.memberId).toBe(member.id);
    expect(hold.resolvedAt).toBeNull();
  });

  it('rejects a non-positive hold amount (CHECK amount_minor > 0)', async () => {
    const { wallet } = await creditWalletFactory();
    await expect(
      creditHoldsRepository.place({ walletId: wallet.id, amountMinor: 0 })
    ).rejects.toThrow();
  });
});

describe('creditHoldsRepository — invariant #5 (available = balance − Σ active holds)', () => {
  it('subtracts only ACTIVE holds; settled and released holds do not subtract', async () => {
    const { wallet } = await creditWalletFactory({ values: { balanceMinor: 50_000 } });

    // No holds → available == balance.
    expect(await creditHoldsRepository.getAvailableBalance(wallet.id)).toBe(50_000);

    const h1 = await creditHoldsRepository.place({ walletId: wallet.id, amountMinor: 8000 });
    const h2 = await creditHoldsRepository.place({ walletId: wallet.id, amountMinor: 12_000 });

    // Two active holds → available == 50000 − 20000.
    expect(await creditHoldsRepository.sumActiveByWallet(wallet.id)).toBe(20_000);
    expect(await creditHoldsRepository.getAvailableBalance(wallet.id)).toBe(30_000);

    // Settle one → it no longer subtracts.
    await creditHoldsRepository.settle(h1.id);
    expect(await creditHoldsRepository.sumActiveByWallet(wallet.id)).toBe(12_000);
    expect(await creditHoldsRepository.getAvailableBalance(wallet.id)).toBe(38_000);

    // Release the other → available back to full balance.
    await creditHoldsRepository.release(h2.id);
    expect(await creditHoldsRepository.sumActiveByWallet(wallet.id)).toBe(0);
    expect(await creditHoldsRepository.getAvailableBalance(wallet.id)).toBe(50_000);
  });

  it('available balance can exceed nothing special — holds never touch balance_minor', async () => {
    const { wallet } = await creditWalletFactory({ values: { balanceMinor: 10_000 } });
    await creditHoldsRepository.place({ walletId: wallet.id, amountMinor: 3000 });
    // getAvailableBalance is computed, not persisted — balance_minor is unchanged.
    const w = await creditWalletsRepository.findById(wallet.id);
    expect(w?.balanceMinor).toBe(10_000);
    expect(await creditHoldsRepository.getAvailableBalance(wallet.id)).toBe(7000);
  });
});

describe('creditHoldsRepository — tx-composable place / release (BAL-378)', () => {
  it('places a hold inside the caller transaction and commits with it', async () => {
    const { wallet } = await creditWalletFactory({ values: { balanceMinor: 30_000 } });
    const member = await userFactory();

    const hold = await db.transaction((tx) =>
      creditHoldsRepository.place(
        { walletId: wallet.id, memberId: member.id, amountMinor: 4000 },
        tx
      )
    );

    // Committed with the txn → visible on the base client afterwards.
    const [persisted] = await db.select().from(creditHolds).where(eq(creditHolds.id, hold.id));
    expect(persisted?.status).toBe('active');
    expect(persisted?.amountMinor).toBe(4000);
    expect(await creditHoldsRepository.sumActiveByWallet(wallet.id)).toBe(4000);
  });

  it('rolls back a tx-composed place when the surrounding transaction throws', async () => {
    const { wallet } = await creditWalletFactory({ values: { balanceMinor: 30_000 } });

    await expect(
      db.transaction(async (tx) => {
        await creditHoldsRepository.place({ walletId: wallet.id, amountMinor: 5000 }, tx);
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    // The hold rolled back with the txn.
    expect(await creditHoldsRepository.sumActiveByWallet(wallet.id)).toBe(0);
  });

  it('releases a hold inside the caller transaction (exec-composed)', async () => {
    const { wallet } = await creditWalletFactory({ values: { balanceMinor: 30_000 } });
    const placed = await creditHoldsRepository.place({ walletId: wallet.id, amountMinor: 6000 });

    const released = await db.transaction((tx) =>
      creditHoldsRepository.release(placed.id, { exec: tx })
    );
    expect(released.status).toBe('released');
    expect(released.resolvedAt).toBeInstanceOf(Date);
    expect(await creditHoldsRepository.sumActiveByWallet(wallet.id)).toBe(0);
  });
});

describe('creditHoldsRepository.settle / release — guarded transitions', () => {
  it('settle marks settled with resolved_at and records the resolving member', async () => {
    const { wallet } = await creditWalletFactory({ values: { balanceMinor: 20_000 } });
    const resolver = await userFactory();
    const hold = await creditHoldsRepository.place({ walletId: wallet.id, amountMinor: 5000 });

    const settled = await creditHoldsRepository.settle(hold.id, { memberId: resolver.id });
    expect(settled.status).toBe('settled');
    expect(settled.resolvedAt).toBeInstanceOf(Date);
    expect(settled.memberId).toBe(resolver.id);
  });

  it('release marks released with resolved_at', async () => {
    const { wallet } = await creditWalletFactory({ values: { balanceMinor: 20_000 } });
    const hold = await creditHoldsRepository.place({ walletId: wallet.id, amountMinor: 5000 });
    const released = await creditHoldsRepository.release(hold.id);
    expect(released.status).toBe('released');
    expect(released.resolvedAt).toBeInstanceOf(Date);
  });

  it('rejects settling an already-resolved hold (only from active)', async () => {
    const { wallet } = await creditWalletFactory({ values: { balanceMinor: 20_000 } });
    const hold = await creditHoldsRepository.place({ walletId: wallet.id, amountMinor: 5000 });
    await creditHoldsRepository.settle(hold.id);
    await expect(creditHoldsRepository.settle(hold.id)).rejects.toBeInstanceOf(
      InvalidHoldTransitionError
    );
  });

  it('rejects releasing an already-settled hold', async () => {
    const { wallet } = await creditWalletFactory({ values: { balanceMinor: 20_000 } });
    const hold = await creditHoldsRepository.place({ walletId: wallet.id, amountMinor: 5000 });
    await creditHoldsRepository.settle(hold.id);
    await expect(creditHoldsRepository.release(hold.id)).rejects.toBeInstanceOf(
      InvalidHoldTransitionError
    );
  });

  it('throws for an unknown hold id', async () => {
    await expect(
      creditHoldsRepository.settle('00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow(/not found/i);
  });
});

// ── BAL-474 (ADR-1040 Amendment 7 §H, D8.5) — the booking figure ─────────────────────────────

/** Client 250 / minute at the default fee (expert A$120/h). */
const EXPERT_HOURLY_250 = 12_000;
const MINUTE_MS = 60_000;

/** A wallet at `balanceMinor` with ONE session opened on it (hold = estimate × 250). */
async function walletWithSession(
  balanceMinor: number,
  estimatedMinutes: number
): Promise<{ walletId: string; sessionId: string }> {
  const { wallet, companyId } = await creditWalletFactory({ values: { balanceMinor } });
  const member = await userFactory();
  const expert = await expertFactory();
  await db
    .update(expertProfiles)
    .set({ rateCents: EXPERT_HOURLY_250 })
    .where(eq(expertProfiles.id, expert.id));
  const opened = await creditSessionsRepository.open({
    walletId: wallet.id,
    companyId,
    expertProfileId: expert.id,
    initiatingMemberId: member.id,
    estimatedMinutes,
  });
  if (!opened.ok) throw new Error(`open failed: ${opened.code}`);
  return { walletId: wallet.id, sessionId: opened.session.id };
}

/** Connect the session and meter exactly `ticks` minutes. */
async function meter(sessionId: string, ticks: number): Promise<void> {
  const connectedAt = new Date(Date.now() - (ticks + 5) * MINUTE_MS);
  await creditSessionsRepository.connectWithTransition(sessionId, { now: connectedAt });
  const metered = await creditSessionsRepository.meterSessionToNow(
    sessionId,
    new Date(connectedAt.getTime() + ticks * MINUTE_MS + 30_000),
    { floorMinutes: 15 }
  );
  expect(metered.ticksPosted).toBe(ticks);
}

describe('creditHoldsRepository.getAvailableForBooking — holds netted by posted consumption (BAL-474)', () => {
  it('⚠ a LIVE session’s drawn minutes are subtracted ONCE, not twice', async () => {
    // Hold 30 × 250 = 7,500; 20 minutes drawn (5,000) ⇒ balance 45,000.
    const { walletId, sessionId } = await walletWithSession(50_000, 30);
    await meter(sessionId, 20);

    expect(await creditHoldsRepository.getAvailableBalance(walletId)).toBe(45_000 - 7_500);
    expect(await creditHoldsRepository.getAvailableForBooking(walletId, db)).toBe(
      45_000 - (7_500 - 5_000)
    );
  });

  it('a hold whose session has posted nothing yet counts in FULL', async () => {
    const { walletId } = await walletWithSession(50_000, 30);
    expect(await creditHoldsRepository.getAvailableForBooking(walletId, db)).toBe(50_000 - 7_500);
  });

  it('a hold whose consumption already EXCEEDS it counts 0 — never negative', async () => {
    // Hold 5 × 250 = 1,250; 8 minutes drawn (2,000) ⇒ balance 48,000; the hold nets to 0.
    const { walletId, sessionId } = await walletWithSession(50_000, 5);
    await meter(sessionId, 8);
    expect(await creditHoldsRepository.getAvailableForBooking(walletId, db)).toBe(48_000);
  });

  it('a released hold no longer subtracts, whatever its session drew', async () => {
    const { walletId, sessionId } = await walletWithSession(50_000, 30);
    await meter(sessionId, 4);
    await creditSessionsRepository.end(sessionId, { now: new Date() });
    expect(await creditHoldsRepository.getAvailableForBooking(walletId, db)).toBe(49_000);
  });

  it('an unknown wallet reads 0', async () => {
    expect(
      await creditHoldsRepository.getAvailableForBooking('00000000-0000-4000-8000-000000000000', db)
    ).toBe(0);
  });
});

describe('creditHoldsRepository.getAvailableBalance — on a caller-supplied executor (BAL-474)', () => {
  it('reads the balance AND the holds on the given executor', async () => {
    // Executor IDENTITY is proven where it can be observed (`booking-funding.test.ts` and the
    // two-connection `booking-funding.concurrency.integration.test.ts`); this pins the behaviour.
    const { wallet } = await creditWalletFactory({ values: { balanceMinor: 20_000 } });
    const available = await db.transaction(async (tx) => {
      await creditHoldsRepository.place({ walletId: wallet.id, amountMinor: 3_000 }, tx);
      return creditHoldsRepository.getAvailableBalance(wallet.id, tx);
    });
    expect(available).toBe(17_000);
  });
});
