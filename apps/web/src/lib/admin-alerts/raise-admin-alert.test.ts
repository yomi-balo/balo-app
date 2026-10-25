import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockRaise } = vi.hoisted(() => ({ mockRaise: vi.fn() }));
vi.mock('@balo/db', () => ({
  adminAlertsRepository: { raise: (...a: unknown[]) => mockRaise(...a) },
}));

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));
vi.mock('@/lib/logging', () => ({ log: { error: (...a: unknown[]) => mockLogError(...a) } }));

import { raiseAdminAlert } from './raise-admin-alert';

const INPUT = {
  kind: 'project.repeat_change_request',
  entityType: 'engagement',
  entityId: 'e-1',
  detail: { title: 't', entityLabel: 'l', evidence: 'e', facts: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('raiseAdminAlert', () => {
  it('forwards the input to the repository', async () => {
    mockRaise.mockResolvedValue(undefined);
    await raiseAdminAlert(INPUT);
    expect(mockRaise).toHaveBeenCalledWith(INPUT);
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('swallows a repository failure and logs it with the alert identity', async () => {
    mockRaise.mockRejectedValue(new Error('db down'));
    await expect(raiseAdminAlert(INPUT)).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to raise an admin alert',
      expect.objectContaining({
        kind: 'project.repeat_change_request',
        entityType: 'engagement',
        entityId: 'e-1',
        error: 'db down',
      })
    );
  });

  it('stringifies a non-Error rejection', async () => {
    mockRaise.mockRejectedValue('boom');
    await raiseAdminAlert(INPUT);
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to raise an admin alert',
      expect.objectContaining({ error: 'boom', stack: undefined })
    );
  });
});
