import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAdd = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/queue.js', () => ({
  getQueue: vi.fn(() => ({ add: mockAdd })),
}));

import { notificationEvents } from './publisher.js';
import { getQueue } from '../lib/queue.js';

describe('notificationEvents.publish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes user.welcome event with correct job name, data, and jobId', async () => {
    const payload = {
      correlationId: 'user-123',
      userId: 'user-123',
    };

    await notificationEvents.publish('user.welcome', payload);

    expect(getQueue).toHaveBeenCalledWith('notification-events');
    expect(mockAdd).toHaveBeenCalledWith(
      'user.welcome',
      expect.objectContaining({
        event: 'user.welcome',
        payload,
        publishedAt: expect.any(String),
      }),
      expect.objectContaining({
        jobId: 'user.welcome:user-123',
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      })
    );
  });

  it('publishes expert.application_submitted event with correct jobId format', async () => {
    const payload = {
      correlationId: 'app-456',
      userId: 'user-789',
      applicationId: 'app-456',
    };

    await notificationEvents.publish('expert.application_submitted', payload);

    expect(mockAdd).toHaveBeenCalledWith(
      'expert.application_submitted',
      expect.objectContaining({
        event: 'expert.application_submitted',
        payload,
      }),
      expect.objectContaining({
        jobId: 'expert.application_submitted:app-456',
      })
    );
  });

  it('includes ISO timestamp in publishedAt', async () => {
    const before = new Date().toISOString();

    await notificationEvents.publish('user.welcome', {
      correlationId: 'user-1',
      userId: 'user-1',
    });

    const after = new Date().toISOString();
    const publishedAt = mockAdd.mock.calls[0][1].publishedAt;

    expect(publishedAt >= before).toBe(true);
    expect(publishedAt <= after).toBe(true);
  });
});
