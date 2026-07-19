import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockAuthorize, mockFindUser, mockPublishTopupNudge } = vi.hoisted(() => ({
  mockAuthorize: vi.fn(),
  mockFindUser: vi.fn(),
  mockPublishTopupNudge: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  usersRepository: { findById: mockFindUser },
}));
vi.mock('./authorize-session-actor.js', () => ({ authorizeSessionActor: mockAuthorize }));
vi.mock('./notify.js', () => ({ publishTopupNudge: mockPublishTopupNudge }));

import { nudgeAdminForTopup } from './nudge.js';

const SESSION = { id: 'session_1', companyId: 'company_1' };

describe('nudgeAdminForTopup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorize.mockResolvedValue({ ok: true, session: SESSION, role: 'member' });
    mockFindUser.mockResolvedValue({ firstName: 'Dana', lastName: 'Okafor' });
  });

  it('authorizes with CONSUME_CREDITS then publishes the nudge with the requester name', async () => {
    const res = await nudgeAdminForTopup('session_1', 'user_1');
    expect(mockAuthorize).toHaveBeenCalledWith({
      sessionId: 'session_1',
      userId: 'user_1',
      requireCapability: 'consume_credits',
    });
    expect(mockPublishTopupNudge).toHaveBeenCalledWith(
      SESSION,
      'user_1',
      'Dana Okafor',
      expect.any(Number)
    );
    expect(res).toEqual({ ok: true });
  });

  it('falls back to "A teammate" when the user has no name', async () => {
    mockFindUser.mockResolvedValue({ firstName: null, lastName: null });
    await nudgeAdminForTopup('session_1', 'user_1');
    expect(mockPublishTopupNudge).toHaveBeenCalledWith(
      SESSION,
      'user_1',
      'A teammate',
      expect.any(Number)
    );
  });

  it('returns not_found (without publishing) when the session is gone', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'not_found' });
    const res = await nudgeAdminForTopup('missing', 'user_1');
    expect(res).toEqual({ ok: false, code: 'not_found' });
    expect(mockPublishTopupNudge).not.toHaveBeenCalled();
  });

  it('returns forbidden (without publishing) for a non-member actor (cross-tenant IDOR)', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'forbidden' });
    const res = await nudgeAdminForTopup('session_1', 'stranger');
    expect(res).toEqual({ ok: false, code: 'forbidden' });
    expect(mockPublishTopupNudge).not.toHaveBeenCalled();
  });
});
