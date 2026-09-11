import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';

const { mockRequireOnboardedUser, mockLoadLookupTimeline } = vi.hoisted(() => ({
  mockRequireOnboardedUser: vi.fn(),
  mockLoadLookupTimeline: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
vi.mock('../_lib/load-lookup-timeline', () => ({ loadLookupTimeline: mockLoadLookupTimeline }));

import { fetchLookupTimelineAction } from './fetch-lookup-timeline';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-x',
    email: 'x@example.com',
    firstName: 'X',
    lastName: 'Y',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'admin',
    companyId: 'company-1',
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

const VALID_ID = '3f9a1b2c-1234-4abc-89ab-1234567890ab';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchLookupTimelineAction', () => {
  it('calls requireOnboardedUser', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user());
    mockLoadLookupTimeline.mockResolvedValue({
      ok: true,
      entries: [],
      hasEarlier: false,
      earlier: null,
    });
    await fetchLookupTimelineAction({ type: 'company', id: VALID_ID });
    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
  });

  it('a non-staff viewer gets forbidden and the loader is never called', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user({ platformRole: 'user' }));
    const result = await fetchLookupTimelineAction({ type: 'company', id: VALID_ID });
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(mockLoadLookupTimeline).not.toHaveBeenCalled();
  });

  it('a bad uuid is not_found, without calling the loader', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user({ platformRole: 'admin' }));
    const result = await fetchLookupTimelineAction({ type: 'company', id: 'not-a-uuid' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(mockLoadLookupTimeline).not.toHaveBeenCalled();
  });

  it('a bad cursor is not_found, without calling the loader', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user({ platformRole: 'admin' }));
    const result = await fetchLookupTimelineAction({
      type: 'company',
      id: VALID_ID,
      before: { createdAtPrecise: 'not-a-date', seq: 1 },
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(mockLoadLookupTimeline).not.toHaveBeenCalled();
  });

  it('a STRICT ISO 8601 string (the OLD, now-wrong shape) is rejected as not_found', async () => {
    // BAL-555 fix round: `z.iso.datetime()` used to accept this and reject the real
    // Postgres-text cursor; the regex now does the opposite, on purpose.
    mockRequireOnboardedUser.mockResolvedValue(user({ platformRole: 'admin' }));
    const result = await fetchLookupTimelineAction({
      type: 'company',
      id: VALID_ID,
      before: { createdAtPrecise: '2026-06-02T10:15:30.000Z', seq: 1 },
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(mockLoadLookupTimeline).not.toHaveBeenCalled();
  });

  it('a type outside LOOKUP_ENTITY_TYPES is not_found — the security gate (C7)', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user({ platformRole: 'admin' }));
    const result = await fetchLookupTimelineAction({ type: 'internal_note', id: VALID_ID });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(mockLoadLookupTimeline).not.toHaveBeenCalled();
  });

  it('a staff viewer with valid input delegates to the loader', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user({ platformRole: 'admin' }));
    mockLoadLookupTimeline.mockResolvedValue({
      ok: true,
      entries: [
        { id: 'r1', action: 'agency.created', summary: 'Agency created', occurredAtIso: 'x' },
      ],
      hasEarlier: false,
      earlier: null,
    });

    const result = await fetchLookupTimelineAction({ type: 'agency', id: VALID_ID });

    expect(mockLoadLookupTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ platformRole: 'admin' }),
      { type: 'agency', id: VALID_ID }
    );
    expect(result).toEqual({
      ok: true,
      entries: [
        { id: 'r1', action: 'agency.created', summary: 'Agency created', occurredAtIso: 'x' },
      ],
      hasEarlier: false,
      earlier: null,
    });
  });

  it('forwards a valid (full-precision Postgres-text) cursor to the loader', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user({ platformRole: 'admin' }));
    mockLoadLookupTimeline.mockResolvedValue({
      ok: true,
      entries: [],
      hasEarlier: false,
      earlier: null,
    });

    await fetchLookupTimelineAction({
      type: 'agency',
      id: VALID_ID,
      before: { createdAtPrecise: '2026-06-02 10:15:30.083951+00', seq: 42 },
    });

    expect(mockLoadLookupTimeline).toHaveBeenCalledWith(expect.anything(), {
      type: 'agency',
      id: VALID_ID,
      before: { createdAtPrecise: '2026-06-02 10:15:30.083951+00', seq: 42 },
    });
  });

  it('accepts a cursor with no fractional-second component (whole-second precision is legal)', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user({ platformRole: 'admin' }));
    mockLoadLookupTimeline.mockResolvedValue({
      ok: true,
      entries: [],
      hasEarlier: false,
      earlier: null,
    });

    await fetchLookupTimelineAction({
      type: 'agency',
      id: VALID_ID,
      before: { createdAtPrecise: '2026-06-02 10:15:30+00', seq: 1 },
    });

    expect(mockLoadLookupTimeline).toHaveBeenCalledWith(expect.anything(), {
      type: 'agency',
      id: VALID_ID,
      before: { createdAtPrecise: '2026-06-02 10:15:30+00', seq: 1 },
    });
  });

  it('a thrown loader error resolves unavailable and calls log.error (never the metadata or a query string)', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user({ platformRole: 'admin' }));
    mockLoadLookupTimeline.mockRejectedValue(new Error('boom'));

    const result = await fetchLookupTimelineAction({ type: 'agency', id: VALID_ID });

    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(log.error).toHaveBeenCalledWith(
      'Admin lookup timeline fetch failed',
      expect.objectContaining({ userId: 'user-x', entityType: 'agency', entityId: VALID_ID })
    );
  });

  it('propagates an unauthenticated requireOnboardedUser rejection', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    await expect(fetchLookupTimelineAction({ type: 'agency', id: VALID_ID })).rejects.toThrow(
      'Unauthorized'
    );
    expect(mockLoadLookupTimeline).not.toHaveBeenCalled();
  });
});
