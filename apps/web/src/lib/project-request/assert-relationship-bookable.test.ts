import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const RELATIONSHIP_ID = 'c0000000-0000-4000-8000-000000000002';

const mockFindById = vi.fn();
vi.mock('@balo/db', () => ({
  requestExpertRelationshipsRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));
// The real, pure `relationshipDeniesHosting` is what is under test — never mocked.

import { assertRelationshipBookable } from './assert-relationship-bookable';

function relationshipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RELATIONSHIP_ID,
    status: 'eoi_submitted',
    declinedAt: null,
    ...overrides,
  };
}

describe('assertRelationshipBookable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is bookable for a live, non-declined relationship', async () => {
    mockFindById.mockResolvedValue(relationshipRow());
    await expect(assertRelationshipBookable(RELATIONSHIP_ID)).resolves.toBe(true);
    expect(mockFindById).toHaveBeenCalledWith(RELATIONSHIP_ID);
  });

  it('is NOT bookable when the row is missing or soft-deleted (withdrawn)', async () => {
    mockFindById.mockResolvedValue(undefined);
    await expect(assertRelationshipBookable(RELATIONSHIP_ID)).resolves.toBe(false);
  });

  it('is NOT bookable when declined by status alone', async () => {
    mockFindById.mockResolvedValue(relationshipRow({ status: 'declined' }));
    await expect(assertRelationshipBookable(RELATIONSHIP_ID)).resolves.toBe(false);
  });

  it('is NOT bookable when declinedAt is set alone (a partial write)', async () => {
    mockFindById.mockResolvedValue(
      relationshipRow({ status: 'eoi_submitted', declinedAt: new Date() })
    );
    await expect(assertRelationshipBookable(RELATIONSHIP_ID)).resolves.toBe(false);
  });

  it('is NOT bookable when both status AND declinedAt disagree with "live" — fails closed', async () => {
    mockFindById.mockResolvedValue(relationshipRow({ status: 'declined', declinedAt: new Date() }));
    await expect(assertRelationshipBookable(RELATIONSHIP_ID)).resolves.toBe(false);
  });
});
