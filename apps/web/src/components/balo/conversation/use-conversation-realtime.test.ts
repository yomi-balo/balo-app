import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';

type Listener = (msg: { data: unknown }) => void;

const { state, MockRealtime } = vi.hoisted(() => {
  interface ChannelStub {
    name: string;
    listeners: Map<string, Listener[]>;
    subscribe: (event: string, listener: Listener) => Promise<void>;
  }
  const state = {
    clients: [] as InstanceType<typeof MockRealtime>[],
    channels: new Map<string, ChannelStub>(),
  };
  class MockRealtime {
    options: Record<string, unknown>;
    closed = false;
    connectionListeners = new Map<string, (() => void)[]>();
    connection = {
      on: (event: string, cb: () => void): void => {
        const list = this.connectionListeners.get(event) ?? [];
        list.push(cb);
        this.connectionListeners.set(event, list);
      },
    };
    channels = {
      get: (name: string): ChannelStub => {
        let channel = state.channels.get(name);
        if (!channel) {
          channel = {
            name,
            listeners: new Map<string, Listener[]>(),
            subscribe(event: string, listener: Listener) {
              const list = this.listeners.get(event) ?? [];
              list.push(listener);
              this.listeners.set(event, list);
              return Promise.resolve();
            },
          };
          state.channels.set(name, channel);
        }
        return channel;
      },
    };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      state.clients.push(this);
    }
    close(): void {
      this.closed = true;
    }
    emitConnection(event: string): void {
      for (const cb of this.connectionListeners.get(event) ?? []) cb();
    }
  }
  return { state, MockRealtime };
});

vi.mock('ably', () => ({ Realtime: MockRealtime }));

/**
 * ⚠ BAL-421 — the hook no longer IMPORTS a token action; each surface INJECTS one. So this
 * is a plain spy passed as the `fetchToken` prop rather than a module mock. The assertions
 * below are unchanged in substance: the hook still calls its fetcher exactly when it should.
 */
const mockTokenAction = vi.fn();

import {
  sanitizeRealtimeBodyHtml,
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
