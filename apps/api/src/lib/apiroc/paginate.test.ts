import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLog = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

// Matches the mocking convention already used for this directory (e.g. interceptor.test.ts) —
// mock the underlying @balo/shared/logging factory, not lib/apiroc/logging.ts directly.
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => mockLog,
}));

import { paginateApiroc, APIROC_PAGINATE_MAX_PAGES } from './paginate.js';
import { paginateApiroc as paginateApirocFromIndex } from './index.js';

describe('paginateApiroc (BAL-396 §10.2/§10.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is re-exported from the barrel identically (no circular-import breakage)', () => {
    expect(paginateApirocFromIndex).toBe(paginateApiroc);
  });

  it('collects every page until nextPageToken is absent', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [1, 2], nextPageToken: 'p2' })
      .mockResolvedValueOnce({ data: [3], nextPageToken: 'p3' })
      .mockResolvedValueOnce({ data: [] }); // Microsoft's trailing empty page

    const results = await paginateApiroc('events.list', fetchPage);

    expect(results).toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 'p2');
    expect(fetchPage).toHaveBeenNthCalledWith(3, 'p3');
  });

  it('returns everything on a single page with no nextPageToken', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: ['a', 'b'] });
    const results = await paginateApiroc('calendars.list', fetchPage);
    expect(results).toEqual(['a', 'b']);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('propagates a mid-pagination failure through callApiroc normalisation', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [1], nextPageToken: 'p2' })
      .mockRejectedValueOnce(new Error('network blip'));

    await expect(paginateApiroc('events.list', fetchPage)).rejects.toThrow();
  });

  // ── BAL-396 fix round 2, Finding 2 — the unbounded-loop fix ─────────────────────────────

  it(
    'aborts instead of looping forever when the vendor echoes a CONSTANT cursor (repeating ' +
      'nextPageToken)',
    async () => {
      const fetchPage = vi
        .fn()
        .mockResolvedValueOnce({ data: [1], nextPageToken: 'stuck' })
        .mockResolvedValueOnce({ data: [2], nextPageToken: 'stuck' }); // same token again

      const results = await paginateApiroc('events.list', fetchPage);

      // Two pages fetched (the second confirms the cursor genuinely repeated), then aborted —
      // never a third call, which is what an infinite loop would keep making.
      expect(results).toEqual([1, 2]);
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'events.list' }),
        'apiroc_paginate_cursor_not_progressing'
      );
    }
  );

  it('stops at APIROC_PAGINATE_MAX_PAGES when the vendor keeps minting genuinely NEW tokens forever', async () => {
    const fetchPage = vi.fn().mockImplementation((pageToken: string | undefined) => {
      const n = pageToken ? Number(pageToken) : 0;
      return Promise.resolve({ data: [n], nextPageToken: String(n + 1) });
    });

    const results = await paginateApiroc('events.list', fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(APIROC_PAGINATE_MAX_PAGES);
    expect(results).toHaveLength(APIROC_PAGINATE_MAX_PAGES);
    // Never runs away past the cap, no matter how many "new" tokens the vendor keeps minting.
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'events.list', maxPages: APIROC_PAGINATE_MAX_PAGES }),
      'apiroc_paginate_max_pages_reached'
    );
  });

  it('does not warn or truncate on the ordinary bounded case (guards against an always-firing cap)', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [1], nextPageToken: 'p2' })
      .mockResolvedValueOnce({ data: [2] });

    await paginateApiroc('calendars.list', fetchPage);

    expect(mockLog.warn).not.toHaveBeenCalled();
  });
});
