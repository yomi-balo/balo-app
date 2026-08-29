import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockSwitchWorkspace = vi.fn();
vi.mock('@/lib/workspaces/switch-workspace', () => ({
  switchWorkspace: (...args: unknown[]) => mockSwitchWorkspace(...args),
}));

const mockRevalidatePath = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));
vi.mock('@/lib/logging', () => ({ log: { error: mockLogError, warn: vi.fn(), info: vi.fn() } }));

import { switchWorkspaceAction } from './switch-workspace';

const USER = { id: 'user-1', onboardingCompleted: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(USER);
});

describe('switchWorkspaceAction', () => {
  it('returns a typed error and does NOT switch when unauthenticated/un-onboarded', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await switchWorkspaceAction('expert');
    expect(result).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockSwitchWorkspace).not.toHaveBeenCalled();
  });

  it('rejects an empty target key without calling the service', async () => {
    const result = await switchWorkspaceAction('');
    expect(result).toEqual({ success: false, error: 'Invalid workspace' });
    expect(mockSwitchWorkspace).not.toHaveBeenCalled();
  });

  it('rejects an oversized target key without calling the service', async () => {
    const result = await switchWorkspaceAction('x'.repeat(65));
    expect(result).toEqual({ success: false, error: 'Invalid workspace' });
    expect(mockSwitchWorkspace).not.toHaveBeenCalled();
  });

  it('delegates with trigger:"switcher" and revalidates on success', async () => {
    const workspace = { type: 'expert' as const, key: 'expert' };
    mockSwitchWorkspace.mockResolvedValue({ ok: true, workspace, changed: true });

    const result = await switchWorkspaceAction('expert');

    expect(mockSwitchWorkspace).toHaveBeenCalledWith(USER, 'expert', 'switcher');
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout');
    expect(result).toEqual({ success: true, data: { workspace } });
  });

  it('returns a typed error when the service rejects the target', async () => {
    mockSwitchWorkspace.mockResolvedValue({ ok: false, reason: 'not_eligible' });
    const result = await switchWorkspaceAction('company:00000000-0000-4000-8000-000000000000');
    expect(result).toEqual({
      success: false,
      error: 'Could not switch workspace. Please try again.',
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it('returns a typed error and logs when the service throws', async () => {
    mockSwitchWorkspace.mockRejectedValue(new Error('db down'));
    const result = await switchWorkspaceAction('expert');
    expect(result).toEqual({
      success: false,
      error: 'Could not switch workspace. Please try again.',
    });
    expect(mockLogError).toHaveBeenCalledWith(
      'Workspace switch failed',
      expect.objectContaining({ userId: 'user-1' })
    );
  });
});
