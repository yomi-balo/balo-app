import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { AdminEngagementListItem } from '@balo/db';

const { mockListAll } = vi.hoisted(() => ({ mockListAll: vi.fn() }));

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    listAllWithProgress: (...args: unknown[]) => mockListAll(...args),
  },
  AUTO_ACCEPT_DAYS: 7,
}));

import { loadEngagementsOversight } from './engagements-oversight';

const NOW = new Date('2026-06-16T12:00:00.000Z');
const day = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

/** A minimal repo item carrying only the fields the derivers read. */
function fakeItem(
  id: string,
  status: AdminEngagementListItem['status'],
  lastActivityAt: Date | null
): AdminEngagementListItem {
  return {
    id,
    status,
    pricingMethod: 'fixed',
    priceCents: 1_000_000,
    rateCents: null,
    currency: 'aud',
    activatedAt: day(30),
    createdAt: day(40),
    completionRequestedAt: status === 'pending_acceptance' ? day(3) : null,
    acceptanceMethod: status === 'completed' ? 'auto' : null,
    acceptedAt: status === 'completed' ? day(5) : null,
    cancelledAt: status === 'cancelled' ? day(5) : null,
    cancellationReason: status === 'cancelled' ? 'stopped' : null,
    company: { id: 'c-1', name: 'Northwind' },
    expertProfile: {
      id: 'ep-1',
      agencyId: null,
      type: 'independent',
      headline: null,
      user: { id: 'u-1', firstName: 'Sam', lastName: 'Expert', avatarUrl: null },
      agency: null,
    },
    projectRequest: { id: 'r-1', title: 'Rollout' },
    acceptedBy: null,
    cancelledBy: null,
    totalMilestones: 3,
    completedMilestones: 1,
    inProgressMilestones: 1,
    lastActivityAt,
  } as unknown as AdminEngagementListItem;
}

beforeEach(() => {
  mockListAll.mockReset();
});

describe('loadEngagementsOversight', () => {
  it('maps every repo item into a serialisable row and counts the whole set', async () => {
    mockListAll.mockResolvedValue([
      fakeItem('a', 'active', day(1)), // fresh active
      fakeItem('b', 'active', day(30)), // stalled active
      fakeItem('c', 'pending_acceptance', day(30)), // stalled in-review
      fakeItem('d', 'completed', day(5)),
      fakeItem('e', 'cancelled', day(5)),
    ]);

    const dto = await loadEngagementsOversight(NOW);

    expect(dto.rows).toHaveLength(5);
    expect(dto.isEmpty).toBe(false);
    expect(dto.counts).toEqual({
      active: 2,
      inReview: 1,
      stalled: 2,
      completed: 1,
      cancelled: 1,
    });
    // Rows are fully serialisable — no Date leaks across the boundary.
    expect(dto.rows.every((r) => typeof r.lastActivityIso === 'string')).toBe(true);
    expect(dto.rows[0]?.href).toBe('/engagements/a');
  });

  it('injects AUTO_ACCEPT_DAYS so an in-review row carries the auto-accept fact', async () => {
    mockListAll.mockResolvedValue([fakeItem('p', 'pending_acceptance', day(1))]);

    const dto = await loadEngagementsOversight(NOW);

    // completionRequestedAt = day(3) = 2026-06-13T12:00Z, + 7 days = 2026-06-20T12:00Z
    // (rendered viewer-local as "20 Jun" by <LocalDate>).
    expect(dto.rows[0]?.autoAcceptIso).toBe('2026-06-20T12:00:00.000Z');
  });

  it('returns an empty, all-zero DTO when there are no engagements', async () => {
    mockListAll.mockResolvedValue([]);

    const dto = await loadEngagementsOversight(NOW);

    expect(dto.rows).toEqual([]);
    expect(dto.isEmpty).toBe(true);
    expect(dto.counts).toEqual({
      active: 0,
      inReview: 0,
      stalled: 0,
      completed: 0,
      cancelled: 0,
    });
  });
});
