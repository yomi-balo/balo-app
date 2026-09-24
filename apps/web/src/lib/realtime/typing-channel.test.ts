import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Ably from 'ably';
import { TYPING_EVENT_STARTED, TYPING_EVENT_STOPPED, type TypingSignal } from './channels';
import {
  attachTypingChannel,
  TYPING_REATTACH_BASE_MS,
  TYPING_REATTACH_CAP_MS,
} from './typing-channel';

/**
 * ⚠⚠ The typing channel's trust boundary and lifecycle, against a HAND-ROLLED fake client.
 *
 * The fake models only what `attachTypingChannel` touches — `channels.get/release/all`,
 * `channel.subscribe/unsubscribe/publish/detach/attach/state/on/off`, `auth.clientId` and
 * `connection.state/on/off` — and dispatches inbound messages BY NAME, the way ably-js does.
 * `publish` exists on the fake only so the reader can be shown never to call it. Every inbound message is built
 * as a Proxy that records which fields were read and THROWS on `data`, so "never reads data" is
 * an observation, not a hope.
 *
 * ⚠⚠ THE CHANNEL'S METHODS ARE PLAIN FUNCTIONS, NOT `vi.fn`s. Vitest attaches handlers to every
 * promise a `vi.fn` returns (to fill `mock.settledResults`), which marks a rejection as handled
 * and would hide a missing `.catch` in the code under test. So each method records its call on a
 * `calls.*` spy that returns nothing, then returns whatever `behaviour.*` returns — a promise
 * vitest never sees, whose rejection surfaces as an unhandled rejection if nothing catches it.
 */

const SELF_ID = 'u0000000-0000-4000-8000-00000000self';
const OTHER_ID = 'u0000000-0000-4000-8000-0000000other';
const TYPING_NAME = 'typing:3f2504e0-4f89-41d3-9a0c-0305e82c3301';

type Listener = (message: Ably.InboundMessage) => void;
type StateListener = (change: Ably.ChannelStateChange) => void;

interface ChannelBehaviour {
  subscribe: (event: string, listener: Listener) => unknown;
  unsubscribe: (event: string, listener: Listener) => unknown;
  publish: (message: unknown) => unknown;
  detach: () => unknown;
  attach: () => unknown;
}

interface FakeChannel {
  state: Ably.ChannelState;
  readonly listeners: Map<string, Set<Listener>>;
  /** Channel-state listeners (`channel.on(callback)`). */
  readonly stateListeners: Set<StateListener>;
  /** Call recorders. They return nothing — see the file docblock. */
  readonly calls: {
    readonly subscribe: Mock<(event: string, listener: Listener) => void>;
    readonly unsubscribe: Mock<(event: string, listener: Listener) => void>;
    readonly publish: Mock<(message: unknown) => void>;
    readonly detach: Mock<() => void>;
    readonly attach: Mock<() => void>;
  };
  /** What each method does and returns. Plain functions; overridden per test. */
  readonly behaviour: ChannelBehaviour;
  readonly subscribe: (event: string, listener: Listener) => unknown;
  readonly unsubscribe: (event: string, listener: Listener) => unknown;
  readonly publish: (message: unknown) => unknown;
  readonly detach: () => unknown;
  readonly attach: () => unknown;
  readonly on: (listener: StateListener) => void;
  readonly off: (listener: StateListener) => void;
}

interface FakeConnection {
  state: Ably.ConnectionState;
  readonly listeners: Map<string, Set<() => void>>;
  readonly on: (event: string, listener: () => void) => void;
  readonly off: (event: string, listener: () => void) => void;
}

interface FakeClient {
  readonly auth: { clientId: unknown };
  readonly connection: FakeConnection;
  readonly channels: {
    readonly all: Record<string, FakeChannel>;
    readonly get: Mock<(name: string) => FakeChannel>;
    readonly release: Mock<(name: string) => void>;
  };
}

/** Every SDK call, in order, so tests can assert unsubscribe → detach → release. */
let callLog: string[] = [];

function createFakeChannel(): FakeChannel {
  const listeners = new Map<string, Set<Listener>>();
  const stateListeners = new Set<StateListener>();
  const calls = {
    subscribe: vi.fn<(event: string, listener: Listener) => void>(),
    unsubscribe: vi.fn<(event: string, listener: Listener) => void>(),
    publish: vi.fn<(message: unknown) => void>(),
    detach: vi.fn<() => void>(),
    attach: vi.fn<() => void>(),
  };
  const channel: FakeChannel = {
    state: 'initialized',
    listeners,
    stateListeners,
    calls,
    behaviour: {
      subscribe: (event, listener) => {
        const set = listeners.get(event) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(event, set);
        channel.state = 'attaching';
        return Promise.resolve(null);
      },
      unsubscribe: (event, listener) => {
        listeners.get(event)?.delete(listener);
      },
      publish: () => Promise.resolve({ serials: [] }),
      detach: () => {
        channel.state = 'detached';
        return Promise.resolve();
      },
      attach: () => {
        channel.state = 'attaching';
        return Promise.resolve(null);
      },
    },
    subscribe: (event, listener) => {
      callLog.push(`subscribe:${event}`);
      calls.subscribe(event, listener);
      return channel.behaviour.subscribe(event, listener);
    },
    unsubscribe: (event, listener) => {
      callLog.push(`unsubscribe:${event}`);
      calls.unsubscribe(event, listener);
      return channel.behaviour.unsubscribe(event, listener);
    },
    publish: (message) => {
      callLog.push('publish');
      calls.publish(message);
      return channel.behaviour.publish(message);
    },
    detach: () => {
      callLog.push('detach');
      calls.detach();
      return channel.behaviour.detach();
    },
    attach: () => {
      callLog.push('attach');
      calls.attach();
      return channel.behaviour.attach();
    },
    on: (listener) => {
      stateListeners.add(listener);
    },
    off: (listener) => {
      stateListeners.delete(listener);
    },
  };
  return channel;
}

function createFakeConnection(): FakeConnection {
  const listeners = new Map<string, Set<() => void>>();
  return {
    state: 'connected',
    listeners,
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(event, set);
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
  };
}

function createFakeClient(channel: FakeChannel = createFakeChannel()): FakeClient {
  const all: Record<string, FakeChannel> = {};
  return {
    auth: { clientId: SELF_ID },
    connection: createFakeConnection(),
    channels: {
      all,
      get: vi.fn((name: string) => {
        all[name] ??= channel;
        return all[name];
      }),
      release: vi.fn((name: string) => {
        callLog.push(`release:${name}`);
        delete all[name];
      }),
    },
  };
}

function asAbly(client: FakeClient): Ably.Realtime {
  return client as unknown as Ably.Realtime;
}

/**
 * An inbound message whose every property read is recorded, and whose `data` THROWS — with an
 * enumerable `data` key, so even a spread or a `JSON.stringify` of the message would trip it.
 */
function hostileMessage(fields: Record<string, unknown>): {
  message: Ably.InboundMessage;
  reads: string[];
} {
  const reads: string[] = [];
  const target: Record<string, unknown> = { ...fields, data: '<img src=x onerror=alert(1)>' };
  const message = new Proxy(target, {
    get(object, key, receiver): unknown {
      reads.push(String(key));
      if (key === 'data') throw new Error('typing-channel read message.data');
      return Reflect.get(object, key, receiver) as unknown;
    },
  });
  return { message: message as unknown as Ably.InboundMessage, reads };
}

/** Deliver a message the way ably-js does: to the listeners registered for its `name`. */
function emit(channel: FakeChannel, fields: Record<string, unknown>): void {
  const { message } = hostileMessage(fields);
  const name = fields.name;
  if (typeof name !== 'string') return;
  for (const listener of channel.listeners.get(name) ?? []) listener(message);
}

/** Move the fake connection to `state` and notify its listeners, as ably-js does. */
function setConnectionState(client: FakeClient, state: Ably.ConnectionState): void {
  client.connection.state = state;
  for (const listener of client.connection.listeners.get(state) ?? []) listener();
}

/** Move the fake channel to `current` and notify its state listeners, as ably-js does. */
function setChannelState(channel: FakeChannel, current: Ably.ChannelState, code?: number): void {
  const previous = channel.state;
  channel.state = current;
  const change = {
    current,
    previous,
    resumed: false,
    reason: code === undefined ? undefined : { code, statusCode: 400, message: 'refused' },
  } as unknown as Ably.ChannelStateChange;
  for (const listener of channel.stateListeners) listener(change);
}

/** Let every pending promise callback (detach → release, and any stray rejection) run. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function attach(client: FakeClient): {
  handle: ReturnType<typeof attachTypingChannel>;
  signals: [TypingSignal, string][];
} {
  const signals: [TypingSignal, string][] = [];
  const handle = attachTypingChannel(asAbly(client), TYPING_NAME, (signal, clientId) => {
    signals.push([signal, clientId]);
  });
  return { handle, signals };
}

/** The listener `attachTypingChannel` registered first, captured from the fake. */
function registeredListener(channel: FakeChannel): Listener {
  const [call] = channel.calls.subscribe.mock.calls;
  const listener = call?.[1];
  if (listener === undefined) throw new Error('no listener was registered');
  return listener;
}

beforeEach(() => {
  callLog = [];
});

describe('attachTypingChannel — attach', () => {
  it('⚠ refuses any channel outside the typing namespace, before touching the client', () => {
    const client = createFakeClient();

    for (const name of ['conversation:3f2504e0', 'conversation:3f2504e0:typing', 'typingx:y']) {
      expect(() => attachTypingChannel(asAbly(client), name, vi.fn())).toThrow(/non-typing/);
    }
    expect(client.channels.get).not.toHaveBeenCalled();
  });

  it('gets the named channel and subscribes EXACTLY the two typing event names', () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);

    attach(client);

    expect(client.channels.get).toHaveBeenCalledTimes(1);
    expect(client.channels.get).toHaveBeenCalledWith(TYPING_NAME);
    expect(channel.calls.subscribe).toHaveBeenCalledTimes(2);
    expect(channel.calls.subscribe.mock.calls.map(([event]) => event)).toEqual([
      TYPING_EVENT_STARTED,
      TYPING_EVENT_STOPPED,
    ]);
  });

  it('swallows an attach REJECTION — no throw, no unhandled rejection', async () => {
    const channel = createFakeChannel();
    channel.behaviour.subscribe = () => Promise.reject(new Error('40160 attach denied'));
    const client = createFakeClient(channel);

    expect(() => attach(client)).not.toThrow();
    await flush();
    expect(channel.calls.subscribe).toHaveBeenCalledTimes(2);
  });

  it('swallows a SYNCHRONOUS subscribe throw', () => {
    const channel = createFakeChannel();
    channel.behaviour.subscribe = () => {
      throw new Error('channel failed');
    };
    const client = createFakeClient(channel);

    expect(() => attach(client)).not.toThrow();
    expect(channel.calls.subscribe).toHaveBeenCalledTimes(2);
  });
});

describe('attachTypingChannel — ⚠⚠ inbound trust boundary', () => {
  it('reports another member’s signals as (signal, clientId), in order', () => {
    const channel = createFakeChannel();
    const { signals } = attach(createFakeClient(channel));

    emit(channel, { name: TYPING_EVENT_STARTED, clientId: OTHER_ID });
    emit(channel, { name: TYPING_EVENT_STOPPED, clientId: OTHER_ID });

    expect(signals).toEqual([
      ['started', OTHER_ID],
      ['stopped', OTHER_ID],
    ]);
  });

  /**
   * ⚠⚠ THE HOSTILE-PAYLOAD PIN. A publisher controls `data` completely; the receiver must still
   * deliver the signal and must never have read `data` at all — only `name` and `clientId`.
   */
  it('⚠⚠ never reads `data` — a hostile payload still yields only (signal, clientId)', () => {
    const channel = createFakeChannel();
    const { signals } = attach(createFakeClient(channel));
    const listener = registeredListener(channel);

    const { message, reads } = hostileMessage({ name: TYPING_EVENT_STARTED, clientId: OTHER_ID });
    expect(() => listener(message)).not.toThrow();

    expect(signals).toEqual([['started', OTHER_ID]]);
    expect(reads).not.toContain('data');
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set(['name', 'clientId']));
  });

  it('⚠ drops the viewer’s OWN signals — which also dedupes their other tabs', () => {
    const channel = createFakeChannel();
    const { signals } = attach(createFakeClient(channel));

    emit(channel, { name: TYPING_EVENT_STARTED, clientId: SELF_ID });
    emit(channel, { name: TYPING_EVENT_STOPPED, clientId: SELF_ID });
    emit(channel, { name: TYPING_EVENT_STARTED, clientId: OTHER_ID });

    expect(signals).toEqual([['started', OTHER_ID]]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['non-string (number)', 42],
    ['non-string (null)', null],
    ['non-string (object)', { toString: () => OTHER_ID }],
  ])('drops a signal whose clientId is %s', (_label, clientId) => {
    const channel = createFakeChannel();
    const { signals } = attach(createFakeClient(channel));

    emit(channel, { name: TYPING_EVENT_STARTED, clientId });
    emit(channel, { name: TYPING_EVENT_STARTED, clientId: OTHER_ID });

    expect(signals).toEqual([['started', OTHER_ID]]);
  });

  /**
   * ⚠⚠ FAIL CLOSED. While the viewer's own id is unknown, no event can be proved not to be their
   * own echo — so every event is dropped, rather than risking "you are typing" for yourself.
   */
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['non-string', 7],
  ])('⚠⚠ drops EVERY signal while the own clientId is %s', (_label, selfId) => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    client.auth.clientId = selfId;
    const { signals } = attach(client);

    emit(channel, { name: TYPING_EVENT_STARTED, clientId: OTHER_ID });
    emit(channel, { name: TYPING_EVENT_STOPPED, clientId: OTHER_ID });

    expect(signals).toEqual([]);
  });

  it('reads the own clientId at EVENT time — ably-js fills it in on CONNECTED', () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    client.auth.clientId = undefined;
    const { signals } = attach(client);

    emit(channel, { name: TYPING_EVENT_STARTED, clientId: OTHER_ID });
    client.auth.clientId = SELF_ID;
    emit(channel, { name: TYPING_EVENT_STARTED, clientId: OTHER_ID });

    expect(signals).toEqual([['started', OTHER_ID]]);
  });

  it('ignores every other message name — on the channel AND inside its own listener', () => {
    const channel = createFakeChannel();
    const { signals } = attach(createFakeClient(channel));
    const listener = registeredListener(channel);

    for (const name of ['message', 'file', 'typing', 'typing.start', undefined]) {
      emit(channel, { name, clientId: OTHER_ID });
      listener(hostileMessage({ name, clientId: OTHER_ID }).message);
    }

    expect(signals).toEqual([]);
  });
});

describe('attachTypingChannel — release', () => {
  it('unsubscribes its OWN listener from both names, detaches, then releases the channel', async () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    const { handle } = attach(client);
    const listener = registeredListener(channel);
    callLog = [];

    handle.release();
    await flush();

    expect(channel.calls.unsubscribe).toHaveBeenCalledTimes(2);
    expect(channel.calls.unsubscribe).toHaveBeenCalledWith(TYPING_EVENT_STARTED, listener);
    expect(channel.calls.unsubscribe).toHaveBeenCalledWith(TYPING_EVENT_STOPPED, listener);
    expect(channel.calls.detach).toHaveBeenCalledTimes(1);
    expect(client.channels.release).toHaveBeenCalledTimes(1);
    expect(client.channels.release).toHaveBeenCalledWith(TYPING_NAME);
    expect(callLog).toEqual([
      `unsubscribe:${TYPING_EVENT_STARTED}`,
      `unsubscribe:${TYPING_EVENT_STOPPED}`,
      'detach',
      `release:${TYPING_NAME}`,
    ]);
  });

  it('stops delivering signals once released', () => {
    const channel = createFakeChannel();
    const { handle, signals } = attach(createFakeClient(channel));
    const listener = registeredListener(channel);

    handle.release();
    emit(channel, { name: TYPING_EVENT_STARTED, clientId: OTHER_ID });
    // Even a listener the SDK failed to drop is inert after release.
    listener(hostileMessage({ name: TYPING_EVENT_STARTED, clientId: OTHER_ID }).message);

    expect(signals).toEqual([]);
  });

  it('⚠ issues the detach SYNCHRONOUSLY, so a same-tick re-attach supersedes it', () => {
    const channel = createFakeChannel();
    const { handle } = attach(createFakeClient(channel));

    handle.release();

    expect(channel.calls.detach).toHaveBeenCalledTimes(1);
  });

  it('is idempotent', async () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    const { handle } = attach(client);

    handle.release();
    handle.release();
    await flush();
    handle.release();
    await flush();

    expect(channel.calls.unsubscribe).toHaveBeenCalledTimes(2);
    expect(channel.calls.detach).toHaveBeenCalledTimes(1);
    expect(client.channels.release).toHaveBeenCalledTimes(1);
  });

  it('never throws when detach throws SYNCHRONOUSLY, and still releases an idle channel', async () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    const { handle } = attach(client);
    channel.state = 'failed';
    channel.behaviour.detach = () => {
      throw new Error('Unable to detach; channel state = failed');
    };

    expect(() => handle.release()).not.toThrow();
    await flush();

    expect(client.channels.release).toHaveBeenCalledWith(TYPING_NAME);
  });

  it('never throws when detach REJECTS, and still releases an idle channel', async () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    const { handle } = attach(client);
    channel.behaviour.detach = () => {
      channel.state = 'failed';
      return Promise.reject(new Error('Unable to detach'));
    };

    expect(() => handle.release()).not.toThrow();
    await flush();

    expect(client.channels.release).toHaveBeenCalledWith(TYPING_NAME);
  });

  it('never throws when unsubscribe or channels.release throw', async () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    const { handle } = attach(client);
    channel.behaviour.unsubscribe = () => {
      throw new Error('unsubscribe failed');
    };
    client.channels.release.mockImplementation(() => {
      throw new Error('release failed');
    });

    expect(() => handle.release()).not.toThrow();
    await flush();

    expect(channel.calls.detach).toHaveBeenCalledTimes(1);
    expect(client.channels.release).toHaveBeenCalledTimes(1);
  });

  it('never throws on a CLOSED client (connection closed, channel already detached)', async () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    const { handle } = attach(client);
    client.connection.state = 'closed';
    channel.state = 'detached';

    expect(() => handle.release()).not.toThrow();
    await flush();

    expect(client.channels.release).toHaveBeenCalledWith(TYPING_NAME);
  });

  /**
   * ⚠⚠ THE A → B → A RACE. `channels.get` returns the SAME object to a newer handle while the
   * old handle's detach is in flight; the newer subscribe moves it back to `attaching` and
   * supersedes the detach. Releasing it then would drop it from `channels.all` — the map ably-js
   * routes inbound messages through — and the newer handle would go silently deaf.
   */
  it('⚠⚠ does NOT release a channel a newer handle re-attached before the detach settled', async () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    const first = attach(client);
    let rejectDetach: (error: Error) => void = () => undefined;
    channel.behaviour.detach = () => {
      channel.state = 'detaching';
      return new Promise<void>((_resolve, reject) => {
        rejectDetach = reject;
      });
    };

    first.handle.release();
    const second = attach(client);
    rejectDetach(new Error('Detach request superseded by a subsequent attach request'));
    await flush();

    expect(channel.state).toBe('attaching');
    expect(client.channels.release).not.toHaveBeenCalled();
    expect(client.channels.all[TYPING_NAME]).toBe(channel);

    emit(channel, { name: TYPING_EVENT_STARTED, clientId: OTHER_ID });
    expect(second.signals).toEqual([['started', OTHER_ID]]);
    expect(first.signals).toEqual([]);
  });

  it('does NOT release when the client map already holds a DIFFERENT channel object', async () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    const { handle } = attach(client);
    const replacement = createFakeChannel();
    client.channels.all[TYPING_NAME] = replacement;

    handle.release();
    await flush();

    expect(client.channels.release).not.toHaveBeenCalled();
    expect(client.channels.all[TYPING_NAME]).toBe(replacement);
  });
});

describe('attachTypingChannel — ⚠⚠ keeps the channel attached', () => {
  it('re-attaches a channel STRANDED by a subscribe made while suspended, on the next `connected`', () => {
    const channel = createFakeChannel();
    // ably-js fails the implicit attach at once while suspended and leaves the channel as is.
    channel.behaviour.subscribe = (event, listener) => {
      const set = channel.listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      channel.listeners.set(event, set);
      return Promise.reject(new Error('80002 connection suspended'));
    };
    const client = createFakeClient(channel);
    client.connection.state = 'suspended';
    attach(client);
    expect(channel.state).toBe('initialized');

    setConnectionState(client, 'connected');

    expect(channel.calls.attach).toHaveBeenCalledTimes(1);
  });

  it.each(['attaching', 'attached', 'detaching', 'suspended'] as const)(
    'leaves a `%s` channel to ably-js on `connected` — it recovers those itself',
    (state) => {
      const channel = createFakeChannel();
      const client = createFakeClient(channel);
      attach(client);
      channel.state = state;

      setConnectionState(client, 'connected');

      expect(channel.calls.attach).not.toHaveBeenCalled();
    }
  );

  it('re-attaches a channel FAILED by an undecodable message, after the backoff and not before', () => {
    vi.useFakeTimers();
    try {
      const channel = createFakeChannel();
      attach(createFakeClient(channel));

      setChannelState(channel, 'failed', 40019);
      vi.advanceTimersByTime(TYPING_REATTACH_BASE_MS - 1);
      expect(channel.calls.attach).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(channel.calls.attach).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('doubles the backoff on repeated failures, caps it, and resets it after a good attach', () => {
    vi.useFakeTimers();
    try {
      const channel = createFakeChannel();
      attach(createFakeClient(channel));
      const attachesAfter = (ms: number): number => {
        setChannelState(channel, 'failed', 40019);
        vi.advanceTimersByTime(ms - 1);
        const before = channel.calls.attach.mock.calls.length;
        vi.advanceTimersByTime(1);
        return channel.calls.attach.mock.calls.length - before;
      };

      expect(attachesAfter(TYPING_REATTACH_BASE_MS)).toBe(1);
      expect(attachesAfter(TYPING_REATTACH_BASE_MS * 2)).toBe(1);
      expect(attachesAfter(TYPING_REATTACH_BASE_MS * 4)).toBe(1);
      for (let step = 0; step < 6; step += 1) attachesAfter(TYPING_REATTACH_CAP_MS);
      expect(attachesAfter(TYPING_REATTACH_CAP_MS)).toBe(1);

      setChannelState(channel, 'attached');
      expect(attachesAfter(TYPING_REATTACH_BASE_MS)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⚠ does NOT retry a capability refusal (40160) — that token refuses every attempt', () => {
    vi.useFakeTimers();
    try {
      const channel = createFakeChannel();
      attach(createFakeClient(channel));

      setChannelState(channel, 'failed', 40160);
      vi.advanceTimersByTime(TYPING_REATTACH_CAP_MS * 2);

      expect(channel.calls.attach).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry while the connection is down — the next `connected` does it', () => {
    vi.useFakeTimers();
    try {
      const channel = createFakeChannel();
      const client = createFakeClient(channel);
      attach(client);

      setChannelState(channel, 'failed', 40019);
      client.connection.state = 'disconnected';
      vi.advanceTimersByTime(TYPING_REATTACH_BASE_MS);
      expect(channel.calls.attach).not.toHaveBeenCalled();

      setConnectionState(client, 'connected');
      expect(channel.calls.attach).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⚠ stops re-attaching once released — no pending retry, no `connected` re-attach', () => {
    vi.useFakeTimers();
    try {
      const channel = createFakeChannel();
      const client = createFakeClient(channel);
      const { handle } = attach(client);

      setChannelState(channel, 'failed', 40019);
      handle.release();
      vi.advanceTimersByTime(TYPING_REATTACH_CAP_MS);
      channel.state = 'initialized';
      setConnectionState(client, 'connected');

      expect(channel.calls.attach).not.toHaveBeenCalled();
      expect(channel.stateListeners.size).toBe(0);
      expect(client.connection.listeners.get('connected')?.size ?? 0).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows an attach REJECTION on a re-attach', async () => {
    const channel = createFakeChannel();
    channel.behaviour.attach = () => Promise.reject(new Error('40019 again'));
    const client = createFakeClient(channel);
    attach(client);
    channel.state = 'failed';

    expect(() => setConnectionState(client, 'connected')).not.toThrow();
    await flush();
    expect(channel.calls.attach).toHaveBeenCalledTimes(1);
  });
});

describe('attachTypingChannel — ⚠⚠ the client never publishes', () => {
  it('attaching, receiving, switching and releasing publish NOTHING — the token is subscribe-only', async () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    const { handle } = attach(client);

    emit(channel, { name: TYPING_EVENT_STARTED, clientId: OTHER_ID });
    setChannelState(channel, 'failed', 40019);
    setConnectionState(client, 'connected');
    handle.release();
    await flush();

    expect(channel.calls.publish).not.toHaveBeenCalled();
    expect(callLog.filter((entry) => entry === 'publish')).toEqual([]);
  });
});
