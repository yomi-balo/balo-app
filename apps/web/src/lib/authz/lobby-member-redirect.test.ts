import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  authorize: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('./meeting-participation', () => ({ authorizeMeetingParticipation: mocks.authorize }));
vi.mock('@/lib/logging', () => ({ log: { warn: mocks.warn } }));

import { resolveLobbyMemberRedirect } from './lobby-member-redirect';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveLobbyMemberRedirect', () => {
  it('sends a participant to the member call route', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.authorize.mockResolvedValue({ ok: true, side: 'client' });

    await expect(resolveLobbyMemberRedirect(MEETING_ID)).resolves.toBe(
      `/meetings/${MEETING_ID}/call`
    );
    expect(mocks.authorize).toHaveBeenCalledWith({ meetingId: MEETING_ID, userId: 'user-1' });
  });

  it('returns null for an anonymous visitor without any participation read', async () => {
    mocks.getCurrentUser.mockResolvedValue(null);

    await expect(resolveLobbyMemberRedirect(MEETING_ID)).resolves.toBeNull();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it('returns null for a signed-in non-participant', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-2' });
    mocks.authorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    await expect(resolveLobbyMemberRedirect(MEETING_ID)).resolves.toBeNull();
  });

  it('returns null and warns when the check throws', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.authorize.mockRejectedValue(new Error('db down'));

    await expect(resolveLobbyMemberRedirect(MEETING_ID)).resolves.toBeNull();
    expect(mocks.warn).toHaveBeenCalledWith(
      'Lobby member redirect check failed — showing the lobby',
      expect.objectContaining({ meetingId: MEETING_ID, error: 'db down' })
    );
  });
});
