import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEventsList } = vi.hoisted(() => ({
  mockEventsList: vi.fn(),
}));

vi.mock('../../lib/apiroc/index.js', () => ({
  getApirocClient: () => ({ events: { list: mockEventsList } }),
  callApiroc: async (_operation: string, fn: () => Promise<unknown>) => fn(),
  paginateApiroc: async (
    _operation: string,
    fetchPage: (
      pageToken: string | undefined
    ) => Promise<{ data: unknown[]; nextPageToken?: string }>
  ) => {
    const results: unknown[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const page = await fetchPage(pageToken);
      results.push(...page.data);
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
    return results;
  },
}));

const { reconcileByTag } = await import('./reconcile-by-tag.js');

describe('reconcileByTag (BAL-396 §5/§10.6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries by metadataFilters.baloBookingId', async () => {
    mockEventsList.mockResolvedValue({ data: [] });

    await reconcileByTag({
      endUserAccountId: 'eua-1',
      calendarId: 'cal-1',
      baloBookingId: 'booking-1',
    });

    expect(mockEventsList).toHaveBeenCalledWith('eua-1', 'cal-1', {
      metadataFilters: { baloBookingId: 'booking-1' },
    });
  });

  it('⚠⚠ M3 — reconciles a Microsoft page whose events carry {} privateExtendedProperties (never reads the tag off results)', async () => {
    // The negative-control shape from the apiroc skill: the filter did the work; the
    // returned events carry NOTHING readable back.
    mockEventsList.mockResolvedValue({
      data: [
        { id: 'ms-event-1', title: 'BAL393 A', privateExtendedProperties: {} },
        { id: 'ms-event-2', title: 'BAL393 B', privateExtendedProperties: {} },
      ],
    });

    const results = await reconcileByTag({
      endUserAccountId: 'eua-1',
      calendarId: 'cal-1',
      baloBookingId: 'tag-AAA',
    });

    // Still reconciles by id — the function never filters again on the (empty) tag.
    expect(results.map((e) => e.id)).toEqual(['ms-event-1', 'ms-event-2']);
  });

  it('paginates to exhaustion, following nextPageToken and terminating on the trailing empty page', async () => {
    mockEventsList
      .mockResolvedValueOnce({ data: [{ id: 'e1' }], nextPageToken: 'p2' })
      .mockResolvedValueOnce({ data: [{ id: 'e2' }], nextPageToken: 'p3' })
      .mockResolvedValueOnce({ data: [] });

    const results = await reconcileByTag({
      endUserAccountId: 'eua-1',
      calendarId: 'cal-1',
      baloBookingId: 'booking-1',
    });

    expect(mockEventsList).toHaveBeenCalledTimes(3);
    expect(mockEventsList).toHaveBeenNthCalledWith(1, 'eua-1', 'cal-1', {
      metadataFilters: { baloBookingId: 'booking-1' },
    });
    expect(mockEventsList).toHaveBeenNthCalledWith(2, 'eua-1', 'cal-1', {
      metadataFilters: { baloBookingId: 'booking-1' },
      pageToken: 'p2',
    });
    expect(results.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('a Google page whose events DO echo the tag reconciles identically (parity — no provider branch)', async () => {
    mockEventsList.mockResolvedValue({
      data: [{ id: 'g-event-1', privateExtendedProperties: { baloBookingId: 'tag-AAA' } }],
    });

    const results = await reconcileByTag({
      endUserAccountId: 'eua-1',
      calendarId: 'cal-1',
      baloBookingId: 'tag-AAA',
    });

    expect(results.map((e) => e.id)).toEqual(['g-event-1']);
  });
});
