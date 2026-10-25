import { describe, it, expect } from 'vitest';
import { deriveProjectSettlement } from '@balo/shared/engagements';
import {
  DANA,
  makeLine,
  makeMilestone,
  makeOrder,
  makeProject,
} from '@/test/change-order-fixtures';
import { deriveEngagementParties } from './engagement-parties';
import { mapChangeOrderAdminView } from './change-order-admin-view';

const approved = (id: string, decidedAt: string, priceDeltaCents: number) =>
  makeOrder({
    id,
    status: 'approved',
    priceDeltaCents,
    sentAt: new Date('2026-10-01T00:00:00Z'),
    decidedAt: new Date(decidedAt),
    decidedBy: DANA,
    lines: [makeLine({ title: 'Anything' })],
  });

function fixed(opts: {
  orders: Parameters<typeof mapChangeOrderAdminView>[1];
  deltas: number[];
  upfront: number;
}): ReturnType<typeof mapChangeOrderAdminView> {
  const engagement = makeProject();
  return mapChangeOrderAdminView(
    deriveProjectSettlement({
      acceptedPriceCents: engagement.priceCents,
      approvedDeltasInOrder: opts.deltas,
      baloFeeBps: 2500,
      upfrontDueClientCents: opts.upfront,
    }),
    opts.orders,
    engagement,
    deriveEngagementParties(engagement)
  );
}

describe('mapChangeOrderAdminView — fixed price', () => {
  it('shows both sides of every row, and the rows telescope to the current price', () => {
    const view = fixed({
      orders: [
        approved('b', '2026-10-12T00:00:00Z', -200_000),
        approved('a', '2026-10-05T00:00:00Z', 100_000),
      ],
      deltas: [100_000, -200_000],
      upfront: 312_500,
    });
    if (view.kind !== 'fixed') throw new Error('expected the fixed view');

    expect(view.rows).toEqual([
      {
        label: 'Accepted price',
        expert: 'A$10,000',
        client: 'A$12,500',
        margin: 'A$2,500',
        strong: false,
      },
      {
        label: 'Change approved 5 Oct',
        expert: '+A$1,000',
        client: '+A$1,250',
        margin: '+A$250',
        strong: false,
      },
      {
        label: 'Change approved 12 Oct',
        expert: '-A$2,000',
        client: '-A$2,500',
        margin: '-A$500',
        strong: false,
      },
      {
        label: 'Current price',
        expert: 'A$9,000',
        client: 'A$11,250',
        margin: 'A$2,250',
        strong: true,
      },
    ]);
    expect(view.upfrontLabel).toBe('-A$3,125');
    expect(view.finalInvoiceLabel).toBe('A$8,125');
    expect(view.finalInvoiceNegative).toBe(false);
    expect(view.creditNeededText).toBeNull();
    expect(view.pendingNote).toBeNull();
  });

  it('flags a negative final invoice with the credit banner copy', () => {
    const view = fixed({
      orders: [approved('a', '2026-10-05T00:00:00Z', -800_000)],
      deltas: [-800_000],
      upfront: 1_250_000,
    });
    if (view.kind !== 'fixed') throw new Error('expected the fixed view');

    expect(view.finalInvoiceNegative).toBe(true);
    expect(view.finalInvoiceLabel).toBe('-A$10,000');
    expect(view.creditNeededText).toBe(
      'Credit needed: A$10,000. The approved change took the price below what Northwind has already been invoiced. Issue an adjustment note, then close the item in the pending-actions queue.'
    );
  });

  it('notes a sent change that is not in the totals yet, with both sides', () => {
    const sent = makeOrder({
      id: 's',
      status: 'sent',
      priceDeltaCents: 100_000,
      sentAt: new Date(),
    });
    const view = fixed({ orders: [sent], deltas: [], upfront: 312_500 });
    if (view.kind !== 'fixed') throw new Error('expected the fixed view');

    expect(view.pendingNote).toBe(
      'Waiting on Northwind: +A$1,000 expert, +A$1,250 client (not in the totals yet).'
    );
    expect(view.footnote).toContain('Xero');
  });
});

describe('mapChangeOrderAdminView — time and materials', () => {
  const engagement = makeProject({
    pricingMethod: 'tm',
    milestones: [makeMilestone({ estimatedMinutes: 3600 })],
  });
  const settlement = deriveProjectSettlement({
    acceptedPriceCents: 1_000_000,
    approvedDeltasInOrder: [],
    baloFeeBps: 2500,
    upfrontDueClientCents: 0,
  });

  it('derives the accepted estimate from the current one less the approved deltas', () => {
    const order = makeOrder({
      id: 'a',
      status: 'approved',
      decidedAt: new Date('2026-10-05T00:00:00Z'),
      lines: [makeLine({ op: 'add', estimatedMinutes: 600 })],
    });
    const view = mapChangeOrderAdminView(
      settlement,
      [order],
      engagement,
      deriveEngagementParties(engagement)
    );
    if (view.kind !== 'tm') throw new Error('expected the T&M view');

    expect(view.rows).toEqual([
      { label: 'Accepted estimate', value: '50 hrs', strong: false },
      { label: 'Change approved 5 Oct', value: '+10 hrs', strong: false },
      { label: 'Current estimate', value: '60 hrs', strong: true },
      { label: 'Accepted cap', value: 'A$10,000 expert · A$12,500 client', strong: false },
      { label: 'Current cap', value: 'A$10,000 expert · A$12,500 client', strong: true },
    ]);
    expect(view.footnote).toContain('up to the cap');
  });

  it('labels an approved cap change on both sides, and a sent one in the pending note', () => {
    const capSettlement = deriveProjectSettlement({
      acceptedPriceCents: 1_000_000,
      approvedDeltasInOrder: [100_000],
      baloFeeBps: 2500,
      upfrontDueClientCents: 0,
    });
    const approved = makeOrder({
      id: 'a',
      status: 'approved',
      priceDeltaCents: 100_000,
      decidedAt: new Date('2026-10-05T00:00:00Z'),
      lines: [],
    });
    const sent = makeOrder({
      id: 'b',
      status: 'sent',
      priceDeltaCents: 40_000,
      sentAt: new Date(),
      lines: [makeLine({ op: 'add', estimatedMinutes: 90 })],
    });
    const view = mapChangeOrderAdminView(
      capSettlement,
      [approved, sent],
      engagement,
      deriveEngagementParties(engagement)
    );
    if (view.kind !== 'tm') throw new Error('expected the T&M view');

    expect(view.rows).toContainEqual({
      label: 'Cap change approved 5 Oct',
      value: '+A$1,000 expert · +A$1,250 client',
      strong: false,
    });
    expect(view.rows).toContainEqual({
      label: 'Current cap',
      value: 'A$11,000 expert · A$13,750 client',
      strong: true,
    });
    expect(view.pendingNote).toBe(
      'Waiting on Northwind: +1.5 hrs, cap +A$400 expert, +A$500 client (not in the totals yet).'
    );
  });

  it('notes a sent change in hours', () => {
    const sent = makeOrder({
      status: 'sent',
      sentAt: new Date(),
      lines: [makeLine({ op: 'add', estimatedMinutes: 90 })],
    });
    const view = mapChangeOrderAdminView(
      settlement,
      [sent],
      engagement,
      deriveEngagementParties(engagement)
    );
    expect(view.pendingNote).toBe('Waiting on Northwind: +1.5 hrs (not in the totals yet).');
  });
});
