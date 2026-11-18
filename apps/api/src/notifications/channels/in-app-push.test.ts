import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLog, mockGetAblyRest, mockPublish, mockChannelsGet } = vi.hoisted(() => ({
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockGetAblyRest: vi.fn(),
  mockPublish: vi.fn(),
  mockChannelsGet: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: vi.fn(() => mockLog),
}));

vi.mock('../../lib/ably.js', () => ({
  getAblyRest: () => mockGetAblyRest(),
}));

import { publishNotificationCreated } from './in-app-push.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockPublish.mockResolvedValue(undefined);
  mockChannelsGet.mockReturnValue({ publish: mockPublish });
  mockGetAblyRest.mockReturnValue({ channels: { get: mockChannelsGet } });
});

describe('publishNotificationCreated', () => {
  it('publishes a content-free ephemeral ping on the recipient channel', async () => {
    await publishNotificationCreated('user-1');

    // The channel and event names are restated as LITERALS: sharing the builders with
    // production would let a rename pass while orphaning every live subscriber.
    expect(mockChannelsGet).toHaveBeenCalledWith('notifications:user-1');
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith({
      name: 'notification.created',
      extras: { ephemeral: true },
    });
  });

  it('publishes no data and no clientId', async () => {
    await publishNotificationCreated('user-1');

    const [message] = mockPublish.mock.calls[0] as [Record<string, unknown>];
    expect(message).not.toHaveProperty('data');
    expect(message).not.toHaveProperty('clientId');
  });

  it('skips with a debug log and publishes nothing when no Ably key is configured', async () => {
    mockGetAblyRest.mockReturnValue(null);

    await expect(publishNotificationCreated('user-1')).resolves.toBeUndefined();

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockLog.debug).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('resolves and warns once when the publish rejects', async () => {
    mockPublish.mockRejectedValue(new Error('ably 500'));

    await expect(publishNotificationCreated('user-1')).resolves.toBeUndefined();

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 'user-1', error: 'ably 500' }),
      'Notification push failed'
    );
  });

  it('resolves and warns once when the publish times out', async () => {
    mockPublish.mockRejectedValue(new Error('Request timed out'));

    await expect(publishNotificationCreated('user-1')).resolves.toBeUndefined();

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });

  it('resolves and warns when a non-Error value is thrown', async () => {
    mockPublish.mockRejectedValue('boom');

    await expect(publishNotificationCreated('user-1')).resolves.toBeUndefined();

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'boom', stack: undefined }),
      'Notification push failed'
    );
  });

  it('resolves when building the client itself throws', async () => {
    mockGetAblyRest.mockImplementation(() => {
      throw new Error('bad key');
    });

    await expect(publishNotificationCreated('user-1')).resolves.toBeUndefined();

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });
});
