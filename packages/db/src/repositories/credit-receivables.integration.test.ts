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
