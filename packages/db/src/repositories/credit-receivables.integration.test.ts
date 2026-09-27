import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { creditReceivables, creditSessions, creditWallets, expertProfiles } from '../schema';
import { creditWalletFactory, expertFactory, userFactory } from '../test/factories';
import { creditReceivablesRepository } from './credit-receivables';
import { creditSessionsRepository } from './credit-sessions';

/**
 * Integration tests for `creditReceivablesRepository` (BAL-378). Covers idempotent `open`
 * per session (partial-unique on `session_id`), the `hasOpenReceivable` soft-hold predicate,
 * BAL-474's `readHoldStatus` and wallet-grain daily dunning (`listWalletsDueForDailyDunning` /
 * `stampDailyDunning` / `lastDailyDunningAt`, which replace the per-receivable
 * `listOpenForDunning` / `markDunned`), and `clear` (which releases the soft hold). Each
 * receivable needs a real `credit_sessions` row (the FK is RESTRICT).
 */

/** Seed a wallet + a pending session for it, returning the ids a receivable needs. */
async function seedSession(): Promise<{
  companyId: string;
  walletId: string;
  sessionId: string;
}> {
  const { wallet, companyId } = await creditWalletFactory({ values: { balanceMinor: 50_000 } });
  const member = await userFactory();
  const expert = await expertFactory();
  await db
    .update(expertProfiles)
    .set({ rateCents: 12_000 })
    .where(eq(expertProfiles.id, expert.id));
  const res = await creditSessionsRepository.open({
    walletId: wallet.id,
    companyId,
    expertProfileId: expert.id,
    initiatingMemberId: member.id,
    estimatedMinutes: 10,
  });
  if (!res.ok) throw new Error(`open failed: ${res.code}`);
  return { companyId, walletId: wallet.id, sessionId: res.session.id };
}

/**
 * BAL-535 (§2.4) — seed a SECOND session on an ALREADY-EXISTING wallet, for
 * `clearOpenForWallet`'s "clears every open receivable on the wallet" case. `open()`'s "one live
 * consultation per wallet" gate (`credit-sessions.ts` step 2b) refuses a second `pending` /
 * `active` / `grace` / `wrapped` session on the same wallet, so the prior session is forced to
 * `ended` first via a direct row update — this test exercises `clearOpenForWallet`, not session
 * lifecycle transitions, so bypassing the full settlement flow is the correct scope, not a
 * shortcut around it.
 */
async function seedAnotherSessionOnWallet(
  walletId: string,
  companyId: string
): Promise<{ sessionId: string }> {
  await db
    .update(creditSessions)
    .set({ status: 'ended' })
    .where(eq(creditSessions.walletId, walletId));
  const member = await userFactory();
  const expert = await expertFactory();
  await db
    .update(expertProfiles)
    .set({ rateCents: 12_000 })
    .where(eq(expertProfiles.id, expert.id));
  const res = await creditSessionsRepository.open({
    walletId,
    companyId,
    expertProfileId: expert.id,
    initiatingMemberId: member.id,
    estimatedMinutes: 10,
  });
  if (!res.ok) throw new Error(`open failed: ${res.code}`);
  return { sessionId: res.session.id };
}

describe('creditReceivablesRepository.open — idempotent per session', () => {
  it('opens once and returns the SAME row on a second open for the session', async () => {
    const { companyId, walletId, sessionId } = await seedSession();

    const first = await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 1500,
      reason: 'settlement_declined',
      stripePaymentIntentId: 'pi_fail',
    });
    // A fresh insert reports created=true (the caller duns exactly once on this — FIX 5).
    expect(first.created).toBe(true);
    expect(first.receivable.status).toBe('open');
    expect(first.receivable.amountMinor).toBe(1500);
    expect(first.receivable.reason).toBe('settlement_declined');

    const second = await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 9999, // ignored — the conflict returns the existing row
      reason: 'settlement_requires_action',
    });
    // The idempotent hit reports created=false, so the second path never re-duns.
    expect(second.created).toBe(false);
    expect(second.receivable.id).toBe(first.receivable.id);
    expect(second.receivable.amountMinor).toBe(1500); // unchanged

    const rows = await creditReceivablesRepository.findOpenByCompany(companyId);
    expect(rows).toHaveLength(1);
  });

  it('rejects a non-positive amount (CHECK amount_minor > 0)', async () => {
    const { companyId, walletId, sessionId } = await seedSession();
    await expect(
      creditReceivablesRepository.open({
        companyId,
        walletId,
        sessionId,
        amountMinor: 0,
        reason: 'settlement_declined',
      })
    ).rejects.toThrow();
  });
});

describe('creditReceivablesRepository.hasOpenReceivable — soft-hold predicate', () => {
  it('is false with no receivable, true once opened, false after clear', async () => {
    const { companyId, walletId, sessionId } = await seedSession();
    expect(await creditReceivablesRepository.hasOpenReceivable(companyId)).toBe(false);

    await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 1200,
      reason: 'settlement_declined',
    });
    expect(await creditReceivablesRepository.hasOpenReceivable(companyId)).toBe(true);

    // Clearing by sessionId releases the soft hold (§14 Q2).
    const cleared = await creditReceivablesRepository.clear({ sessionId });
    expect(cleared?.status).toBe('cleared');
    expect(cleared?.clearedAt).toBeInstanceOf(Date);
    expect(await creditReceivablesRepository.hasOpenReceivable(companyId)).toBe(false);
  });

  it('clear is a no-op (returns undefined) when there is no open receivable', async () => {
    const { sessionId } = await seedSession();
    expect(await creditReceivablesRepository.clear({ sessionId })).toBeUndefined();
  });
});

/** Set a wallet's cached balance directly — these cases pin READS, not ledger reconciliation. */
async function setBalance(walletId: string, balanceMinor: number): Promise<void> {
  await db.update(creditWallets).set({ balanceMinor }).where(eq(creditWallets.id, walletId));
}

describe('creditReceivablesRepository.readHoldStatus (BAL-474, ADR-1040 Amendment 7 §G.1)', () => {
  it('not on hold ⇒ no figure, no promo read, the live balance reported', async () => {
    const { walletId } = await seedSession();
    expect(await creditReceivablesRepository.readHoldStatus({ walletId })).toEqual({
      onHold: false,
      openReceivableCount: 0,
      confirmationWasRequested: false,
      balanceMinor: 50_000,
      promoGrantedSinceDebtMinor: 0,
      amountToClearMinor: 0,
    });
  });

  it('on hold ⇒ the top-up that clears it is the whole negative balance (no promo)', async () => {
    const { companyId, walletId, sessionId } = await seedSession();
    await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 4_000,
      reason: 'settlement_declined',
    });
    await setBalance(walletId, -4_000);
    const status = await creditReceivablesRepository.readHoldStatus({ walletId });
    expect(status).toMatchObject({
      onHold: true,
      openReceivableCount: 1,
      confirmationWasRequested: false,
      balanceMinor: -4_000,
      amountToClearMinor: 4_000,
    });
  });

  it('confirmationWasRequested reports a requires_action receivable as a past fact', async () => {
    const { companyId, walletId, sessionId } = await seedSession();
    await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 4_000,
      reason: 'settlement_requires_action',
    });
    expect(
      (await creditReceivablesRepository.readHoldStatus({ walletId })).confirmationWasRequested
    ).toBe(true);
  });

  it('a covered-but-held wallet reads onHold with a ZERO figure — the state the heal clears', async () => {
    const { companyId, walletId, sessionId } = await seedSession();
    await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 4_000,
      reason: 'settlement_declined',
    });
    // The balance already covers it (a top-up that cleared nothing).
    const status = await creditReceivablesRepository.readHoldStatus({ walletId });
    expect(status.onHold).toBe(true);
    expect(status.amountToClearMinor).toBe(0);
  });

  it('reads on a caller-supplied executor (the dunning claim and the booking snapshot pass theirs)', async () => {
    const { companyId, walletId, sessionId } = await seedSession();
    await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 1_000,
      reason: 'settlement_declined',
    });
    await setBalance(walletId, -1_000);
    const status = await db.transaction((tx) =>
      creditReceivablesRepository.readHoldStatus({ walletId }, tx)
    );
    expect(status).toMatchObject({ onHold: true, amountToClearMinor: 1_000 });
  });
});

describe('creditReceivablesRepository — wallet-grain daily dunning (BAL-474, §G.2)', () => {
  async function openOn(
    seed: { companyId: string; walletId: string; sessionId: string },
    amountMinor: number
  ): Promise<string> {
    const { receivable } = await creditReceivablesRepository.open({
      companyId: seed.companyId,
      walletId: seed.walletId,
      sessionId: seed.sessionId,
      amountMinor,
      reason: 'settlement_declined',
    });
    return receivable.id;
  }

  it('one row per WALLET, however many receivables it holds; a never-reminded wallet is due', async () => {
    // Both sessions exist BEFORE any receivable opens — the gated open refuses on a held wallet.
    const a = await seedSession();
    const second = await seedAnotherSessionOnWallet(a.walletId, a.companyId);
    await openOn(a, 1_000);
    await openOn({ ...a, sessionId: second.sessionId }, 2_000);

    const due = await creditReceivablesRepository.listWalletsDueForDailyDunning(
      new Date(Date.now() - 20 * 60 * 60_000)
    );
    expect(due.filter((row) => row.walletId === a.walletId)).toEqual([
      { walletId: a.walletId, companyId: a.companyId },
    ]);
  });

  it('due by the wallet’s LATEST stamp: reminded inside the cadence ⇒ not due; before it ⇒ due', async () => {
    const now = Date.now();
    const notRemindedSince = new Date(now - 20 * 60 * 60_000);
    const fresh = await seedSession();
    await openOn(fresh, 1_000);
    await creditReceivablesRepository.stampDailyDunning(fresh.walletId, new Date(now - 60_000));
    const stale = await seedSession();
    await openOn(stale, 1_000);
    await creditReceivablesRepository.stampDailyDunning(
      stale.walletId,
      new Date(now - 30 * 60 * 60_000)
    );

    const dueIds = (
      await creditReceivablesRepository.listWalletsDueForDailyDunning(notRemindedSince)
    ).map((row) => row.walletId);
    expect(dueIds).toContain(stale.walletId);
    expect(dueIds).not.toContain(fresh.walletId);
  });

  it('⚠ fairness (V4-F5): never-reminded first, then the OLDEST stamp; the batch bound holds', async () => {
    const now = Date.now();
    const oldest = await seedSession();
    await openOn(oldest, 1_000);
    await creditReceivablesRepository.stampDailyDunning(
      oldest.walletId,
      new Date(now - 72 * 60 * 60_000)
    );
    const newer = await seedSession();
    await openOn(newer, 1_000);
    await creditReceivablesRepository.stampDailyDunning(
      newer.walletId,
      new Date(now - 48 * 60 * 60_000)
    );
    const never = await seedSession();
    await openOn(never, 1_000);

    const batch = await creditReceivablesRepository.listWalletsDueForDailyDunning(
      new Date(now - 20 * 60 * 60_000),
      2
    );
    expect(batch.map((row) => row.walletId)).toEqual([never.walletId, oldest.walletId]);
  });

  it('a cleared receivable is not dunned', async () => {
    const seed = await seedSession();
    await openOn(seed, 1_000);
    await creditReceivablesRepository.clear({ sessionId: seed.sessionId });
    const dueIds = (
      await creditReceivablesRepository.listWalletsDueForDailyDunning(new Date())
    ).map((row) => row.walletId);
    expect(dueIds).not.toContain(seed.walletId);
  });

  it('stampDailyDunning stamps every OPEN receivable of the wallet and returns their ids; lastDailyDunningAt reads it', async () => {
    const seed = await seedSession();
    const second = await seedAnotherSessionOnWallet(seed.walletId, seed.companyId);
    const open1 = await openOn(seed, 1_000);
    const cleared = await openOn({ ...seed, sessionId: second.sessionId }, 2_000);
    await creditReceivablesRepository.clear({ receivableId: cleared });

    expect(await creditReceivablesRepository.lastDailyDunningAt(seed.walletId)).toBeUndefined();
    const stampedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const stamped = await creditReceivablesRepository.stampDailyDunning(seed.walletId, stampedAt);
    expect(stamped).toEqual([open1]);
    expect((await creditReceivablesRepository.lastDailyDunningAt(seed.walletId))?.getTime()).toBe(
      stampedAt.getTime()
    );

    const [clearedRow] = await db
      .select({ lastDunningAt: creditReceivables.lastDunningAt })
      .from(creditReceivables)
      .where(eq(creditReceivables.id, cleared));
    expect(clearedRow?.lastDunningAt).toBeNull();
  });
});

/**
 * BAL-535 (§2.4, ADR-1040 Amendment 6 §F) — `clearOpenForWallet`, the covering-credit exit.
 */
describe('creditReceivablesRepository.clearOpenForWallet', () => {
  it('clears every open receivable on the wallet', async () => {
    const { companyId, walletId, sessionId: sessionA } = await seedSession();
    const { sessionId: sessionB } = await seedAnotherSessionOnWallet(walletId, companyId);

    const { receivable: recA } = await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId: sessionA,
      amountMinor: 1000,
      reason: 'settlement_declined',
    });
    const { receivable: recB } = await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId: sessionB,
      amountMinor: 2000,
      reason: 'settlement_requires_action',
    });

    const cleared = await creditReceivablesRepository.clearOpenForWallet({ walletId });
    const clearedIds = cleared.map((r) => r.id).sort();
    expect(clearedIds).toEqual([recA.id, recB.id].sort());
    for (const row of cleared) {
      expect(row.status).toBe('cleared');
      expect(row.clearedAt).toBeInstanceOf(Date);
    }
  });

  it("is scoped to the wallet — a second wallet's open receivable is untouched", async () => {
    const first = await seedSession();
    const second = await seedSession();

    await creditReceivablesRepository.open({
      companyId: first.companyId,
      walletId: first.walletId,
      sessionId: first.sessionId,
      amountMinor: 500,
      reason: 'settlement_declined',
    });
    const { receivable: otherReceivable } = await creditReceivablesRepository.open({
      companyId: second.companyId,
      walletId: second.walletId,
      sessionId: second.sessionId,
      amountMinor: 700,
      reason: 'settlement_declined',
    });

    await creditReceivablesRepository.clearOpenForWallet({ walletId: first.walletId });

    expect(await creditReceivablesRepository.hasOpenReceivable(second.companyId)).toBe(true);
    const stillOpen = await creditReceivablesRepository.findOpenByCompany(second.companyId);
    expect(stillOpen.map((r) => r.id)).toEqual([otherReceivable.id]);
  });

  it('ignores already-cleared and soft-deleted rows — returns []', async () => {
    const { companyId, walletId, sessionId } = await seedSession();
    await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 900,
      reason: 'settlement_declined',
    });
    await creditReceivablesRepository.clear({ sessionId });

    const result = await creditReceivablesRepository.clearOpenForWallet({ walletId });
    expect(result).toEqual([]);
  });

  it('is an idempotent no-op on a wallet with nothing open', async () => {
    const { walletId } = await seedSession();
    expect(await creditReceivablesRepository.clearOpenForWallet({ walletId })).toEqual([]);
  });

  it('composes under a caller transaction — a rollback leaves the row open', async () => {
    const { companyId, walletId, sessionId } = await seedSession();
    const { receivable } = await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 400,
      reason: 'settlement_declined',
    });

    await expect(
      db.transaction(async (tx) => {
        const cleared = await creditReceivablesRepository.clearOpenForWallet({ walletId }, tx);
        expect(cleared).toHaveLength(1);
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    const stillOpen = await creditReceivablesRepository.findOpenByCompany(companyId);
    expect(stillOpen.map((r) => r.id)).toEqual([receivable.id]);
  });

  /**
   * ⚠⚠ The highest-value case in this file — the executable form of ADR-1040 Amendment 6 §F's
   * final paragraph. The status-blind partial unique (`credit_receivables_session_uidx`) means a
   * `cleared` row permanently occupies its session's one-per-session slot: a later `open` for the
   * SAME session conflicts and returns the existing `cleared` row, never re-arming the hold.
   */
  it('⚠⚠ a CLEARED receivable can never be re-opened', async () => {
    const { companyId, walletId, sessionId } = await seedSession();
    const { created: firstCreated } = await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 600,
      reason: 'settlement_declined',
    });
    expect(firstCreated).toBe(true);

    const [cleared] = await creditReceivablesRepository.clearOpenForWallet({ walletId });
    expect(cleared?.status).toBe('cleared');

    const { created: secondCreated, receivable: secondRow } =
      await creditReceivablesRepository.open({
        companyId,
        walletId,
        sessionId,
        amountMinor: 600,
        reason: 'settlement_declined',
        stripePaymentIntentId: 'pi_late_failure',
      });
    expect(secondCreated).toBe(false);
    expect(secondRow.status).toBe('cleared');
    expect(await creditReceivablesRepository.hasOpenReceivable(companyId)).toBe(false);
  });
});

/**
 * BAL-535 fix round B1 (ADR-1040 Amendment 6 §F) — `earliestOpenDebtAnchor`, the start of the
 * promo-discount window. It is the moment the OLDEST still-open debt became outstanding, which
 * is the session's `ended_at` — NOT the receivable row's `opened_at`. On the two late-open (R3b)
 * paths the row is inserted in the very transaction that then asks whether it is covered, so an
 * `opened_at` anchor would give a zero-width window and a zero discount.
 */
describe('creditReceivablesRepository.earliestOpenDebtAnchor', () => {
  const ENDED_A = new Date('2026-08-20T10:00:00.000Z');
  const ENDED_B = new Date('2026-08-25T10:00:00.000Z');

  it('is undefined for a wallet with nothing open', async () => {
    const { walletId } = await seedSession();
    expect(await creditReceivablesRepository.earliestOpenDebtAnchor(walletId)).toBeUndefined();
  });

  it("⚠⚠ anchors on the SESSION's ended_at, not the receivable's opened_at", async () => {
    const { companyId, walletId, sessionId } = await seedSession();
    await db
      .update(creditSessions)
      .set({ endedAt: ENDED_A })
      .where(eq(creditSessions.id, sessionId));
    const { receivable } = await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 1_000,
      reason: 'settlement_declined',
    });
    const anchor = await creditReceivablesRepository.earliestOpenDebtAnchor(walletId);
    expect(anchor?.toISOString()).toBe(ENDED_A.toISOString());
    // The row itself opened just now — using THAT would collapse the discount window to nothing.
    expect(receivable.openedAt.getTime()).toBeGreaterThan(ENDED_A.getTime());
  });

  it('takes the EARLIEST across several open receivables (the widest, strictest window)', async () => {
    const { companyId, walletId, sessionId: sessionA } = await seedSession();
    const { sessionId: sessionB } = await seedAnotherSessionOnWallet(walletId, companyId);
    await db
      .update(creditSessions)
      .set({ endedAt: ENDED_B })
      .where(eq(creditSessions.id, sessionB));
    await db
      .update(creditSessions)
      .set({ endedAt: ENDED_A })
      .where(eq(creditSessions.id, sessionA));
    await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId: sessionA,
      amountMinor: 1_000,
      reason: 'settlement_declined',
    });
    await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId: sessionB,
      amountMinor: 2_000,
      reason: 'settlement_declined',
    });
    const anchor = await creditReceivablesRepository.earliestOpenDebtAnchor(walletId);
    expect(anchor?.toISOString()).toBe(ENDED_A.toISOString());
  });

  it('falls back to opened_at when the session never stamped ended_at (COALESCE, not a drop-out)', async () => {
    const { companyId, walletId, sessionId } = await seedSession();
    const { receivable } = await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 1_000,
      reason: 'settlement_declined',
    });
    const anchor = await creditReceivablesRepository.earliestOpenDebtAnchor(walletId);
    expect(anchor?.toISOString()).toBe(receivable.openedAt.toISOString());
  });

  it('ignores CLEARED rows — a cleared debt is not outstanding', async () => {
    const { companyId, walletId, sessionId } = await seedSession();
    await db
      .update(creditSessions)
      .set({ endedAt: ENDED_A })
      .where(eq(creditSessions.id, sessionId));
    await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 1_000,
      reason: 'settlement_declined',
    });
    await creditReceivablesRepository.clear({ sessionId });
    expect(await creditReceivablesRepository.earliestOpenDebtAnchor(walletId)).toBeUndefined();
  });

  it("is scoped to the wallet — another wallet's open debt does not widen this one's window", async () => {
    const first = await seedSession();
    const second = await seedSession();
    await db
      .update(creditSessions)
      .set({ endedAt: ENDED_A })
      .where(eq(creditSessions.id, second.sessionId));
    await creditReceivablesRepository.open({
      companyId: second.companyId,
      walletId: second.walletId,
      sessionId: second.sessionId,
      amountMinor: 1_000,
      reason: 'settlement_declined',
    });
    expect(
      await creditReceivablesRepository.earliestOpenDebtAnchor(first.walletId)
    ).toBeUndefined();
  });

  it("composes under the caller's transaction, and sees a row opened in that same txn", async () => {
    // THE R3b SHAPE: the receivable is inserted and the coverage question asked inside ONE
    // uncommitted transaction. If the anchor read could not see the row it just opened, the
    // late-open self-clear would have no window at all.
    const { companyId, walletId, sessionId } = await seedSession();
    await db
      .update(creditSessions)
      .set({ endedAt: ENDED_A })
      .where(eq(creditSessions.id, sessionId));
    const anchor = await db.transaction(async (tx) => {
      await creditReceivablesRepository.open(
        {
          companyId,
          walletId,
          sessionId,
          amountMinor: 1_000,
          reason: 'settlement_declined',
        },
        tx
      );
      return creditReceivablesRepository.earliestOpenDebtAnchor(walletId, tx);
    });
    expect(anchor?.toISOString()).toBe(ENDED_A.toISOString());
  });

  /**
   * ⚠⚠ FIX ROUND 2 (F1) — a SOFT-DELETED session must not anchor the window. Every other session
   * read in the data layer is `deleted_at IS NULL`-scoped; this join was not, so an invisible
   * session's (older) `ended_at` still entered the MIN, widening the promo window, inflating the
   * discount and REFUSING a covering credit — the hold then outlived a paid balance. It failed
   * CLOSED, which is why the shipped suite above was green.
   */
  describe('a soft-deleted session (fix round 2, F1)', () => {
    it("⚠⚠ does not widen the window with an invisible session's older ended_at", async () => {
      const { companyId, walletId, sessionId: deletedSession } = await seedSession();
      const { sessionId: liveSession } = await seedAnotherSessionOnWallet(walletId, companyId);
      // The soft-deleted session ended FIRST — the value that used to win the MIN.
      await db
        .update(creditSessions)
        .set({ endedAt: ENDED_A, deletedAt: new Date() })
        .where(eq(creditSessions.id, deletedSession));
      await db
        .update(creditSessions)
        .set({ endedAt: ENDED_B })
        .where(eq(creditSessions.id, liveSession));
      await creditReceivablesRepository.open({
        companyId,
        walletId,
        sessionId: deletedSession,
        amountMinor: 1_000,
        reason: 'settlement_declined',
      });
      await creditReceivablesRepository.open({
        companyId,
        walletId,
        sessionId: liveSession,
        amountMinor: 2_000,
        reason: 'settlement_declined',
      });

      const anchor = await creditReceivablesRepository.earliestOpenDebtAnchor(walletId);
      // Before the fix this was ENDED_A — a month of extra promo grants discounted away.
      expect(anchor?.toISOString()).toBe(ENDED_B.toISOString());
    });

    it('⚠ still ANSWERS for a receivable whose only session is soft-deleted — it falls back to opened_at', async () => {
      // The other half of F1, and the reason the filter rides the JOIN condition rather than the
      // WHERE. `hasOpenReceivable` never joins sessions, so this row STILL holds the company; if
      // filtering dropped it from the aggregate the anchor would be `undefined`,
      // `assessCashCoverage` would report `hasOpenReceivable: false`, and no covering credit
      // could ever clear it. Fail-closed forever is not a fix for fail-closed sometimes.
      const { companyId, walletId, sessionId } = await seedSession();
      await db
        .update(creditSessions)
        .set({ endedAt: ENDED_A, deletedAt: new Date() })
        .where(eq(creditSessions.id, sessionId));
      const { receivable } = await creditReceivablesRepository.open({
        companyId,
        walletId,
        sessionId,
        amountMinor: 1_000,
        reason: 'settlement_declined',
      });

      expect(await creditReceivablesRepository.hasOpenReceivable(companyId)).toBe(true);
      const anchor = await creditReceivablesRepository.earliestOpenDebtAnchor(walletId);
      expect(anchor?.toISOString()).toBe(receivable.openedAt.toISOString());
    });
  });
});

/**
 * BAL-548 / ADR-1055 — the `receivable.open` finder read. A DIFFERENT method from the dunning
 * reads on purpose (R5; since BAL-474 `listWalletsDueForDailyDunning`): this one is the alert
 * queue's — bounded, ordered, and carrying no dunning-cadence term. The two must never be merged.
 */
describe('creditReceivablesRepository.listOpen — the admin-queue finder read', () => {
  /** One open receivable on its own company/wallet/session, with a chosen `opened_at`. */
  async function seedOpenReceivable(openedAt: Date): Promise<{
    receivableId: string;
    companyId: string;
  }> {
    const { companyId, walletId, sessionId } = await seedSession();
    const { receivable } = await creditReceivablesRepository.open({
      companyId,
      walletId,
      sessionId,
      amountMinor: 6_240,
      reason: 'settlement_declined',
      stripePaymentIntentId: 'pi_alert',
    });
    // ⚠ `opened_at` defaults to `now()` = transaction START time inside the harness, so every
    // row would otherwise share a byte-identical anchor and an ordering assertion would fall
    // through to `id`, a random v4 uuid.
    await db
      .update(creditReceivables)
      .set({ openedAt })
      .where(eq(creditReceivables.id, receivable.id));
    return { receivableId: receivable.id, companyId };
  }

  it('returns open receivables OLDEST FIRST, with the company name flattened on', async () => {
    const older = await seedOpenReceivable(new Date('2026-01-01T00:00:00.000Z'));
    const newer = await seedOpenReceivable(new Date('2026-01-02T00:00:00.000Z'));

    const rows = await creditReceivablesRepository.listOpen(
      new Date('2026-02-01T00:00:00.000Z'),
      50
    );
    const mine = rows.filter((row) =>
      [older.receivableId, newer.receivableId].includes(row.receivableId)
    );

    expect(mine.map((row) => row.receivableId)).toEqual([older.receivableId, newer.receivableId]);
    const [first] = mine;
    expect(first?.companyId).toBe(older.companyId);
    expect(first?.companyName).toMatch(/^Test Company /);
    expect(first?.amountMinor).toBe(6_240);
    expect(first?.reason).toBe('settlement_declined');
    expect(first?.stripePaymentIntentId).toBe('pi_alert');
  });

  it('the cutoff excludes a receivable opened too recently', async () => {
    const recent = await seedOpenReceivable(new Date('2026-01-10T00:00:00.000Z'));

    const rows = await creditReceivablesRepository.listOpen(
      new Date('2026-01-05T00:00:00.000Z'),
      50
    );

    expect(rows.map((row) => row.receivableId)).not.toContain(recent.receivableId);
  });

  it('the limit BOUNDS the result — a filled batch is what the caller must warn about', async () => {
    await seedOpenReceivable(new Date('2026-01-01T00:00:00.000Z'));
    await seedOpenReceivable(new Date('2026-01-02T00:00:00.000Z'));

    const rows = await creditReceivablesRepository.listOpen(
      new Date('2026-02-01T00:00:00.000Z'),
      1
    );

    expect(rows).toHaveLength(1);
  });

  it('excludes CLEARED and soft-deleted receivables', async () => {
    const cleared = await seedOpenReceivable(new Date('2026-01-01T00:00:00.000Z'));
    const deleted = await seedOpenReceivable(new Date('2026-01-01T00:00:00.000Z'));
    const live = await seedOpenReceivable(new Date('2026-01-01T00:00:00.000Z'));
    await creditReceivablesRepository.clear({ receivableId: cleared.receivableId });
    await db
      .update(creditReceivables)
      .set({ deletedAt: new Date() })
      .where(eq(creditReceivables.id, deleted.receivableId));

    const rows = await creditReceivablesRepository.listOpen(
      new Date('2026-02-01T00:00:00.000Z'),
      50
    );
    const ids = rows.map((row) => row.receivableId);

    expect(ids).toContain(live.receivableId);
    expect(ids).not.toContain(cleared.receivableId);
    expect(ids).not.toContain(deleted.receivableId);
  });
});
