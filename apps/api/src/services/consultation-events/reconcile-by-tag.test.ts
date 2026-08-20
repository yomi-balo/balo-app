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

  /**
   * BAL-468 §13 — the §2 discharge. §2's real risk is a busy calendar returning everything on
   * page 1 because the default page size (400) hides the bug in dev/test accounts. This drives
   * the REAL `reconcileByTag` against a fake `events.list` that behaves like a genuinely
   * paginating server: it holds 7 tagged events, slices them into pages of 2, mints an opaque
   * cursor per page, and emits a trailing empty page with no `nextPageToken` (the Microsoft
   * shape) — exactly what a busy real calendar does, without `reconcileByTag` itself ever
   * passing a page size.
   */
  it('⚠ the forced small-page test: a genuinely paginating transport (page size 2) over 7 tagged events terminates cleanly and returns all 7 exactly once, in order', async () => {
    const allEvents = Array.from({ length: 7 }, (_, i) => ({ id: `evt-${i}` }));
    const PAGE_SIZE = 2;
    mockEventsList.mockImplementation(
      async (_eua: string, _cal: string, params: { pageToken?: string }) => {
        const start = params.pageToken ? Number(params.pageToken) : 0;
        const page = allEvents.slice(start, start + PAGE_SIZE);
        const nextStart = start + PAGE_SIZE;
        // Microsoft's own shape: keep emitting a token until the data itself is spent, THEN
        // one more call returns a trailing empty page (count: 0) with no token at all.
        return {
          data: page,
          ...(start < allEvents.length ? { nextPageToken: String(nextStart) } : {}),
        };
      }
    );

    const results = await reconcileByTag({
      endUserAccountId: 'eua-1',
      calendarId: 'cal-1',
      baloBookingId: 'booking-1',
    });

    expect(results.map((e) => e.id)).toEqual(allEvents.map((e) => e.id));
    // ceil(7/2) = 4 pages with data + 1 trailing empty page = 5 calls.
    expect(mockEventsList).toHaveBeenCalledTimes(5);
    for (const call of mockEventsList.mock.calls) {
      const params = call[2] as { metadataFilters?: unknown };
      expect(params.metadataFilters).toEqual({ baloBookingId: 'booking-1' });
    }
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
