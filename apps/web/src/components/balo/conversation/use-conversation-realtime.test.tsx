import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';

type Listener = (msg: object) => void;

/**
 * ⚠ The fake models ONE client with a per-client `channels.all` map — the typing channel's
 * release path reads it — while `state.channels` indexes every channel ever created by name so a
 * test can reach it. The channel methods are PLAIN functions (never `vi.fn`s returning promises,
 * which vitest marks handled), and every SDK call lands in `state.log` so ORDER is assertable.
 *
 * `publish` exists on the fake only so the hook can be shown never to call it: the client's token
 * is subscribe-only, and typing leaves through `sendTyping` (a Server Action).
 */
const { state, MockRealtime, VIEWER_ID } = vi.hoisted(() => {
  /** The viewer's own Ably `clientId` (= `users.id`, stamped from the token). */
  const VIEWER_ID = 'user-viewer';
  interface ChannelStub {
    name: string;
    state: string;
    listeners: Map<string, Listener[]>;
    published: unknown[];
    subscribe: (event: string, listener: Listener) => Promise<void>;
    unsubscribe: (event: string, listener: Listener) => void;
    publish: (message: unknown) => Promise<void>;
    detach: () => Promise<void>;
  }
  const state = {
    clients: [] as InstanceType<typeof MockRealtime>[],
    channels: new Map<string, ChannelStub>(),
    log: [] as string[],
  };
  function createChannel(name: string): ChannelStub {
    return {
      name,
      state: 'initialized',
      listeners: new Map<string, Listener[]>(),
      published: [],
      subscribe(event, listener) {
        state.log.push(`subscribe:${name}:${event}`);
        const list = this.listeners.get(event) ?? [];
        list.push(listener);
        this.listeners.set(event, list);
        this.state = 'attached';
        return Promise.resolve();
      },
      unsubscribe(event, listener) {
        state.log.push(`unsubscribe:${name}:${event}`);
        const list = this.listeners.get(event) ?? [];
        this.listeners.set(
          event,
          list.filter((l) => l !== listener)
        );
      },
      publish(message) {
        state.log.push(`publish:${name}`);
        this.published.push(message);
        return Promise.resolve();
      },
      detach() {
        state.log.push(`detach:${name}`);
        this.state = 'detached';
        return Promise.resolve();
      },
    };
  }
  class MockRealtime {
    options: Record<string, unknown>;
    closed = false;
    released: string[] = [];
    auth: { clientId: unknown } = { clientId: VIEWER_ID };
    connectionListeners = new Map<string, (() => void)[]>();
    connection = {
      state: 'initialized',
      on: (event: string, cb: () => void): void => {
        const list = this.connectionListeners.get(event) ?? [];
        list.push(cb);
        this.connectionListeners.set(event, list);
      },
      off: (event: string, cb: () => void): void => {
        const list = this.connectionListeners.get(event) ?? [];
        this.connectionListeners.set(
          event,
          list.filter((l) => l !== cb)
        );
      },
    };
    all: Record<string, ChannelStub> = {};
    channels = {
      all: this.all,
      get: (name: string): ChannelStub => {
        let channel = this.all[name];
        if (!channel) {
          channel = createChannel(name);
          this.all[name] = channel;
          state.channels.set(name, channel);
        }
        return channel;
      },
      release: (name: string): void => {
        state.log.push(`release:${name}`);
        this.released.push(name);
        delete this.all[name];
      },
    };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      state.clients.push(this);
    }
    close(): void {
      state.log.push('close');
      this.closed = true;
      this.connection.state = 'closed';
    }
    emitConnection(event: string): void {
      this.connection.state = event;
      for (const cb of this.connectionListeners.get(event) ?? []) cb();
    }
  }
  return { state, MockRealtime, VIEWER_ID };
});

vi.mock('ably', () => ({ Realtime: MockRealtime }));

/**
 * ⚠ BAL-421 — the hook no longer IMPORTS a token action; each surface INJECTS one. So this
 * is a plain spy passed as the `fetchToken` prop rather than a module mock. The assertions
 * below are unchanged in substance: the hook still calls its fetcher exactly when it should.
 */
const mockTokenAction = vi.fn();

// ⚠ BAL-437 — the sanitiser moved to `@/lib/realtime/message-payload` (the call surface needs
// it and must not import a conversation module). Same function, same assertions, one home.
import { sanitizeRealtimeBodyHtml } from '@/lib/realtime/message-payload';
import {
  useConversationRealtime,
  type ConversationRealtimeTokenResult,
} from './use-conversation-realtime';

/** Stable identity — the hook re-subscribes when `fetchToken` changes, exactly as documented. */
const fetchToken = (): Promise<ConversationRealtimeTokenResult> =>
  mockTokenAction({ requestId: REQUEST_ID }) as Promise<ConversationRealtimeTokenResult>;

function emit(channelName: string, event: string, data: unknown): void {
  const channel = state.channels.get(channelName);
  for (const listener of channel?.listeners.get(event) ?? []) {
    listener({ data });
  }
}

/** Fully-shaped payloads — the guard type-checks EVERY consumed field. */
function messagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-1',
    conversationId: 'conv-1',
    bodyHtml: '<p>hi</p>',
    senderUserId: 'user-2',
    senderName: 'Priya Nair',
    createdAtIso: '2026-06-10T10:00:00.000Z',
    ...overrides,
  };
}

function filePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f-1',
    conversationId: 'conv-1',
    fileName: 'x.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1234,
    uploadedByUserId: 'user-2',
    uploadedByName: 'Priya Nair',
    createdAtIso: '2026-06-10T10:00:00.000Z',
    ...overrides,
  };
}

/** The PRE-BAL-424 wire shape: `relationshipId` where `conversationId` now lives. */
function asLegacyPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(payload).filter(([key]) => key !== 'conversationId');
  return { ...Object.fromEntries(entries), relationshipId: 'rel-1' };
}

describe('useConversationRealtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.clients.length = 0;
    state.channels.clear();
    state.log.length = 0;
    mockTokenAction.mockResolvedValue({ success: true, tokenRequest: { keyName: 'k' } });
  });

  it("returns 'disabled' without instantiating Ably when not enabled", () => {
    const { result } = renderHook(() =>
      useConversationRealtime({
        enabled: false,
        fetchToken,
        conversationIds: ['conv-1'],
        onMessage: vi.fn(),
        onFile: vi.fn(),
      })
    );
    expect(result.current.status).toBe('disabled');
    expect(state.clients).toHaveLength(0);
  });

  it("returns 'disabled' when there are no channels to join", () => {
    const { result } = renderHook(() =>
      useConversationRealtime({
        enabled: true,
        fetchToken,
        conversationIds: [],
        onMessage: vi.fn(),
        onFile: vi.fn(),
      })
    );
    expect(result.current.status).toBe('disabled');
  });

  it('subscribes message + file events on every entitled channel', async () => {
    renderHook(() =>
      useConversationRealtime({
        enabled: true,
        fetchToken,
        conversationIds: ['conv-1', 'conv-2'],
        onMessage: vi.fn(),
        onFile: vi.fn(),
      })
    );
    await waitFor(() => expect(state.clients).toHaveLength(1));
    expect(state.channels.has('conversation:conv-1')).toBe(true);
    expect(state.channels.has('conversation:conv-2')).toBe(true);
    expect(state.channels.get('conversation:conv-1')?.listeners.get('message')).toHaveLength(1);
    expect(state.channels.get('conversation:conv-1')?.listeners.get('file')).toHaveLength(1);
  });

  it('moves connecting → connected → connecting with the connection lifecycle', async () => {
    const { result } = renderHook(() =>
      useConversationRealtime({
        enabled: true,
        fetchToken,
        conversationIds: ['conv-1'],
        onMessage: vi.fn(),
        onFile: vi.fn(),
      })
    );
    expect(result.current.status).toBe('connecting');
    await waitFor(() => expect(state.clients).toHaveLength(1));
    act(() => state.clients[0]?.emitConnection('connected'));
    expect(result.current.status).toBe('connected');
    act(() => state.clients[0]?.emitConnection('disconnected'));
    expect(result.current.status).toBe('connecting');
    act(() => state.clients[0]?.emitConnection('failed'));
    expect(result.current.status).toBe('failed');
  });

  it('delivers fully-shaped payloads to the right handler and drops malformed ones', async () => {
    const onMessage = vi.fn();
    const onFile = vi.fn();
    renderHook(() =>
      useConversationRealtime({
        enabled: true,
        fetchToken,
        conversationIds: ['conv-1'],
        onMessage,
        onFile,
      })
    );
    await waitFor(() => expect(state.channels.has('conversation:conv-1')).toBe(true));

    const message = messagePayload();
    act(() => emit('conversation:conv-1', 'message', message));
    expect(onMessage).toHaveBeenCalledWith(message);

    const file = filePayload();
    act(() => emit('conversation:conv-1', 'file', file));
    expect(onFile).toHaveBeenCalledWith(file);

    // Every consumed field is type-checked — partial shapes never reach the island.
    act(() => emit('conversation:conv-1', 'message', 'garbage'));
    act(() => emit('conversation:conv-1', 'message', { nope: true }));
    act(() =>
      emit('conversation:conv-1', 'message', {
        id: 'm-2',
        conversationId: 'conv-1',
        bodyHtml: '<p>x</p>',
      })
    );
    act(() => emit('conversation:conv-1', 'message', messagePayload({ senderName: 42 })));
    expect(onMessage).toHaveBeenCalledTimes(1);

    act(() =>
      emit('conversation:conv-1', 'file', {
        id: 'f-2',
        conversationId: 'conv-1',
        fileName: 'y.pdf',
      })
    );
    act(() => emit('conversation:conv-1', 'file', filePayload({ sizeBytes: 'big' })));
    expect(onFile).toHaveBeenCalledTimes(1);
  });

  /**
   * BAL-424 REGRESSION GUARD. Both payload type guards are STRUCTURAL: had either kept
   * requiring `relationshipId` after the Ably re-key, EVERY realtime message would be
   * silently dropped and `tsc` would still be green — the payload arrives as `unknown` from
   * a third-party transport. This is the only thing that catches a half-finished re-key.
   */
  it('rejects a legacy payload carrying relationshipId instead of conversationId', async () => {
    const onMessage = vi.fn();
    const onFile = vi.fn();
    renderHook(() =>
      useConversationRealtime({
        enabled: true,
        fetchToken,
        conversationIds: ['conv-1'],
        onMessage,
        onFile,
      })
    );
    await waitFor(() => expect(state.channels.has('conversation:conv-1')).toBe(true));

    const legacyMessage = asLegacyPayload(messagePayload());
    const legacyFile = asLegacyPayload(filePayload());

    act(() => emit('conversation:conv-1', 'message', legacyMessage));
    act(() => emit('conversation:conv-1', 'file', legacyFile));
    expect(onMessage).not.toHaveBeenCalled();
    expect(onFile).not.toHaveBeenCalled();

    // …and the CURRENT shape IS accepted, so the assertions above cannot pass vacuously.
    act(() => emit('conversation:conv-1', 'message', messagePayload()));
    act(() => emit('conversation:conv-1', 'file', filePayload()));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledTimes(1);
  });

  it('neutralises hostile bodyHtml before it can reach dangerouslySetInnerHTML', async () => {
    const onMessage = vi.fn();
    renderHook(() =>
      useConversationRealtime({
        enabled: true,
        fetchToken,
        conversationIds: ['conv-1'],
        onMessage,
        onFile: vi.fn(),
      })
    );
    await waitFor(() => expect(state.channels.has('conversation:conv-1')).toBe(true));

    const hostile = messagePayload({
      bodyHtml: '<p>hi</p><img src=x onerror=alert(1)><script>alert(2)</script>',
    });
    act(() => emit('conversation:conv-1', 'message', hostile));
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyHtml:
          '<p>hi</p>&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;',
      })
    );
  });

  it('uses a Node-callback style authCallback wired to the token action', async () => {
    renderHook(() =>
      useConversationRealtime({
        enabled: true,
        fetchToken,
        conversationIds: ['conv-1'],
        onMessage: vi.fn(),
        onFile: vi.fn(),
      })
    );
    await waitFor(() => expect(state.clients).toHaveLength(1));
    const authCallback = state.clients[0]?.options.authCallback as (
      params: unknown,
      cb: (err: unknown, token: unknown) => void
    ) => void;
    expect(typeof authCallback).toBe('function');

    const callback = vi.fn();
    authCallback({}, callback);
    await waitFor(() => expect(callback).toHaveBeenCalledWith(null, { keyName: 'k' }));
    expect(mockTokenAction).toHaveBeenCalledWith({ requestId: REQUEST_ID });

    // Failure path: action returns { success: false }.
    mockTokenAction.mockResolvedValue({ success: false, error: 'denied' });
    const failCallback = vi.fn();
    authCallback({}, failCallback);
    await waitFor(() => expect(failCallback).toHaveBeenCalledWith('denied', null));

    // Rejection path: the action itself throws — the `.message` is extracted
    // (never '[object Object]' / 'Error: …' default stringification).
    mockTokenAction.mockRejectedValue(new Error('boom'));
    const rejectCallback = vi.fn();
    authCallback({}, rejectCallback);
    await waitFor(() => expect(rejectCallback).toHaveBeenCalledWith('boom', null));
  });

  it('sanitizeRealtimeBodyHtml passes server-built markup through unchanged', () => {
    const serverBuilt = '<p>Line one<br />Line two</p><p>Para two &amp; more</p>';
    expect(sanitizeRealtimeBodyHtml(serverBuilt)).toBe(serverBuilt);
    expect(sanitizeRealtimeBodyHtml('<p>a</p><p>b<br>c<br/>d</p>')).toBe(
      '<p>a</p><p>b<br>c<br/>d</p>'
    );
  });

  it('sanitizeRealtimeBodyHtml escapes every non-allowed tag, including unterminated ones', () => {
    expect(sanitizeRealtimeBodyHtml('<P>ok</P><a href="x">link</a>')).toBe(
      '<P>ok</P>&lt;a href="x"&gt;link&lt;/a&gt;'
    );
    expect(sanitizeRealtimeBodyHtml('trailing <script')).toBe('trailing &lt;script');
    expect(sanitizeRealtimeBodyHtml('<br onload=x>')).toBe('&lt;br onload=x&gt;');
  });

  it('closes the client on unmount', async () => {
    const { unmount } = renderHook(() =>
      useConversationRealtime({
        enabled: true,
        fetchToken,
        conversationIds: ['conv-1'],
        onMessage: vi.fn(),
        onFile: vi.fn(),
      })
    );
    await waitFor(() => expect(state.clients).toHaveLength(1));
    unmount();
    expect(state.clients[0]?.closed).toBe(true);
  });
});

type ChannelStub = NonNullable<ReturnType<typeof state.channels.get>>;

/** A stable list — the hook keys its channel set on it. */
const TWO_CONVERSATIONS = ['conv-1', 'conv-2'];
const noop = (): void => undefined;

/** The exact wire shapes: a name, the ephemeral flag, and NO `data` key at all. */

interface TypingProps {
  typingConversationId?: string | null;
  enabled?: boolean;
  conversationIds?: string[];
}

/** The surface's typing Server Action — `(conversationId, signal)`, resolving like the real one. */
const mockSendTyping = vi.fn<
  (conversationId: string, signal: 'started' | 'stopped') => Promise<unknown>
>(() => Promise.resolve({ success: true }));

function renderTyping(initialProps: TypingProps) {
  return renderHook(
    (props: TypingProps) =>
      useConversationRealtime({
        enabled: props.enabled ?? true,
        fetchToken,
        conversationIds: props.conversationIds ?? TWO_CONVERSATIONS,
        onMessage: noop,
        onFile: noop,
        typingConversationId: props.typingConversationId,
        sendTyping: mockSendTyping,
      }),
    { initialProps }
  );
}

/** Every `publish` any fake channel received — the client must make none. */
function clientPublishes(): string[] {
  return state.log.filter((entry) => entry.startsWith('publish'));
}

function typingChannelNames(): string[] {
  return [...state.channels.keys()].filter((name) => name.startsWith('typing:'));
}

function subscribeCount(prefix: string): number {
  return state.log.filter((entry) => entry.startsWith(`subscribe:${prefix}`)).length;
}

/** Wait for the typing channel to attach, then bring the connection up. */
async function liveTypingChannel(conversationId: string): Promise<ChannelStub> {
  await waitFor(() =>
    expect(
      state.channels.get(`typing:${conversationId}`)?.listeners.get('typing.started')
    ).toHaveLength(1)
  );
  act(() => state.clients[0]?.emitConnection('connected'));
  const channel = state.channels.get(`typing:${conversationId}`);
  if (channel === undefined) throw new Error(`typing:${conversationId} never attached`);
  return channel;
}

/**
 * Open a burst. Retried because the relay reaches the machine one render after the attach; a
 * keystroke before then is inert, and once a burst is open further keystrokes send nothing — so
 * the exact-count assertion cannot be satisfied by a double send.
 */
async function openBurst(result: {
  current: ReturnType<typeof useConversationRealtime>;
}): Promise<void> {
  await waitFor(() => {
    result.current.typing?.onKeystroke();
    expect(mockSendTyping).toHaveBeenCalledTimes(1);
  });
}

/**
 * Deliver one inbound typing signal whose `data` is HOSTILE: an enumerable getter that throws.
 * Any read — a guard, a spread, a `JSON.stringify` — throws out of the listener and fails the
 * test. Returns how many times `data` was touched.
 */
function emitTyping(conversationId: string, name: string, clientId: unknown): number {
  let dataReads = 0;
  const message = { name, clientId };
  Object.defineProperty(message, 'data', {
    enumerable: true,
    get(): never {
      dataReads += 1;
      throw new Error('typing data must never be read');
    },
  });
  const channel = state.channels.get(`typing:${conversationId}`);
  for (const listener of channel?.listeners.get(name) ?? []) listener(message);
  return dataReads;
}

/**
 * ⚠⚠ The "typing…" signal is READ on the SAME client, on a `typing:{conversationId}` channel of
 * its own for the ONE open thread, and SENT through `sendTyping` — the server publishes; this
 * client publishes nothing. Everything below runs through the real `attachTypingChannel`, the
 * real relay and the real typing state machine; only the Ably client and the action are faked.
 */
describe('useConversationRealtime — typing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.clients.length = 0;
    state.channels.clear();
    state.log.length = 0;
    mockTokenAction.mockResolvedValue({ success: true, tokenRequest: { keyName: 'k' } });
  });

  it('attaches typing on the EXISTING client, for the typing thread ONLY (AC6)', async () => {
    const { result } = renderTyping({ typingConversationId: 'conv-2' });

    await liveTypingChannel('conv-2');

    expect(state.clients).toHaveLength(1);
    // conv-1 is subscribed for MESSAGES but never gets a typing channel.
    expect(typingChannelNames()).toEqual(['typing:conv-2']);
    expect(subscribeCount('conversation:')).toBe(4);
    expect(state.channels.get('typing:conv-2')?.listeners.get('typing.stopped')).toHaveLength(1);
    expect(result.current.typing).not.toBeNull();
  });

  it('⚠⚠ a burst sends `started` ONCE through the server — the client publishes NOTHING', async () => {
    const { result } = renderTyping({ typingConversationId: 'conv-1' });
    await liveTypingChannel('conv-1');

    await openBurst(result);
    act(() => result.current.typing?.onKeystroke());

    expect(mockSendTyping.mock.calls).toEqual([['conv-1', 'started']]);

    act(() => result.current.typing?.onStopped());
    await waitFor(() =>
      expect(mockSendTyping.mock.calls).toEqual([
        ['conv-1', 'started'],
        ['conv-1', 'stopped'],
      ])
    );
    expect(clientPublishes()).toEqual([]);
  });

  it('⚠⚠ a hostile data payload still yields ONLY the sender clientId — data is never read', async () => {
    const { result } = renderTyping({ typingConversationId: 'conv-1' });
    await liveTypingChannel('conv-1');

    let dataReads = -1;
    act(() => {
      dataReads = emitTyping('conv-1', 'typing.started', 'user-2');
    });

    expect(dataReads).toBe(0);
    expect(result.current.typing?.typingClientIds).toEqual(['user-2']);
  });

  it('⚠ never shows the viewer’s own clientId — this tab or any other tab of theirs (AC5)', async () => {
    const { result } = renderTyping({ typingConversationId: 'conv-1' });
    await liveTypingChannel('conv-1');

    act(() => {
      emitTyping('conv-1', 'typing.started', VIEWER_ID);
      emitTyping('conv-1', 'typing.started', VIEWER_ID);
    });
    expect(result.current.typing?.typingClientIds).toEqual([]);

    // …and the channel IS live, so the empty list above is not vacuous.
    act(() => {
      emitTyping('conv-1', 'typing.started', 'user-2');
    });
    expect(result.current.typing?.typingClientIds).toEqual(['user-2']);
  });

  it('clears a typist on an explicit typing.stopped', async () => {
    const { result } = renderTyping({ typingConversationId: 'conv-1' });
    await liveTypingChannel('conv-1');

    act(() => {
      emitTyping('conv-1', 'typing.started', 'user-2');
    });
    expect(result.current.typing?.typingClientIds).toEqual(['user-2']);
    act(() => {
      emitTyping('conv-1', 'typing.stopped', 'user-2');
    });
    expect(result.current.typing?.typingClientIds).toEqual([]);
  });

  it('⚠ a typist’s MESSAGE landing clears them at once — before their `stopped` arrives', async () => {
    const { result } = renderTyping({ typingConversationId: 'conv-1' });
    await liveTypingChannel('conv-1');
    act(() => {
      emitTyping('conv-1', 'typing.started', 'user-2');
      emitTyping('conv-1', 'typing.started', 'user-3');
    });

    act(() => emit('conversation:conv-1', 'message', messagePayload({ senderUserId: 'user-2' })));

    expect(result.current.typing?.typingClientIds).toEqual(['user-3']);
  });

  it('a message in ANOTHER thread clears nobody here', async () => {
    const { result } = renderTyping({ typingConversationId: 'conv-1' });
    await liveTypingChannel('conv-1');
    act(() => {
      emitTyping('conv-1', 'typing.started', 'user-2');
    });

    act(() =>
      emit(
        'conversation:conv-2',
        'message',
        messagePayload({ conversationId: 'conv-2', senderUserId: 'user-2' })
      )
    );

    expect(result.current.typing?.typingClientIds).toEqual(['user-2']);
  });

  it('⚠⚠ switching the typing thread swaps ONLY the typing channel — same client, no re-subscribe', async () => {
    const { result, rerender } = renderTyping({ typingConversationId: 'conv-1' });
    const first = await liveTypingChannel('conv-1');
    await openBurst(result);
    act(() => {
      emitTyping('conv-1', 'typing.started', 'user-2');
    });
    const client = state.clients[0];
    const messageSubscribes = subscribeCount('conversation:');

    rerender({ typingConversationId: 'conv-2' });

    // The OLD thread is told `stopped` — named by ITS id — and its typists are forgotten.
    await waitFor(() => expect(mockSendTyping).toHaveBeenLastCalledWith('conv-1', 'stopped'));
    expect(first.listeners.get('typing.started')).toHaveLength(0);
    expect(result.current.typing?.typingClientIds).toEqual([]);
    await waitFor(() => expect(client?.released).toEqual(['typing:conv-1']));

    // The new thread's channel is attached on the SAME client.
    expect(state.channels.get('typing:conv-2')?.listeners.get('typing.started')).toHaveLength(1);
    expect(state.clients).toHaveLength(1);
    expect(client?.closed).toBe(false);
    expect(subscribeCount('conversation:')).toBe(messageSubscribes);
    expect(mockTokenAction).not.toHaveBeenCalled();

    // …and a burst there is sent for the NEW thread.
    await waitFor(() => {
      result.current.typing?.onKeystroke();
      expect(mockSendTyping).toHaveBeenLastCalledWith('conv-2', 'started');
    });
    expect(clientPublishes()).toEqual([]);
  });

  it('⚠ unmount mid-burst sends `stopped` through the server, releases the channel and closes', async () => {
    const { result, unmount } = renderTyping({ typingConversationId: 'conv-1' });
    await liveTypingChannel('conv-1');
    await openBurst(result);
    const client = state.clients[0];

    unmount();

    await waitFor(() => expect(mockSendTyping).toHaveBeenLastCalledWith('conv-1', 'stopped'));
    expect(client?.closed).toBe(true);
    await waitFor(() => expect(client?.released).toEqual(['typing:conv-1']));
    expect(clientPublishes()).toEqual([]);
  });

  it('⚠ a client REBUILD (the channel set changed) sends `stopped` — over HTTP, so close() cannot cancel it', async () => {
    const { result, rerender } = renderTyping({ typingConversationId: 'conv-1' });
    await liveTypingChannel('conv-1');
    await openBurst(result);
    const client = state.clients[0];

    rerender({ typingConversationId: 'conv-1', conversationIds: ['conv-1', 'conv-2', 'conv-3'] });

    await waitFor(() => expect(client?.closed).toBe(true));
    await waitFor(() => expect(mockSendTyping).toHaveBeenLastCalledWith('conv-1', 'stopped'));
    expect(clientPublishes()).toEqual([]);
  });

  it('keeps the typing view’s identity across a re-render that changes nothing', async () => {
    const { result, rerender } = renderTyping({ typingConversationId: 'conv-1' });
    await liveTypingChannel('conv-1');
    const before = result.current.typing;

    rerender({ typingConversationId: 'conv-1' });

    expect(result.current.typing).not.toBeNull();
    expect(result.current.typing).toBe(before);
  });

  describe('typing is null — no typing UI at all', () => {
    it('when realtime is disabled (no client either)', () => {
      const { result } = renderTyping({ enabled: false, typingConversationId: 'conv-1' });
      expect(result.current.typing).toBeNull();
      expect(state.clients).toHaveLength(0);
    });

    it.each([
      ['omitted', undefined],
      ['null', null],
    ])(
      'when typingConversationId is %s — and no typing channel is ever attached',
      async (_label, id) => {
        const { result } = renderTyping({ typingConversationId: id });
        await waitFor(() => expect(subscribeCount('conversation:')).toBe(4));
        expect(result.current.typing).toBeNull();
        expect(typingChannelNames()).toEqual([]);
      }
    );

    it('when typingConversationId is NOT one of the subscribed conversations', async () => {
      const { result } = renderTyping({ typingConversationId: 'conv-other' });
      await waitFor(() => expect(subscribeCount('conversation:')).toBe(4));
      expect(result.current.typing).toBeNull();
      expect(typingChannelNames()).toEqual([]);
    });
  });
});
