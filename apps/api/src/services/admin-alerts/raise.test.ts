import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRepositoryRaise, mockLog } = vi.hoisted(() => ({
  mockRepositoryRaise: vi.fn(),
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/shared/logging', () => ({ createLogger: () => mockLog }));
vi.mock('@balo/db', () => ({
  adminAlertsRepository: { raise: mockRepositoryRaise },
}));

import { raiseAdminAlert } from './raise.js';

const INPUT = {
  kind: 'session.open_refused',
  entityType: 'meeting',
  entityId: 'meeting_1',
  detail: {
    title: 't',
    entityLabel: 'e',
    evidence: 'ev',
    facts: [] as (readonly [string, string])[],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('raiseAdminAlert', () => {
  it('calls adminAlertsRepository.raise with the input unchanged', async () => {
    mockRepositoryRaise.mockResolvedValue({ id: 'alert_1' });
    await raiseAdminAlert(INPUT);
    expect(mockRepositoryRaise).toHaveBeenCalledWith(INPUT);
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('swallows a repository failure — NEVER throws', async () => {
    mockRepositoryRaise.mockRejectedValue(new Error('db down'));
    await expect(raiseAdminAlert(INPUT)).resolves.toBeUndefined();
  });

  it('logs the failure with the kind/entity identifiers, on its own error line', async () => {
    mockRepositoryRaise.mockRejectedValue(new Error('db down'));
    await raiseAdminAlert(INPUT);
    expect(mockLog.error).toHaveBeenCalledTimes(1);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'session.open_refused',
        entityType: 'meeting',
        entityId: 'meeting_1',
        error: 'db down',
      }),
      expect.stringContaining('Failed to raise an admin alert')
    );
  });

  it('a non-Error rejection is stringified, not thrown', async () => {
    mockRepositoryRaise.mockRejectedValue('a string rejection');
    await expect(raiseAdminAlert(INPUT)).resolves.toBeUndefined();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'a string rejection' }),
      expect.any(String)
    );
  });
});
