import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => mockGetCurrentUser() }));

const mockResolveRequest = vi.fn();
const mockLoadMoreOpenCasesPage = vi.fn();
const mockLoadResolvedCasesPage = vi.fn();
vi.mock('../_lib/load-cases-index', () => ({
  resolveCasesIndexRequest: (...a: unknown[]) => mockResolveRequest(...a),
  loadMoreOpenCasesPage: (...a: unknown[]) => mockLoadMoreOpenCasesPage(...a),
  loadResolvedCasesPage: (...a: unknown[]) => mockLoadResolvedCasesPage(...a),
}));

import { loadMoreOpenCases, loadMoreResolvedCases } from './load-more-cases';
import { log } from '@/lib/logging';

/**
 * BAL-567 — the two "show more" Server Actions.
 *
 * ⚠⚠ THE SCOPE IS NEVER TAKEN FROM THE CALLER. These actions accept a CURSOR and nothing else;
 * the party ids come from the sealed session on every call, and the participation gate is
 * re-run inside the loader. A `companyId` accepted here would be a client-supplied tenancy key.
 */

const CANNOT_LOAD = 'We couldn’t load more cases. Try again in a moment.';
const CURSOR = { bucket: 0, sortRank: 1, id: '11111111-1111-4111-8111-111111111111' };
const REQUEST = { side: 'company' as const, companyId: 'co-1', companyName: 'Acme Corp' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  mockResolveRequest.mockReturnValue(REQUEST);
  mockLoadMoreOpenCasesPage.mockResolvedValue({ rows: [], hasMore: false, nextCursor: null });
  mockLoadResolvedCasesPage.mockResolvedValue({ rows: [], hasMore: false, nextCursor: null });
});

describe('loadMoreOpenCases', () => {
  it('re-derives the scope from the SESSION, and passes only the cursor onward', async () => {
    await loadMoreOpenCases({ cursor: CURSOR });

    expect(mockResolveRequest).toHaveBeenCalledWith({ id: 'user-1' });
    expect(mockLoadMoreOpenCasesPage).toHaveBeenCalledWith({
      viewerUserId: 'user-1',
      request: REQUEST,
      after: CURSOR,
    });
  });

  it('refuses an unauthenticated caller without reading anything', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(loadMoreOpenCases({ cursor: CURSOR })).resolves.toEqual({
      success: false,
      error: CANNOT_LOAD,
    });
    expect(mockLoadMoreOpenCasesPage).not.toHaveBeenCalled();
  });

  it('refuses an expert-mode session with no profile, with the SAME message', async () => {
    mockResolveRequest.mockReturnValue(null);
    await expect(loadMoreOpenCases({ cursor: CURSOR })).resolves.toEqual({
      success: false,
      error: CANNOT_LOAD,
    });
    expect(mockLoadMoreOpenCasesPage).not.toHaveBeenCalled();
  });

  it('refuses when the participation gate denies — indistinguishable from every other refusal', async () => {
    mockLoadMoreOpenCasesPage.mockResolvedValue(null);
    await expect(loadMoreOpenCases({ cursor: CURSOR })).resolves.toEqual({
      success: false,
      error: CANNOT_LOAD,
    });
  });

  it.each([
    ['a non-uuid id', { bucket: 0, sortRank: 1, id: 'not-a-uuid' }],
    ['an out-of-range bucket', { ...CURSOR, bucket: 7 }],
    ['an extra key', { ...CURSOR, companyId: 'co-2' }],
  ])('rejects %s before reading', async (_label, cursor) => {
    await expect(
      loadMoreOpenCases({ cursor } as unknown as { cursor: typeof CURSOR })
    ).resolves.toEqual({ success: false, error: CANNOT_LOAD });
    expect(mockLoadMoreOpenCasesPage).not.toHaveBeenCalled();
  });

  it('accepts a NEGATIVE sortRank — the unbooked bucket negates its epoch', async () => {
    await loadMoreOpenCases({ cursor: { ...CURSOR, bucket: 1, sortRank: -1_789_000_000 } });
    expect(mockLoadMoreOpenCasesPage).toHaveBeenCalled();
  });

  it('logs and refuses on a thrown read', async () => {
    mockLoadMoreOpenCasesPage.mockRejectedValue(new Error('boom'));
    await expect(loadMoreOpenCases({ cursor: CURSOR })).resolves.toEqual({
      success: false,
      error: CANNOT_LOAD,
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to load more open cases',
      expect.objectContaining({ userId: 'user-1', workspaceType: 'company', error: 'boom' })
    );
  });
});

describe('loadMoreResolvedCases', () => {
  it('accepts a NULL cursor — that is page one of a section that starts collapsed', async () => {
    await expect(loadMoreResolvedCases({ cursor: null })).resolves.toEqual({
      success: true,
      rows: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(mockLoadResolvedCasesPage).toHaveBeenCalledWith({
      viewerUserId: 'user-1',
      request: REQUEST,
      after: undefined,
    });
  });

  it('passes a real cursor straight through', async () => {
    const after = { closedAtEpoch: 1_754_179_200, id: '22222222-2222-4222-8222-222222222222' };
    await loadMoreResolvedCases({ cursor: after });
    expect(mockLoadResolvedCasesPage).toHaveBeenCalledWith(expect.objectContaining({ after }));
  });

  it('rejects a malformed cursor before reading', async () => {
    await expect(
      loadMoreResolvedCases({ cursor: { closedAtEpoch: 'soon', id: 'x' } } as never)
    ).resolves.toEqual({ success: false, error: CANNOT_LOAD });
    expect(mockLoadResolvedCasesPage).not.toHaveBeenCalled();
  });

  it('logs and refuses on a thrown read', async () => {
    mockLoadResolvedCasesPage.mockRejectedValue(new Error('kaboom'));
    await expect(loadMoreResolvedCases({ cursor: null })).resolves.toEqual({
      success: false,
      error: CANNOT_LOAD,
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to load resolved cases',
      expect.objectContaining({ error: 'kaboom' })
    );
  });
});
