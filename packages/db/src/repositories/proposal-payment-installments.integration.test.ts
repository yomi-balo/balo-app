import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { proposalPaymentInstallments } from '../schema';
import { proposalFactory } from '../test/factories';
import {
  proposalPaymentInstallmentsRepository,
  installmentsSumTo100,
} from './proposal-payment-installments';

describe('installmentsSumTo100', () => {
  it('is true when the integer percentages sum to exactly 100', () => {
    expect(installmentsSumTo100([{ pct: 30 }, { pct: 70 }])).toBe(true);
    expect(installmentsSumTo100([{ pct: 100 }])).toBe(true);
    expect(installmentsSumTo100([{ pct: 25 }, { pct: 25 }, { pct: 25 }, { pct: 25 }])).toBe(true);
  });

  it('is false otherwise (including the empty list)', () => {
    expect(installmentsSumTo100([])).toBe(false);
    expect(installmentsSumTo100([{ pct: 30 }, { pct: 60 }])).toBe(false);
    expect(installmentsSumTo100([{ pct: 50 }, { pct: 60 }])).toBe(false);
  });
});

describe('proposalPaymentInstallmentsRepository.setForProposal', () => {
  it('inserts an ordered set with sortOrder 0..n-1', async () => {
    const { proposal } = await proposalFactory();

    const rows = await proposalPaymentInstallmentsRepository.setForProposal({
      proposalId: proposal.id,
      installments: [
        { label: 'Upfront', pct: 30 },
        { label: 'On delivery', pct: 70 },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((i) => i.sortOrder)).toEqual([0, 1]);
    expect(rows.map((i) => i.label)).toEqual(['Upfront', 'On delivery']);
    expect(rows.map((i) => i.pct)).toEqual([30, 70]);
  });

  it('replace-all soft-deletes the prior set and returns only the new live rows in order', async () => {
    const { proposal } = await proposalFactory();
    const firstSet = await proposalPaymentInstallmentsRepository.setForProposal({
      proposalId: proposal.id,
      installments: [{ label: 'Old', pct: 100 }],
    });

    const secondSet = await proposalPaymentInstallmentsRepository.setForProposal({
      proposalId: proposal.id,
      installments: [
        { label: 'A', pct: 40 },
        { label: 'B', pct: 60 },
      ],
    });
    expect(secondSet.map((i) => i.label)).toEqual(['A', 'B']);

    const live = await proposalPaymentInstallmentsRepository.listByProposal(proposal.id);
    expect(live.map((i) => i.label)).toEqual(['A', 'B']);

    const all = await db
      .select()
      .from(proposalPaymentInstallments)
      .where(eq(proposalPaymentInstallments.proposalId, proposal.id));
    expect(all).toHaveLength(3);
    const oldIds = firstSet.map((i) => i.id);
    const oldOnDisk = all.filter((r) => oldIds.includes(r.id));
    expect(oldOnDisk.every((r) => r.deletedAt !== null)).toBe(true);
  });

  it('rejects a per-row pct outside 0..100 (CHECK) and rolls the set back', async () => {
    const { proposal } = await proposalFactory();

    await expect(
      proposalPaymentInstallmentsRepository.setForProposal({
        proposalId: proposal.id,
        installments: [{ label: 'Over', pct: 101 }],
      })
    ).rejects.toThrow();
    expect(await proposalPaymentInstallmentsRepository.listByProposal(proposal.id)).toHaveLength(0);

    await expect(
      proposalPaymentInstallmentsRepository.setForProposal({
        proposalId: proposal.id,
        installments: [{ label: 'Under', pct: -1 }],
      })
    ).rejects.toThrow();
    expect(await proposalPaymentInstallmentsRepository.listByProposal(proposal.id)).toHaveLength(0);
  });

  it('throws (FK 23503) for an unknown proposalId', async () => {
    await expect(
      proposalPaymentInstallmentsRepository.setForProposal({
        proposalId: randomUUID(),
        installments: [{ label: 'Orphan', pct: 100 }],
      })
    ).rejects.toThrow();
  });
});

describe('proposalPaymentInstallmentsRepository.listByProposal', () => {
  it('returns live rows ordered by sortOrder asc and excludes soft-deleted', async () => {
    const { proposal } = await proposalFactory();
    const rows = await proposalPaymentInstallmentsRepository.setForProposal({
      proposalId: proposal.id,
      installments: [
        { label: 'A', pct: 20 },
        { label: 'B', pct: 30 },
        { label: 'C', pct: 50 },
      ],
    });

    const [first] = rows;
    if (first === undefined) throw new Error('expected a seeded installment');
    await db
      .update(proposalPaymentInstallments)
      .set({ deletedAt: new Date() })
      .where(eq(proposalPaymentInstallments.id, first.id));

    const live = await proposalPaymentInstallmentsRepository.listByProposal(proposal.id);
    expect(live.map((i) => i.label)).toEqual(['B', 'C']);
    expect(live.map((i) => i.sortOrder)).toEqual([1, 2]);
  });
});
