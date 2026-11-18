import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

type Listener = () => void;

const { fake, MockRealtime } = vi.hoisted(() => {
  class Emitter {
    listeners = new Map<string, Listener[]>();
    on(event: string, listener: Listener): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) listener();
    }
  }
  class MockChannel extends Emitter {
    subscriptions: { event: string; handler: Listener }[] = [];
    subscribe(event: string, handler: Listener): Promise<void> {
      this.subscriptions.push({ event, handler });
      return fake.subscribeRejects ? Promise.reject(new Error('attach failed')) : Promise.resolve();
    }
  }
  class MockRealtime {
    connection = new Emitter();
    channel = new MockChannel();
    requestedChannels: string[] = [];
    closed = 0;
    options: {
      authCallback: (params: object, callback: (error: unknown, token: unknown) => void) => void;
    };
    channels = {
      get: (name: string): MockChannel => {
        this.requestedChannels.push(name);
        return this.channel;
      },
    };
    constructor(options: MockRealtime['options']) {
      this.options = options;
      fake.instances.push(this);
    }
    close(): void {
      this.closed += 1;
    }
    goLive(): void {
      this.connection.emit('connected');
      this.channel.emit('attached');
    }
  }
  const fake = { instances: [] as MockRealtime[], subscribeRejects: false };
  return { fake, MockRealtime };
});

vi.mock('ably', () => ({ Realtime: MockRealtime }));

const mockTokenAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/notifications/actions/create-notifications-realtime-token', () => ({
  createNotificationsRealtimeTokenAction: mockTokenAction,
}));

import { useNotificationPush } from './use-notification-push';

const TOKEN_REQUEST = { keyName: 'k', nonce: 'n', mac: 'm' };

async function mount(userId: string | null, onCreated: () => void = vi.fn()) {
  const hook = renderHook(
    ({ id }: { id: string | null }) => useNotificationPush({ userId: id, onCreated }),
    { initialProps: { id: userId } }
  );
  if (userId !== null) await waitFor(() => expect(fake.instances.length).toBeGreaterThan(0));
  return hook;
}

function client(): InstanceType<typeof MockRealtime> {
  const [instance] = fake.instances;
  if (instance === undefined) throw new Error('No realtime client was created');
  return instance;
}

describe('useNotificationPush', () => {
  beforeEach(() => {
    fake.instances.length = 0;
    fake.subscribeRejects = false;
    mockTokenAction.mockReset();
    mockTokenAction.mockResolvedValue({ success: true, tokenRequest: TOKEN_REQUEST });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates no client and is not live without a user id', async () => {
    const { result } = await mount(null);

    expect(fake.instances).toHaveLength(0);
    expect(result.current.pushLive).toBe(false);
  });

  it('subscribes to the user channel for the ping event only', async () => {
    await mount('u1');

    expect(client().requestedChannels).toEqual(['notifications:u1']);
    expect(client().channel.subscriptions.map((s) => s.event)).toEqual(['notification.created']);
  });

  it('is live only when the connection is connected AND the channel is attached', async () => {
    const { result } = await mount('u1');
    expect(result.current.pushLive).toBe(false);

    act(() => client().connection.emit('connected'));
    expect(result.current.pushLive).toBe(false);

    act(() => client().channel.emit('attached'));
    expect(result.current.pushLive).toBe(true);
  });

  it.each(['disconnected', 'suspended', 'failed', 'connecting'])(
    'is not live once the connection is %s',
    async (state) => {
      const { result } = await mount('u1');
      act(() => client().goLive());
      expect(result.current.pushLive).toBe(true);

      act(() => client().connection.emit(state));
      expect(result.current.pushLive).toBe(false);
    }
  );

  it.each(['detached', 'failed', 'suspended'])(
    'is not live once the channel is %s',
    async (state) => {
      const { result } = await mount('u1');
      act(() => client().goLive());

      act(() => client().channel.emit(state));
      expect(result.current.pushLive).toBe(false);
    }
  );

  it('goes live again after a reconnect', async () => {
    const { result } = await mount('u1');
    act(() => client().goLive());
    act(() => client().connection.emit('disconnected'));
    expect(result.current.pushLive).toBe(false);

    act(() => client().goLive());
    expect(result.current.pushLive).toBe(true);
  });

  it('calls the latest onCreated for each ping without restarting the connection', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const hook = renderHook(
      ({ cb }: { cb: () => void }) => useNotificationPush({ userId: 'u1', onCreated: cb }),
      { initialProps: { cb: first } }
    );
    await waitFor(() => expect(fake.instances.length).toBeGreaterThan(0));
    const [subscription] = client().channel.subscriptions;

    subscription?.handler();
    expect(first).toHaveBeenCalledTimes(1);

    hook.rerender({ cb: second });
    subscription?.handler();

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(fake.instances).toHaveLength(1);
    expect(client().closed).toBe(0);
  });

  it('closes the client and reports not live on unmount', async () => {
    const { result, unmount } = await mount('u1');
    act(() => client().goLive());
    expect(result.current.pushLive).toBe(true);

    unmount();

    expect(client().closed).toBe(1);
  });

  it('creates no client when unmounted before the SDK chunk resolves', async () => {
    const { unmount } = renderHook(() => useNotificationPush({ userId: 'u1', onCreated: vi.fn() }));
    unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fake.instances).toHaveLength(0);
  });

  it('closes the old client and opens a new one when the user id changes', async () => {
    const { rerender } = await mount('u1');

    rerender({ id: 'u2' });
    await waitFor(() => expect(fake.instances).toHaveLength(2));

    expect(fake.instances).toHaveLength(2);
    expect(fake.instances[0]?.closed).toBe(1);
    expect(fake.instances[1]?.requestedChannels).toEqual(['notifications:u2']);
  });

  it('serves the realtime token through the node-callback auth contract', async () => {
    await mount('u1');
    const callback = vi.fn();

    client().options.authCallback({}, callback);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockTokenAction).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null, TOKEN_REQUEST);
  });

  it('closes the client on the next tick when realtime is disabled, with no retry', async () => {
    mockTokenAction.mockResolvedValue({ success: false, disabled: true });
    const { result } = await mount('u1');
    vi.useFakeTimers();
    const callback = vi.fn();

    client().options.authCallback({}, callback);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(callback).toHaveBeenCalledWith('Realtime disabled', null);
    expect(client().closed).toBe(1);
    expect(result.current.pushLive).toBe(false);
  });

  it('closes the client on the next tick for any token refusal, not only "disabled"', async () => {
    mockTokenAction.mockResolvedValue({ success: false, error: 'You are not signed in.' });
    await mount('u1');
    vi.useFakeTimers();
    const callback = vi.fn();

    client().options.authCallback({}, callback);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(callback).toHaveBeenCalledWith('You are not signed in.', null);
    expect(client().closed).toBe(1);
  });

  it('closes the client on the next tick when the token mint errors', async () => {
    mockTokenAction.mockResolvedValue({ success: false, error: 'Could not start realtime.' });
    const { result } = await mount('u1');
    vi.useFakeTimers();
    const callback = vi.fn();

    client().options.authCallback({}, callback);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(callback).toHaveBeenCalledWith('Could not start realtime.', null);
    expect(client().closed).toBe(1);
    expect(result.current.pushLive).toBe(false);
  });

  it('reports the failure to the auth callback when the token action throws', async () => {
    mockTokenAction.mockRejectedValue(new Error('boom'));
    await mount('u1');
    const callback = vi.fn();

    client().options.authCallback({}, callback);
    await act(async () => {
      await Promise.resolve();
    });

    expect(callback).toHaveBeenCalledWith('boom', null);
  });

  it('stays not live and does not throw when the channel attach fails', async () => {
    fake.subscribeRejects = true;
    const { result } = await mount('u1');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(client().channel.subscriptions).toHaveLength(1);
    expect(result.current.pushLive).toBe(false);
  });
});
