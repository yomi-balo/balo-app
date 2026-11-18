import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';
import type { CaseSurfaceView } from '@/lib/cases/case-view-types';
import type { CallNowViewRead } from './call-now-types';

vi.mock('server-only', () => ({}));

const mockFindRate = vi.fn();
vi.mock('@balo/db', () => ({
  expertsRepository: { findRateCentsById: (...a: unknown[]) => mockFindRate(...a) },
}));

const mockGetView = vi.fn();
vi.mock('./call-now-api-client', () => ({
  getCallNowView: (...a: unknown[]) => mockGetView(...a),
}));

import { loadCaseCallNow, readCallNowView } from './load-case-call-now';

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000002';

function clientView(over: { isOpen?: boolean; profileHref?: string | null } = {}) {
  return {
    lens: 'client',
    engagementId: ENGAGEMENT_ID,
    expertProfileId: PROFILE_ID,
    header: { isOpen: over.isOpen ?? true },
    party: { profileHref: over.profileHref === undefined ? '/experts/amara' : over.profileHref },
    conversation: { counterpartyFirstName: 'Amara' },
  } as unknown as CaseSurfaceView;
}

const EXPERT_VIEW = {
  lens: 'expert',
  engagementId: ENGAGEMENT_ID,
  expertProfileId: PROFILE_ID,
  header: { isOpen: true },
  party: { profileHref: null },
  conversation: { counterpartyFirstName: 'Northwind Industrial' },
  earnings: { state: 'not_yet' },
} as unknown as CaseSurfaceView;

const READ: CallNowViewRead = {
  canCallNow: true,
  reason: null,
  calleeOnline: true,
  calleeTimeZone: null,
  inPlaceCandidate: { meetingId: 'm-1', scheduledStartIso: '2026-11-19T10:00:00.000Z' },
};

function read(over: Partial<CallNowViewRead> = {}): Promise<CallNowViewRead> {
  return Promise.resolve({ ...READ, ...over });
}

describe('readCallNowView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the parsed read on success', async () => {
    mockGetView.mockResolvedValue({ ok: true, data: READ });
    await expect(readCallNowView(ENGAGEMENT_ID)).resolves.toBe(READ);
    expect(mockGetView).toHaveBeenCalledWith(ENGAGEMENT_ID);
  });

  it('returns null and warns on an api failure, never throwing', async () => {
    mockGetView.mockResolvedValue({ ok: false, status: 503, code: 'request_failed' });
    await expect(readCallNowView(ENGAGEMENT_ID)).resolves.toBeNull();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'Call now view unavailable — entry hidden',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, status: 503 })
    );
  });

  it('degrades a hung read to null after the bound, leaving the caller free to carry on', async () => {
    vi.useFakeTimers();
    try {
      mockGetView.mockReturnValue(new Promise(() => undefined));
      const pending = readCallNowView(ENGAGEMENT_ID);
      await vi.advanceTimersByTimeAsync(2499);
      let settled = false;
      pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeNull();
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        'Call now view timed out — entry hidden',
        expect.objectContaining({ engagementId: ENGAGEMENT_ID, timeoutMs: 2500 })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leave its timer running once the read has answered', async () => {
    vi.useFakeTimers();
    try {
      mockGetView.mockResolvedValue({ ok: true, data: READ });
      await expect(readCallNowView(ENGAGEMENT_ID)).resolves.toBe(READ);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null and warns when the hop throws', async () => {
    mockGetView.mockRejectedValue(new Error('boom'));
    await expect(readCallNowView(ENGAGEMENT_ID)).resolves.toBeNull();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'Call now view read threw — entry hidden',
      expect.objectContaining({ error: 'boom' })
    );
  });
});

describe('loadCaseCallNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindRate.mockResolvedValue({ rateCents: 10000 });
  });

  it('is null when the read failed', async () => {
    await expect(
      loadCaseCallNow({ view: clientView(), read: Promise.resolve(null) })
    ).resolves.toBeNull();
  });

  it('is null when the viewer can not call and the api gave no reason', async () => {
    const result = await loadCaseCallNow({
      view: clientView(),
      read: read({ canCallNow: false, reason: null }),
    });
    expect(result).toBeNull();
  });

  it('builds the client button arm with the rate line, presence and booking facts', async () => {
    const result = await loadCaseCallNow({ view: clientView(), read: read() });

    expect(result).toEqual({
      entry: 'button',
      calleeLabel: 'Amara',
      onlineBadge: true,
      calleeTimeZone: null,
      confirm: {
        kind: 'client_terms',
        engagementId: ENGAGEMENT_ID,
        expertProfileId: PROFILE_ID,
        calleeOnline: true,
        rateLine: 'A$125.00/min · 15-minute minimum',
        inPlaceCandidate: READ.inPlaceCandidate,
        bookInPage: true,
      },
    });
    expect(mockFindRate).toHaveBeenCalledWith(PROFILE_ID);
  });

  it('has no rate line when the expert has no rate, or the read fails', async () => {
    mockFindRate.mockResolvedValueOnce({ rateCents: null });
    const none = await loadCaseCallNow({ view: clientView(), read: read() });
    expect(none?.confirm).toMatchObject({ rateLine: null });

    mockFindRate.mockRejectedValueOnce(new Error('db down'));
    const failed = await loadCaseCallNow({ view: clientView(), read: read() });
    expect(failed?.confirm).toMatchObject({ rateLine: null });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'Call now rate read failed — confirm shows no rate',
      expect.objectContaining({ error: 'db down' })
    );
  });

  it('turns bookInPage off for a closed case or an unlisted expert', async () => {
    const closed = await loadCaseCallNow({ view: clientView({ isOpen: false }), read: read() });
    expect(closed?.confirm).toMatchObject({ bookInPage: false });

    const unlisted = await loadCaseCallNow({
      view: clientView({ profileHref: null }),
      read: read(),
    });
    expect(unlisted?.confirm).toMatchObject({ bookInPage: false });
  });

  it('hides the online badge when the callee is offline', async () => {
    const result = await loadCaseCallNow({
      view: clientView(),
      read: read({ calleeOnline: false }),
    });
    expect(result?.onlineBadge).toBe(false);
  });

  it('builds the expert arm with no rate line key and no online badge', async () => {
    const result = await loadCaseCallNow({ view: EXPERT_VIEW, read: read() });

    expect(result).toEqual({
      entry: 'button',
      calleeLabel: 'Northwind Industrial',
      onlineBadge: false,
      calleeTimeZone: null,
      confirm: { kind: 'expert_notice', engagementId: ENGAGEMENT_ID },
    });
    expect(result?.confirm).not.toHaveProperty('rateLine');
    expect(mockFindRate).not.toHaveBeenCalled();
  });

  it('maps busy to a quiet line with no confirm and no rate read', async () => {
    const result = await loadCaseCallNow({
      view: clientView(),
      read: read({ canCallNow: false, reason: 'busy', calleeTimeZone: 'Australia/Sydney' }),
    });

    expect(result).toEqual({
      entry: 'busy',
      calleeLabel: 'Amara',
      onlineBadge: true,
      calleeTimeZone: null,
      confirm: null,
    });
    expect(mockFindRate).not.toHaveBeenCalled();
  });

  it('carries the callee zone only on outside_hours', async () => {
    const result = await loadCaseCallNow({
      view: clientView(),
      read: read({
        canCallNow: false,
        reason: 'outside_hours',
        calleeTimeZone: 'Australia/Sydney',
      }),
    });
    expect(result).toMatchObject({
      entry: 'outside_hours',
      calleeTimeZone: 'Australia/Sydney',
      confirm: null,
    });
  });
});
