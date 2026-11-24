import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';

const { mockRequireOnboardedUser, mockLoadLookupFollowUps } = vi.hoisted(() => ({
  mockRequireOnboardedUser: vi.fn(),
  mockLoadLookupFollowUps: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
vi.mock('../_lib/load-lookup-follow-ups', () => ({
  loadLookupFollowUps: mockLoadLookupFollowUps,
}));

import { fetchLookupFollowUpsAction } from './fetch-lookup-follow-ups';

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
const EMPTY_VIEW = {
  lens: 'person',
  subjectFirstName: null,
  origin: null,
  engagementWithoutRequest: false,
  limit: null,
  now: [],
  earlier: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchLookupFollowUpsAction', () => {
  it('calls requireOnboardedUser', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user());
    mockLoadLookupFollowUps.mockResolvedValue({ ok: true, view: EMPTY_VIEW });
    await fetchLookupFollowUpsAction({ type: 'user', id: VALID_ID });
    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
  });

  it('an actor without VIEW_PLATFORM_ADMIN gets forbidden and the loader is never called (AC1)', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user({ platformRole: 'user' }));
    const result = await fetchLookupFollowUpsAction({ type: 'user', id: VALID_ID });
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(mockLoadLookupFollowUps).not.toHaveBeenCalled();
  });

  it('a bad uuid is not_found, without calling the loader', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user());
    const result = await fetchLookupFollowUpsAction({ type: 'user', id: 'not-a-uuid' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(mockLoadLookupFollowUps).not.toHaveBeenCalled();
  });

  it.each(['company', 'agency', 'credit_session', 'internal_note'])(
    'a type with no Follow-ups tab (%s) is not_found — the security gate',
    async (type) => {
      mockRequireOnboardedUser.mockResolvedValue(user());
      const result = await fetchLookupFollowUpsAction({ type, id: VALID_ID });
      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(mockLoadLookupFollowUps).not.toHaveBeenCalled();
    }
  );

  it.each(['user', 'expert', 'project_request', 'engagement'])(
    'delegates a valid %s to the loader',
    async (type) => {
      mockRequireOnboardedUser.mockResolvedValue(user());
      mockLoadLookupFollowUps.mockResolvedValue({ ok: true, view: EMPTY_VIEW });
      const result = await fetchLookupFollowUpsAction({ type, id: VALID_ID });
      expect(mockLoadLookupFollowUps).toHaveBeenCalledWith(
        expect.objectContaining({ platformRole: 'admin' }),
        { type, id: VALID_ID }
      );
      expect(result).toEqual({ ok: true, view: EMPTY_VIEW });
    }
  );

  it('logs and returns unavailable when the loader throws', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user());
    mockLoadLookupFollowUps.mockRejectedValue(new Error('db down'));
    const result = await fetchLookupFollowUpsAction({ type: 'user', id: VALID_ID });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(log.error).toHaveBeenCalledWith(
      'Admin lookup follow-ups fetch failed',
      expect.objectContaining({
        userId: 'user-x',
        entityType: 'user',
        entityId: VALID_ID,
        error: 'db down',
      })
    );
  });

  it('logs a non-Error throw as its string form', async () => {
    mockRequireOnboardedUser.mockResolvedValue(user());
    mockLoadLookupFollowUps.mockRejectedValue('boom');
    await fetchLookupFollowUpsAction({ type: 'user', id: VALID_ID });
    expect(log.error).toHaveBeenCalledWith(
      'Admin lookup follow-ups fetch failed',
      expect.objectContaining({ error: 'boom', stack: undefined })
    );
  });
});
