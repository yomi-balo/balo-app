import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockPublish, mockChannelsGet, MockRest } = vi.hoisted(() => {
  const mockPublish = vi.fn();
  const mockChannelsGet = vi.fn(() => ({ publish: mockPublish }));
  class MockRest {
    channels = { get: mockChannelsGet };
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
  }
  return { mockPublish, mockChannelsGet, MockRest };
});

vi.mock('ably', () => ({ Rest: MockRest }));

import { log } from '@/lib/logging';

describe('ably-server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.ABLY_API_KEY;
  });

  afterEach(() => {
    delete process.env.ABLY_API_KEY;
  });

  it('isRealtimeConfigured reflects ABLY_API_KEY presence', async () => {
    const unconfigured = await import('./ably-server');
    expect(unconfigured.isRealtimeConfigured()).toBe(false);

    process.env.ABLY_API_KEY = 'app.key:secret';
    expect(unconfigured.isRealtimeConfigured()).toBe(true);
  });

  it('getAblyRest returns null when unconfigured', async () => {
    const { getAblyRest } = await import('./ably-server');
    expect(getAblyRest()).toBeNull();
  });

  it('getAblyRest lazily creates a singleton when configured', async () => {
    process.env.ABLY_API_KEY = 'app.key:secret';
    const { getAblyRest } = await import('./ably-server');
    const first = getAblyRest();
    expect(first).toBeInstanceOf(MockRest);
    expect(getAblyRest()).toBe(first);
  });

  it('publishConversationEvent no-ops with a single warn when unconfigured', async () => {
    const { publishConversationEvent } = await import('./ably-server');
    await publishConversationEvent('rel-1', 'message', { id: 'm-1' });
    expect(mockChannelsGet).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Realtime disabled (no ABLY_API_KEY) — skipping publish',
      expect.objectContaining({ channel: 'conversation:rel-1', name: 'message' })
    );
  });

  it('publishes to the conversation channel when configured', async () => {
    process.env.ABLY_API_KEY = 'app.key:secret';
    mockPublish.mockResolvedValue(undefined);
    const { publishConversationEvent } = await import('./ably-server');
    await publishConversationEvent('rel-1', 'file', { id: 'f-1' });
    expect(mockChannelsGet).toHaveBeenCalledWith('conversation:rel-1');
    expect(mockPublish).toHaveBeenCalledWith('file', { id: 'f-1' });
  });

  it('catches and logs publish failures without throwing', async () => {
    process.env.ABLY_API_KEY = 'app.key:secret';
    mockPublish.mockRejectedValue(new Error('socket down'));
    const { publishConversationEvent } = await import('./ably-server');
    await expect(
      publishConversationEvent('rel-1', 'message', { id: 'm-1' })
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      'Ably publish failed',
      expect.objectContaining({ channel: 'conversation:rel-1', error: 'socket down' })
    );
  });
});
