import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  markRead: vi.fn(),
  findRing: vi.fn(),
  publishRead: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  userNotificationsRepository: { markCallRingingReadByRingId: mocks.markRead },
  meetingRingsRepository: { findById: mocks.findRing },
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: vi.fn(),
  }),
}));
vi.mock('./in-app-push.js', () => ({ publishNotificationRead: mocks.publishRead }));

import { reconcileCallRingingRow, retractCallRingingRow } from './call-ringing-row.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.markRead.mockResolvedValue(['row-1']);
  mocks.publishRead.mockResolvedValue(undefined);
});

describe('retractCallRingingRow', () => {
  const payload = { ringId: 'ring-1', calleeUserId: 'callee-1' };

  it('marks the callee’s ringing rows read, pings their tabs and logs the retraction', async () => {
    await retractCallRingingRow(payload);

    expect(mocks.markRead).toHaveBeenCalledWith('callee-1', 'ring-1');
    expect(mocks.publishRead).toHaveBeenCalledWith('callee-1');
    expect(mocks.logInfo).toHaveBeenCalledWith(
      { ringId: 'ring-1', count: 1 },
      'Ringing notification retracted'
    );
  });

  it('pings nothing when no row changed', async () => {
    mocks.markRead.mockResolvedValue([]);

    await retractCallRingingRow(payload);

    expect(mocks.publishRead).not.toHaveBeenCalled();
    expect(mocks.logInfo).not.toHaveBeenCalled();
  });

  it.each([{ ringId: 'ring-1' }, { calleeUserId: 'callee-1' }, { ringId: 5, calleeUserId: 'c' }])(
    'skips a payload without both ids (%j)',
    async (bad) => {
      await retractCallRingingRow(bad);

      expect(mocks.markRead).not.toHaveBeenCalled();
      expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    }
  );

  it('swallows and warns when the update throws', async () => {
    mocks.markRead.mockRejectedValue(new Error('db down'));

    await expect(retractCallRingingRow(payload)).resolves.toBeUndefined();

    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ ringId: 'ring-1', error: 'db down' }),
      'Ringing notification retraction failed'
    );
  });
});

describe('reconcileCallRingingRow', () => {
  const input = { ringId: 'ring-1', recipientId: 'callee-1' };

  it('leaves the row alone while the ring is still ringing', async () => {
    mocks.findRing.mockResolvedValue({ id: 'ring-1', status: 'ringing' });

    await reconcileCallRingingRow(input);

    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(mocks.publishRead).not.toHaveBeenCalled();
  });

  it.each(['connected', 'unanswered', 'declined', 'stopped'])(
    'retracts the row of a ring that already ended %s',
    async (status) => {
      mocks.findRing.mockResolvedValue({ id: 'ring-1', status });

      await reconcileCallRingingRow(input);

      expect(mocks.markRead).toHaveBeenCalledWith('callee-1', 'ring-1');
      expect(mocks.publishRead).toHaveBeenCalledWith('callee-1');
    }
  );

  it('retracts when the ring row is gone', async () => {
    mocks.findRing.mockResolvedValue(undefined);

    await reconcileCallRingingRow(input);

    expect(mocks.markRead).toHaveBeenCalledWith('callee-1', 'ring-1');
  });

  it('does nothing for a non-string ring id', async () => {
    await reconcileCallRingingRow({ ringId: undefined, recipientId: 'callee-1' });

    expect(mocks.findRing).not.toHaveBeenCalled();
  });

  it('swallows and warns when the read throws', async () => {
    mocks.findRing.mockRejectedValue(new Error('db down'));

    await expect(reconcileCallRingingRow(input)).resolves.toBeUndefined();

    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'db down' }),
      'Ringing notification reconcile failed'
    );
  });
});
