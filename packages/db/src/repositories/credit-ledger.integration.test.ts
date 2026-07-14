import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, creditLedger, creditWallets, type AuditEvent } from '../schema';
import { creditWalletFactory, userFactory } from '../test/factories';
import {
  applyLedgerEntry,
  creditLedgerRepository,
  WalletNotFoundError,
  type ApplyLedgerEntryInput,
} from './credit-ledger';
import { deriveIdempotencyKey } from './_shared/credit-idempotency';

/**
 * Integration tests for the atomic ledger-write primitive (BAL-376). Covers invariants
 * #3 (cache == ledger sum), #4 (idempotent replay is a no-op), #7 (consume/settlement
 * carry member attribution + a same-txn audit row), #8 (only amount_minor is in balance
 * math), plus the ADR concurrency criterion and same-txn rollback atomicity. Exercises
 * `_shared/credit-audit.ts` and `_shared/wallet-lock.ts` indirectly. Factories only.
 *
 * CONCURRENCY CAVEAT: the harness test-client is a `max:1` pool inside a single per-test
 * transaction, so TRUE parallel connections aren't available. The "single-in-flight"
 * guarantee is modelled DETERMINISTICALLY by sequential replays of the same key behind
 * the advisory lock + idempotency backstop (see the auto-top-up test).
 */

/** Read credit audit rows for a wallet + action, oldest first. */
async function auditRowsFor(walletId: string, action: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.entityId, walletId), eq(auditEvents.action, action)))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
}

describe('applyLedgerEntry — invariant #3 (cache == ledger sum)', () => {
  it('keeps balance_minor == SUM(amount_minor) and each balance_after_minor on the running sum', async () => {
    const { wallet } = await creditWalletFactory();
    const member = await userFactory();
    const sessionId = randomUUID();

    const posts: ApplyLedgerEntryInput[] = [
      {
        walletId: wallet.id,
        entryType: 'purchase',
        reason: 'manual_purchase',
        amountMinor: 5000,
        idempotencyKey: 'k1',
      },
      {
        walletId: wallet.id,
        entryType: 'consume',
        reason: 'session_consume',
        amountMinor: -1200,
        idempotencyKey: 'k2',
        memberId: member.id,
        sessionId,
      },
      {
        walletId: wallet.id,
        entryType: 'purchase',
        reason: 'auto_topup',
        amountMinor: 2000,
        idempotencyKey: 'k3',
      },
      {
        walletId: wallet.id,
        entryType: 'consume',
        reason: 'session_consume',
        amountMinor: -300,
        idempotencyKey: 'k4',
        memberId: member.id,
        sessionId,
      },
    ];

    let running = 0;
    for (const input of posts) {
      running += input.amountMinor;
      const { entry, wallet: after } = await creditLedgerRepository.postEntry(input);
      expect(entry.balanceAfterMinor).toBe(running);
      expect(after.balanceMinor).toBe(running);
    }

    // Final cache == ledger sum.
    const finalWallet = await db.query.creditWallets.findFirst({
      where: eq(creditWallets.id, wallet.id),
    });
    const ledgerSum = await creditLedgerRepository.sumAmountByWallet(wallet.id);
    expect(finalWallet?.balanceMinor).toBe(5500);
    expect(ledgerSum).toBe(5500);
    expect(finalWallet?.balanceMinor).toBe(ledgerSum);

    // Every row's snapshot lies on the running sum, in insertion order.
    const rows = await creditLedgerRepository.listByWallet(wallet.id);
    expect(rows.map((r) => r.balanceAfterMinor)).toEqual([5000, 3800, 5800, 5500]);
  });

  it('permits a negative balance (overdraft grace — the primitive is mechanism, not policy)', async () => {
    const { wallet } = await creditWalletFactory();
    const member = await userFactory();
    const { wallet: after } = await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'consume',
      reason: 'session_consume',
      amountMinor: -4200,
      idempotencyKey: 'overdraft_1',
      memberId: member.id,
      sessionId: randomUUID(),
    });
    expect(after.balanceMinor).toBe(-4200);
  });
});

describe('applyLedgerEntry — invariant #4 (idempotent replay is a no-op)', () => {
  it('a replayed idempotency key returns deduped:true, one row, balance unchanged', async () => {
    const { wallet } = await creditWalletFactory();
    const key = deriveIdempotencyKey({ reason: 'manual_purchase', paymentIntentId: 'pi_dup' });

    const first = await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'purchase',
      reason: 'manual_purchase',
      amountMinor: 9000,
      idempotencyKey: key,
      stripePaymentIntentId: 'pi_dup',
    });
    expect(first.deduped).toBe(false);
    expect(first.wallet.balanceMinor).toBe(9000);

    const second = await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'purchase',
      reason: 'manual_purchase',
      amountMinor: 9000,
      idempotencyKey: key,
      stripePaymentIntentId: 'pi_dup',
    });
    expect(second.deduped).toBe(true);
    expect(second.entry.id).toBe(first.entry.id); // same row returned
    expect(second.wallet.balanceMinor).toBe(9000); // NOT double-credited

    const rows = await creditLedgerRepository.listByWallet(wallet.id);
    expect(rows).toHaveLength(1);
  });

  it('ADR concurrency criterion: sequential replays of one auto-top-up key credit exactly once', async () => {
    // Models "two near-simultaneous consumes each below threshold": the second attempt
    // (same threshold-crossing key) serializes behind the advisory lock and no-ops. Under
    // max:1 this is deterministic sequential replay (see file header caveat).
    const { wallet } = await creditWalletFactory();
    const reloadKey = deriveIdempotencyKey({
      reason: 'auto_topup',
      walletId: wallet.id,
      triggeringEntryId: 'led_trigger',
    });

    const a = await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'purchase',
      reason: 'auto_topup',
      amountMinor: 10_000,
      idempotencyKey: reloadKey,
    });
    const b = await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'purchase',
      reason: 'auto_topup',
      amountMinor: 10_000,
      idempotencyKey: reloadKey,
    });

    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(await creditLedgerRepository.sumAmountByWallet(wallet.id)).toBe(10_000); // one reload only
  });
});

describe('applyLedgerEntry — invariant #7 (attribution + same-txn audit)', () => {
  it('a session_consume writes member_id AND exactly one credit_wallet.consumed audit row', async () => {
    const { wallet, companyId } = await creditWalletFactory();
    const member = await userFactory();
    const sessionId = randomUUID();

    const { entry } = await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'consume',
      reason: 'session_consume',
      amountMinor: -750,
      idempotencyKey: 'consume_1',
      memberId: member.id,
      sessionId,
    });

    expect(entry.memberId).toBe(member.id);

    const rows = await auditRowsFor(wallet.id, 'credit_wallet.consumed');
    expect(rows).toHaveLength(1);
    const [audit] = rows;
    expect(audit?.actorUserId).toBe(member.id);
    expect(audit?.entityType).toBe('credit_wallet');
    expect(audit?.entityId).toBe(wallet.id);
    expect(audit?.metadata).toMatchObject({
      companyId,
      ledgerEntryId: entry.id,
      sessionId,
      entryType: 'consume',
      reason: 'session_consume',
      amountMinor: -750,
      balanceAfterMinor: -750,
    });
    // Fee-boundary: the audit metadata carries NO margin/markup/fee/quote (invariant #2).
    expect(JSON.stringify(audit?.metadata)).not.toContain('baloFeeBps');
    expect(JSON.stringify(audit?.metadata)).not.toContain('markup');
  });

  it('an overdraft_settlement writes a credit_wallet.settled audit row attributed to the member', async () => {
    const { wallet } = await creditWalletFactory();
    const member = await userFactory();
    const sessionId = randomUUID();

    await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'purchase',
      reason: 'overdraft_settlement',
      amountMinor: 3000,
      idempotencyKey: deriveIdempotencyKey({ reason: 'overdraft_settlement', sessionId }),
      memberId: member.id,
      sessionId,
    });

    const rows = await auditRowsFor(wallet.id, 'credit_wallet.settled');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorUserId).toBe(member.id);
  });

  it('a system entry (auto_topup) writes NO audit row and NO member attribution', async () => {
    const { wallet } = await creditWalletFactory();
    await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'purchase',
      reason: 'auto_topup',
      amountMinor: 10_000,
      idempotencyKey: 'topup_sys',
    });
    const consumed = await auditRowsFor(wallet.id, 'credit_wallet.consumed');
    const settled = await auditRowsFor(wallet.id, 'credit_wallet.settled');
    expect(consumed).toHaveLength(0);
    expect(settled).toHaveLength(0);
  });

  it('rolls back BOTH the ledger row and the audit row when the txn throws AFTER the write', async () => {
    const { wallet } = await creditWalletFactory();
    const member = await userFactory();

    await expect(
      db.transaction(async (tx) => {
        await applyLedgerEntry(tx, {
          walletId: wallet.id,
          entryType: 'consume',
          reason: 'session_consume',
          amountMinor: -500,
          idempotencyKey: 'rollback_1',
          memberId: member.id,
          sessionId: randomUUID(),
        });
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    // Nothing persisted: no ledger row, no audit row, balance untouched.
    const rows = await creditLedgerRepository.listByWallet(wallet.id);
    expect(rows).toHaveLength(0);
    const audits = await auditRowsFor(wallet.id, 'credit_wallet.consumed');
    expect(audits).toHaveLength(0);
    const w = await db.query.creditWallets.findFirst({ where: eq(creditWallets.id, wallet.id) });
    expect(w?.balanceMinor).toBe(0);
  });

  it('throws (before any write) when a session_consume arrives without a memberId', async () => {
    const { wallet } = await creditWalletFactory();
    await expect(
      creditLedgerRepository.postEntry({
        walletId: wallet.id,
        entryType: 'consume',
        reason: 'session_consume',
        amountMinor: -100,
        idempotencyKey: 'missing_member',
      })
    ).rejects.toThrow(/requires a memberId/i);
    expect(await creditLedgerRepository.listByWallet(wallet.id)).toHaveLength(0);
  });
});

describe('applyLedgerEntry — invariant #8 (only amount_minor moves the balance)', () => {
  it('records charged_currency/charged_amount/fx_rate but moves balance by amount_minor only', async () => {
    const { wallet } = await creditWalletFactory();
    const member = await userFactory();

    const { entry, wallet: after } = await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'purchase',
      reason: 'overdraft_settlement',
      amountMinor: 1000, // AUD 10.00 — the ONLY balance-affecting figure
      chargedCurrency: 'GBP',
      chargedAmountMinor: 520, // what the card was billed
      fxRate: '0.52000000',
      idempotencyKey: 'fx_1',
      memberId: member.id,
      sessionId: randomUUID(),
    });

    // The charged fields are recorded…
    expect(entry.chargedCurrency).toBe('GBP');
    expect(entry.chargedAmountMinor).toBe(520);
    expect(entry.fxRate).toBe('0.52000000');
    // …but the balance moved by amount_minor (1000), never the charged 520.
    expect(entry.balanceAfterMinor).toBe(1000);
    expect(after.balanceMinor).toBe(1000);
  });
});

describe('applyLedgerEntry — expiry & missing wallet', () => {
  it('rolls expires_at forward on a normal entry but NOT on a dormancy-expiry entry', async () => {
    const { wallet } = await creditWalletFactory();

    // A normal purchase stamps expires_at ~ now + 12 months.
    const { wallet: afterPurchase } = await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'purchase',
      reason: 'manual_purchase',
      amountMinor: 10_000,
      idempotencyKey: 'exp_purchase',
    });
    expect(afterPurchase.expiresAt).not.toBeNull();
    const stamped = afterPurchase.expiresAt as Date;
    const monthsAhead = (stamped.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30);
    expect(monthsAhead).toBeGreaterThan(11);
    expect(monthsAhead).toBeLessThan(13);

    // A dormancy-expiry entry debits but must NOT extend the wallet's own life.
    const { wallet: afterExpiry } = await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'expiry',
      reason: 'dormancy_expiry',
      amountMinor: -10_000,
      idempotencyKey: 'exp_sweep',
    });
    expect(afterExpiry.expiresAt?.getTime()).toBe(stamped.getTime());
    expect(afterExpiry.balanceMinor).toBe(0);
  });

  it('throws WalletNotFoundError for an unknown wallet (whole txn rolls back)', async () => {
    await expect(
      creditLedgerRepository.postEntry({
        walletId: '00000000-0000-0000-0000-000000000000',
        entryType: 'purchase',
        reason: 'manual_purchase',
        amountMinor: 100,
        idempotencyKey: 'ghost',
      })
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  it('rejects a zero-amount entry (CHECK amount_minor <> 0)', async () => {
    const { wallet } = await creditWalletFactory();
    await expect(
      creditLedgerRepository.postEntry({
        walletId: wallet.id,
        entryType: 'adjustment',
        reason: 'adjustment',
        amountMinor: 0,
        idempotencyKey: 'zero',
      })
    ).rejects.toThrow();
  });
});

describe('creditLedgerRepository reads', () => {
  it('findByIdempotencyKey returns the entry; listByWallet is created_at asc', async () => {
    const { wallet } = await creditWalletFactory();
    await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'purchase',
      reason: 'manual_purchase',
      amountMinor: 100,
      idempotencyKey: 'read_1',
    });
    const found = await creditLedgerRepository.findByIdempotencyKey('read_1');
    expect(found?.amountMinor).toBe(100);

    const missing = await creditLedgerRepository.findByIdempotencyKey('nope');
    expect(missing).toBeUndefined();
  });

  it('sumAmountByWallet returns 0 for a wallet with no entries', async () => {
    const { wallet } = await creditWalletFactory();
    expect(await creditLedgerRepository.sumAmountByWallet(wallet.id)).toBe(0);
  });
});
