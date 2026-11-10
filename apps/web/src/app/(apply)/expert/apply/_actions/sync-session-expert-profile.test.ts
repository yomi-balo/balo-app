import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthenticatedSession } from '@/lib/auth/with-auth';

vi.mock('server-only', () => ({}));

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  log: { warn: mockWarn, info: vi.fn(), error: vi.fn() },
}));

import { syncSessionExpertProfileId } from './sync-session-expert-profile';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

function makeSession(expertProfileId?: string): {
  session: AuthenticatedSession;
  save: ReturnType<typeof vi.fn>;
} {
  const save = vi.fn().mockResolvedValue(undefined);
  const session = {
    user: { id: 'user-1', expertProfileId },
    save,
  } as unknown as AuthenticatedSession;
  return { session, save };
}

describe('syncSessionExpertProfileId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not save when the session already holds the id', async () => {
    const { session, save } = makeSession(PROFILE_ID);
    await syncSessionExpertProfileId(session, PROFILE_ID);
    expect(save).not.toHaveBeenCalled();
  });

  it('patches an absent id and saves once', async () => {
    const { session, save } = makeSession();
    await syncSessionExpertProfileId(session, PROFILE_ID);
    expect(session.user.expertProfileId).toBe(PROFILE_ID);
    expect(save).toHaveBeenCalledOnce();
  });

  it('patches a different id and saves once', async () => {
    const { session, save } = makeSession('other-id');
    await syncSessionExpertProfileId(session, PROFILE_ID);
    expect(session.user.expertProfileId).toBe(PROFILE_ID);
    expect(save).toHaveBeenCalledOnce();
  });

  it('resolves and warns when save rejects', async () => {
    const { session, save } = makeSession();
    save.mockRejectedValue(new Error('cookie write failed'));
    await expect(syncSessionExpertProfileId(session, PROFILE_ID)).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ userId: 'user-1', expertProfileId: PROFILE_ID })
    );
  });
});
