import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockPublish, mockChannelsGet, MockRest, runAfterResponseMock, getScheduled } = vi.hoisted(
  () => {
    const mockPublish = vi.fn();
    const mockChannelsGet = vi.fn(() => ({ publish: mockPublish }));
    class MockRest {
      static instances: MockRest[] = [];
      channels = { get: mockChannelsGet };
      options: unknown;
      constructor(options: unknown) {
        this.options = options;
        MockRest.instances.push(this);
      }
    }
    // Capture the deferred work so each test can run it explicitly — the real
    // runAfterResponse hands it to Next's after() (BAL-279).
    let scheduled: (() => Promise<void>) | null = null;
    const runAfterResponseMock = vi.fn((_label: string, work: () => Promise<void>) => {
      scheduled = work;
    });
    return {
      mockPublish,
      mockChannelsGet,
      MockRest,
      runAfterResponseMock,
      getScheduled: (): (() => Promise<void>) | null => scheduled,
    };
  }
);

vi.mock('ably', () => ({ Rest: MockRest }));
vi.mock('@/lib/after-response', () => ({ runAfterResponse: runAfterResponseMock }));

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

  it('defers the publish via runAfterResponse rather than publishing inline', async () => {
    process.env.ABLY_API_KEY = 'app.key:secret';
    const { publishConversationEvent } = await import('./ably-server');
    publishConversationEvent('conv-1', 'file', { id: 'f-1' });

    expect(runAfterResponseMock).toHaveBeenCalledWith('Ably publish', expect.any(Function));
    expect(mockChannelsGet).not.toHaveBeenCalled();
  });

  it('the deferred work no-ops with a single warn when unconfigured', async () => {
    const { publishConversationEvent } = await import('./ably-server');
    publishConversationEvent('conv-1', 'message', { id: 'm-1' });
    await getScheduled()?.();

    expect(mockChannelsGet).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Realtime disabled (no ABLY_API_KEY) — skipping publish',
      expect.objectContaining({ channel: 'conversation:conv-1', name: 'message' })
    );
  });

  it('the deferred work publishes to the conversation channel when configured', async () => {
    process.env.ABLY_API_KEY = 'app.key:secret';
    mockPublish.mockResolvedValue(undefined);
    const { publishConversationEvent } = await import('./ably-server');
    publishConversationEvent('conv-1', 'file', { id: 'f-1' });
    await getScheduled()?.();

    expect(mockChannelsGet).toHaveBeenCalledWith('conversation:conv-1');
    expect(mockPublish).toHaveBeenCalledWith('file', { id: 'f-1' });
  });

  it('the deferred work catches and logs publish failures without throwing', async () => {
    process.env.ABLY_API_KEY = 'app.key:secret';
    mockPublish.mockRejectedValue(new Error('socket down'));
    const { publishConversationEvent } = await import('./ably-server');
    publishConversationEvent('conv-1', 'message', { id: 'm-1' });

    await expect(getScheduled()?.()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      'Ably publish failed',
      expect.objectContaining({ channel: 'conversation:conv-1', error: 'socket down' })
    );
  });

  describe('publishTypingSignal — the only writer of a typing channel', () => {
    it.each([
      ['started', 'typing.started'],
      ['stopped', 'typing.stopped'],
    ] as const)(
      '⚠⚠ publishes `%s` on typing:{id} as EXACTLY { name, clientId, extras.ephemeral } — no data',
      async (signal, wireName) => {
        process.env.ABLY_API_KEY = 'app.key:secret';
        mockPublish.mockResolvedValue(undefined);
        const { publishTypingSignal } = await import('./ably-server');

        await publishTypingSignal('conv-1', 'user-1', signal);

        expect(mockChannelsGet).toHaveBeenCalledWith('typing:conv-1');
        expect(mockPublish).toHaveBeenCalledTimes(1);
        const [call] = mockPublish.mock.calls;
        const [message] = call ?? [];
        expect(message).toStrictEqual({
          name: wireName,
          clientId: 'user-1',
          extras: { ephemeral: true },
        });
        expect(message).not.toHaveProperty('data');
      }
    );

    it('⚠⚠ is AWAITED, not deferred — it resolves only after the publish settles', async () => {
      process.env.ABLY_API_KEY = 'app.key:secret';
      let settle: () => void = () => undefined;
      mockPublish.mockReturnValue(
        new Promise<void>((resolve) => {
          settle = resolve;
        })
      );
      const { publishTypingSignal } = await import('./ably-server');

      let resolved = false;
      const pending = publishTypingSignal('conv-1', 'user-1', 'started').then(() => {
        resolved = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(runAfterResponseMock).not.toHaveBeenCalled();

      settle();
      await pending;
      expect(resolved).toBe(true);
    });

    it('THROWS a failed publish to the caller, which owns the log line', async () => {
      process.env.ABLY_API_KEY = 'app.key:secret';
      mockPublish.mockRejectedValue(new Error('ably down'));
      const { publishTypingSignal } = await import('./ably-server');

      await expect(publishTypingSignal('conv-1', 'user-1', 'stopped')).rejects.toThrow('ably down');
    });

    it('is a no-op when realtime is unconfigured — nobody can be subscribed', async () => {
      const { publishTypingSignal } = await import('./ably-server');

      await publishTypingSignal('conv-1', 'user-1', 'started');

      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('⚠ publishes through its OWN REST client — one attempt, a 1.5 s budget, never the defaults', async () => {
      process.env.ABLY_API_KEY = 'app.key:secret';
      mockPublish.mockResolvedValue(undefined);
      const { publishTypingSignal, getAblyRest, TYPING_PUBLISH_TIMEOUT_MS } =
        await import('./ably-server');

      await publishTypingSignal('conv-1', 'user-1', 'started');
      const shared = getAblyRest() as unknown as { options: unknown };

      expect(TYPING_PUBLISH_TIMEOUT_MS).toBe(1_500);
      const constructed = MockRest.instances.map((instance) => instance.options);
      expect(constructed).toContainEqual({
        key: 'app.key:secret',
        httpRequestTimeout: TYPING_PUBLISH_TIMEOUT_MS,
        httpMaxRetryCount: 0,
      });
      // The shared client — which every durable publish uses — keeps Ably's defaults.
      expect(shared.options).toEqual({ key: 'app.key:secret' });
    });
  });
});
