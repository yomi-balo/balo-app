import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { creditSessions, expertProfiles } from '../schema';
import { creditWalletFactory, expertFactory, userFactory } from '../test/factories';
import { creditReceivablesRepository } from './credit-receivables';
import { creditSessionsRepository } from './credit-sessions';

/**
 * Integration tests for `creditReceivablesRepository` (BAL-378). Covers idempotent `open`
 * per session (partial-unique on `session_id`), the `hasOpenReceivable` soft-hold predicate,
 * `listOpenForDunning` cadence filtering, and `clear` (which releases the soft hold). Each
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

describe('creditReceivablesRepository.listOpenForDunning / markDunned', () => {
  it('returns never-dunned and stale-dunned receivables, excluding freshly-dunned ones', async () => {
    const a = await seedSession();
    const b = await seedSession();

    const { receivable: recA } = await creditReceivablesRepository.open({
      companyId: a.companyId,
      walletId: a.walletId,
      sessionId: a.sessionId,
      amountMinor: 1000,
      reason: 'settlement_declined',
    });
    const { receivable: recB } = await creditReceivablesRepository.open({
      companyId: b.companyId,
      walletId: b.walletId,
      sessionId: b.sessionId,
      amountMinor: 2000,
      reason: 'settlement_declined',
    });

    const now = new Date('2027-03-01T09:00:00.000Z');
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60_000);

    // recB was dunned just now (fresh) → excluded from a `notDunnedSince = 1 day ago` sweep.
    await creditReceivablesRepository.markDunned(recB.id, now);

    const due = await creditReceivablesRepository.listOpenForDunning(oneDayAgo);
    const dueIds = due.map((r) => r.id);
    expect(dueIds).toContain(recA.id); // never dunned
    expect(dueIds).not.toContain(recB.id); // dunned within the cadence
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
