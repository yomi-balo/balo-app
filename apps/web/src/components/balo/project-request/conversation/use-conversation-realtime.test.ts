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

const mockTokenAction = vi.fn();
vi.mock(
  '@/app/(dashboard)/projects/[requestId]/_actions/create-conversation-realtime-token',
  () => ({
    createConversationRealtimeTokenAction: (...args: unknown[]) => mockTokenAction(...args),
  })
);

import { sanitizeRealtimeBodyHtml, useConversationRealtime } from './use-conversation-realtime';

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
    relationshipId: 'rel-1',
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
    relationshipId: 'rel-1',
    fileName: 'x.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1234,
    uploadedByUserId: 'user-2',
    uploadedByName: 'Priya Nair',
    createdAtIso: '2026-06-10T10:00:00.000Z',
    ...overrides,
  };
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
        requestId: REQUEST_ID,
        relationshipIds: ['rel-1'],
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
        requestId: REQUEST_ID,
        relationshipIds: [],
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
        requestId: REQUEST_ID,
        relationshipIds: ['rel-1', 'rel-2'],
        onMessage: vi.fn(),
        onFile: vi.fn(),
      })
    );
    await waitFor(() => expect(state.clients).toHaveLength(1));
    expect(state.channels.has('conversation:rel-1')).toBe(true);
    expect(state.channels.has('conversation:rel-2')).toBe(true);
    expect(state.channels.get('conversation:rel-1')?.listeners.get('message')).toHaveLength(1);
    expect(state.channels.get('conversation:rel-1')?.listeners.get('file')).toHaveLength(1);
  });

  it('moves connecting → connected → connecting with the connection lifecycle', async () => {
    const { result } = renderHook(() =>
      useConversationRealtime({
        enabled: true,
        requestId: REQUEST_ID,
        relationshipIds: ['rel-1'],
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
        requestId: REQUEST_ID,
        relationshipIds: ['rel-1'],
        onMessage,
        onFile,
      })
    );
    await waitFor(() => expect(state.channels.has('conversation:rel-1')).toBe(true));

    const message = messagePayload();
    act(() => emit('conversation:rel-1', 'message', message));
    expect(onMessage).toHaveBeenCalledWith(message);

    const file = filePayload();
    act(() => emit('conversation:rel-1', 'file', file));
    expect(onFile).toHaveBeenCalledWith(file);

    // Every consumed field is type-checked — partial shapes never reach the island.
    act(() => emit('conversation:rel-1', 'message', 'garbage'));
    act(() => emit('conversation:rel-1', 'message', { nope: true }));
    act(() =>
      emit('conversation:rel-1', 'message', {
        id: 'm-2',
        relationshipId: 'rel-1',
        bodyHtml: '<p>x</p>',
      })
    );
    act(() => emit('conversation:rel-1', 'message', messagePayload({ senderName: 42 })));
    expect(onMessage).toHaveBeenCalledTimes(1);

    act(() =>
      emit('conversation:rel-1', 'file', { id: 'f-2', relationshipId: 'rel-1', fileName: 'y.pdf' })
    );
    act(() => emit('conversation:rel-1', 'file', filePayload({ sizeBytes: 'big' })));
    expect(onFile).toHaveBeenCalledTimes(1);
  });

  it('neutralises hostile bodyHtml before it can reach dangerouslySetInnerHTML', async () => {
    const onMessage = vi.fn();
    renderHook(() =>
      useConversationRealtime({
        enabled: true,
        requestId: REQUEST_ID,
        relationshipIds: ['rel-1'],
        onMessage,
        onFile: vi.fn(),
      })
    );
    await waitFor(() => expect(state.channels.has('conversation:rel-1')).toBe(true));

    const hostile = messagePayload({
      bodyHtml: '<p>hi</p><img src=x onerror=alert(1)><script>alert(2)</script>',
    });
    act(() => emit('conversation:rel-1', 'message', hostile));
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
        requestId: REQUEST_ID,
        relationshipIds: ['rel-1'],
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
        requestId: REQUEST_ID,
        relationshipIds: ['rel-1'],
        onMessage: vi.fn(),
        onFile: vi.fn(),
      })
    );
    await waitFor(() => expect(state.clients).toHaveLength(1));
    unmount();
    expect(state.clients[0]?.closed).toBe(true);
  });
});
