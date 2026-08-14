import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { MeetingRealtimeRegistration } from '@/lib/meetings/meeting-panels';
import type { RealtimeTokenResult } from '@/lib/realtime/ably-auth';
import {
  isMeetingFilePayload,
  MAX_FLOATERS,
  REACTION_FLOAT_MS,
  useMeetingCallRealtime,
  useMeetingRealtime,
} from './use-meeting-realtime';

/**
 * BAL-437 — the ONE Ably client for the whole call.
 *
 * ── ⚠⚠ THE CLAIMS THIS FILE EXISTS TO HOLD ───────────────────────────────────────────────
 *
 *   1. **NO `rewind`.** Ably replays a rewind window on EVERY reattach, so a single reconnect
 *      would re-float every reaction from the last N minutes at once. `channels.get` must be
 *      called with the channel name and NOTHING ELSE. The absence of an argument is exactly the
 *      kind of thing nobody notices in review, so it is asserted.
 *   2. **OWN-NONCE ECHO SUPPRESSION.** Because the SERVER publishes (R2), the sender receives
 *      their own reaction back. Without the dedupe they would see two floats for one tap.
 *   3. **THE `authCallback` ITSELF**, both arms — including the REF-FRESHNESS property that is
 *      the entire justification for holding `fetchToken` in a ref rather than in the effect's
 *      dependency list. That deviation was documented and untested; it is now both.
 *   4. **THE FLOATER LIFECYCLE** — it appears, it is capped, it EXPIRES, and a failed send takes
 *      it back down again. Nothing previously proved a floater ever disappeared.
 */

const MEETING_CHANNEL = 'meeting:0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const CONVERSATION_CHANNEL = 'conversation:3f2504e0-4f89-41d3-9a0c-0305e82c3301';

interface FakeChannel {
  subscribe: ReturnType<typeof vi.fn>;
  handlers: Map<string, (msg: { data: unknown }) => void>;
}

const { channels, connectionHandlers, close, realtimeOptions, getCalls } = vi.hoisted(() => ({
  channels: new Map<string, FakeChannel>(),
  connectionHandlers: new Map<string, () => void>(),
  close: vi.fn(),
  realtimeOptions: { current: undefined as unknown },
  /** ⚠ EVERY argument list `channels.get` was called with — this is the `rewind` guard. */
  getCalls: [] as unknown[][],
}));

vi.mock('ably', () => {
  class Realtime {
    connection = {
      on: (state: string, handler: () => void) => connectionHandlers.set(state, handler),
    };
    channels = {
      get: (...args: unknown[]) => {
        getCalls.push(args);
        const name = String(args[0]);
        let channel = channels.get(name);
        if (channel === undefined) {
          const handlers = new Map<string, (msg: { data: unknown }) => void>();
          channel = {
            handlers,
            subscribe: vi.fn((event: string, handler: (msg: { data: unknown }) => void) => {
              handlers.set(event, handler);
              return Promise.resolve();
            }),
          };
          channels.set(name, channel);
        }
        return channel;
      },
    };
    close = close;
    constructor(options: unknown) {
      realtimeOptions.current = options;
    }
  }
  return { Realtime };
});

function registration(
  overrides: Partial<MeetingRealtimeRegistration> = {}
): MeetingRealtimeRegistration {
  return {
    fetchToken: vi.fn().mockResolvedValue({ success: false, disabled: true }),
    sendReaction: vi.fn().mockResolvedValue({ success: true }),
    meetingChannel: MEETING_CHANNEL,
    conversationChannel: CONVERSATION_CHANNEL,
    ...overrides,
  };
}

/** Deliver an inbound payload on `channel`'s `event` handler, inside `act`. */
async function deliver(channel: string, event: string, data: unknown): Promise<void> {
  const handler = channels.get(channel)?.handlers.get(event);
  expect(handler).toBeDefined();
  await act(async () => {
    handler?.({ data });
  });
}

/** The frame's two callbacks, with the user-facing one filled in per test. */
function callRealtimeInput(
  overrides: Partial<Parameters<typeof useMeetingCallRealtime>[0]> = {}
): Parameters<typeof useMeetingCallRealtime>[0] {
  return {
    registration: registration(),
    isChatOpen: false,
    onReactionSent: vi.fn(),
    onReactionError: vi.fn(),
    ...overrides,
  };
}

/**
 * The `authCallback` the hook handed to the Ably constructor.
 *
 * ⚠ IT IS READ OFF THE **CONSTRUCTOR OPTIONS**, which is the only place it exists — the hook
 * never exposes it. Every arm below drives it exactly as ably-js does: node-callback style, on
 * connect and again on every refresh.
 */
function capturedAuthCallback(): (
  params: unknown,
  callback: (error: unknown, token: unknown) => void
) => void {
  const options = realtimeOptions.current as
    | {
        authCallback?: (
          params: unknown,
          callback: (error: unknown, token: unknown) => void
        ) => void;
      }
    | undefined;
  const authCallback = options?.authCallback;
  expect(authCallback).toBeDefined();
  // ⚠ NARROWED BY THE ASSERTION ABOVE — `noUncheckedIndexedAccess` friendly, no `!`.
  if (authCallback === undefined) throw new Error('no authCallback');
  return authCallback;
}

/** Invoke the captured `authCallback` and resolve with what it reported. */
async function runAuthCallback(): Promise<{ error: unknown; token: unknown }> {
  return new Promise((resolve) => {
    capturedAuthCallback()({}, (error, token) => resolve({ error, token }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  channels.clear();
  connectionHandlers.clear();
  getCalls.length = 0;
  realtimeOptions.current = undefined;
});

afterEach(() => {
  // ⚠ ONE TEST BELOW RUNS ON FAKE TIMERS. Restoring here rather than inside it means a failing
  // assertion cannot leave every later file running on a clock that is not the real one.
  vi.useRealTimers();
});

describe('useMeetingRealtime — ⚠⚠ an UNSTABLE registration must not flap the connection', () => {
  it('a fresh `fetchToken` on every render creates the client ONCE, not once per render', async () => {
    const { rerender } = renderHook(() =>
      // ⚠ DELIBERATELY UNSTABLE — a brand-new `fetchToken` identity on every render, which is
      // what a caller who forgets to memoise produces. The hook holds it in a ref precisely so
      // this cannot tear the connection down.
      useMeetingRealtime({
        registration: registration(),
        onMessage: vi.fn(),
        onFile: vi.fn(),
        onReaction: vi.fn(),
      })
    );

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    rerender();
    rerender();

    expect(close).not.toHaveBeenCalled();
  });
});

describe('useMeetingRealtime — the subscriptions', () => {
  it('subscribes BOTH channels with the right event names', async () => {
    renderHook(() =>
      useMeetingRealtime({
        registration: registration(),
        onMessage: vi.fn(),
        onFile: vi.fn(),
        onReaction: vi.fn(),
      })
    );

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    await waitFor(() => expect(channels.has(CONVERSATION_CHANNEL)).toBe(true));

    const meeting = channels.get(MEETING_CHANNEL);
    expect(meeting?.handlers.has('reaction')).toBe(true);
    expect(meeting?.handlers.has('file')).toBe(true);
    expect(channels.get(CONVERSATION_CHANNEL)?.handlers.has('message')).toBe(true);
  });

  it('⚠⚠ passes NO `params` to `channels.get` — the `rewind` prohibition, asserted', async () => {
    renderHook(() =>
      useMeetingRealtime({
        registration: registration(),
        onMessage: vi.fn(),
        onFile: vi.fn(),
        onReaction: vi.fn(),
      })
    );

    await waitFor(() => expect(getCalls.length).toBeGreaterThan(0));
    for (const args of getCalls) {
      // A second argument is where `{ params: { rewind: '2m' } }` would live.
      expect(args).toHaveLength(1);
    }
  });

  it('⚠ subscribes ONLY the meeting channel when there is no anchor', async () => {
    renderHook(() =>
      useMeetingRealtime({
        registration: registration({ conversationChannel: null }),
        onMessage: vi.fn(),
        onFile: vi.fn(),
        onReaction: vi.fn(),
      })
    );

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    expect(channels.has(CONVERSATION_CHANNEL)).toBe(false);
  });

  it('⚠ `registration: null` ⇒ terminal `disabled`, NO client at all', () => {
    const { result } = renderHook(() =>
      useMeetingRealtime({
        registration: null,
        onMessage: vi.fn(),
        onFile: vi.fn(),
        onReaction: vi.fn(),
      })
    );

    expect(result.current.status).toBe('disabled');
    expect(realtimeOptions.current).toBeUndefined();
  });

  it('closes the client on unmount — no connection leak per call', async () => {
    const { unmount } = renderHook(() =>
      useMeetingRealtime({
        registration: registration(),
        onMessage: vi.fn(),
        onFile: vi.fn(),
        onReaction: vi.fn(),
      })
    );

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    unmount();

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('useMeetingRealtime — connection state', () => {
  it.each([
    ['connected', 'connected'],
    ['failed', 'failed'],
    // ⚠⚠ A DROP **BEFORE** THE FIRST `connected` IS STILL THE FIRST CONNECT. The copy the panel
    // shows for `connecting` says so ("Connecting live updates…"); saying "Reconnecting…" to
    // somebody in their first second on a call claims something already broke.
    ['disconnected', 'connecting'],
    ['suspended', 'connecting'],
  ])('maps `%s` to status `%s` BEFORE any successful connect', async (event, expected) => {
    /**
     * ⚠⚠ THE REGISTRATION IS BUILT **ONCE**, OUTSIDE THE HOOK CALLBACK, AND THAT IS PART OF
     * WHAT THIS TEST PROVES. An inline `registration()` mints a fresh `fetchToken` on every
     * render; before the hook held that function in a REF, the resulting effect re-run tore the
     * client down and reset the status to `connecting` the instant `connected` set it — i.e.
     * flapping connectivity that no assertion elsewhere would have caught.
     */
    const stable = registration();
    const { result } = renderHook(() =>
      useMeetingRealtime({
        registration: stable,
        onMessage: vi.fn(),
        onFile: vi.fn(),
        onReaction: vi.fn(),
      })
    );

    await waitFor(() => expect(connectionHandlers.has(event)).toBe(true));
    await act(async () => {
      connectionHandlers.get(event)?.();
    });

    expect(result.current.status).toBe(expected);
  });

  it.each(['disconnected', 'suspended'])(
    '⚠⚠ maps `%s` to `reconnecting` ONCE THE CONNECTION HAS BEEN UP',
    async (event) => {
      const stable = registration();
      const { result } = renderHook(() =>
        useMeetingRealtime({
          registration: stable,
          onMessage: vi.fn(),
          onFile: vi.fn(),
          onReaction: vi.fn(),
        })
      );

      await waitFor(() => expect(connectionHandlers.has('connected')).toBe(true));
      await act(async () => {
        connectionHandlers.get('connected')?.();
      });
      expect(result.current.status).toBe('connected');

      await act(async () => {
        connectionHandlers.get(event)?.();
      });

      expect(result.current.status).toBe('reconnecting');
    }
  );

  it('⚠ the FIRST render is `connecting`, never `reconnecting`', async () => {
    const { result } = renderHook(() =>
      useMeetingRealtime({
        registration: registration(),
        onMessage: vi.fn(),
        onFile: vi.fn(),
        onReaction: vi.fn(),
      })
    );

    expect(result.current.status).toBe('connecting');
    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
  });
});

describe('useMeetingRealtime — ⚠⚠ the third-party trust boundary', () => {
  it('drops a reaction that is not a member of the closed set', async () => {
    const onReaction = vi.fn();
    renderHook(() =>
      useMeetingRealtime({
        registration: registration(),
        onMessage: vi.fn(),
        onFile: vi.fn(),
        onReaction,
      })
    );

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    await deliver(MEETING_CHANNEL, 'reaction', { emoji: '💀', nonce: 'n1' });
    await deliver(MEETING_CHANNEL, 'reaction', { emoji: '👍' });

    expect(onReaction).not.toHaveBeenCalled();
  });

  it('re-sanitises an inbound message body before it can reach dangerouslySetInnerHTML', async () => {
    const onMessage = vi.fn();
    renderHook(() =>
      useMeetingRealtime({
        registration: registration(),
        onMessage,
        onFile: vi.fn(),
        onReaction: vi.fn(),
      })
    );

    await waitFor(() => expect(channels.has(CONVERSATION_CHANNEL)).toBe(true));
    await deliver(CONVERSATION_CHANNEL, 'message', {
      id: 'm1',
      conversationId: 'c1',
      bodyHtml: '<img src=x onerror=alert(1)><p>hi</p>',
      senderUserId: 'u1',
      senderName: 'Dana',
      createdAtIso: '2026-08-14T09:00:00.000Z',
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const [payload] = onMessage.mock.calls[0] ?? [];
    expect((payload as { bodyHtml: string }).bodyHtml).not.toContain('<img');
    expect((payload as { bodyHtml: string }).bodyHtml).toContain('<p>hi</p>');
  });

  it('drops a structurally invalid file payload', async () => {
    const onFile = vi.fn();
    renderHook(() =>
      useMeetingRealtime({
        registration: registration(),
        onMessage: vi.fn(),
        onFile,
        onReaction: vi.fn(),
      })
    );

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    await deliver(MEETING_CHANNEL, 'file', { id: 'f1', fileName: 'x.pdf' });

    expect(onFile).not.toHaveBeenCalled();
  });
});

describe('isMeetingFilePayload', () => {
  const VALID = {
    id: 'f1',
    meetingId: 'm1',
    fileName: 'deck.pdf',
    contentType: 'application/pdf',
    sizeBytes: 100,
    party: 'client',
    source: 'chat',
    uploadedByUserId: 'u1',
    createdAtIso: '2026-08-14T09:00:00.000Z',
  };

  it('accepts a complete row', () => {
    expect(isMeetingFilePayload(VALID)).toBe(true);
  });

  it('rejects a missing field and a wrong-typed size', () => {
    expect(isMeetingFilePayload({ ...VALID, fileName: undefined })).toBe(false);
    expect(isMeetingFilePayload({ ...VALID, sizeBytes: '100' })).toBe(false);
  });

  it('rejects null and arrays', () => {
    expect(isMeetingFilePayload(null)).toBe(false);
    expect(isMeetingFilePayload([VALID])).toBe(false);
  });
});

describe('useMeetingCallRealtime — ⚠⚠ the frame-level state', () => {
  it('⚠⚠ DROPS THE SENDER’S OWN ECHO by nonce — one tap, one float', async () => {
    const sendReaction = vi.fn().mockResolvedValue({ success: true });
    const { result } = renderHook(() =>
      useMeetingCallRealtime(callRealtimeInput({ registration: registration({ sendReaction }) }))
    );

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));

    act(() => result.current.sendReaction('👍'));
    // The optimistic float is already up.
    expect(result.current.floaters).toHaveLength(1);

    const [[sent]] = sendReaction.mock.calls as [[{ emoji: string; nonce: string }]];
    // The server fans the SAME nonce back to everyone, including us.
    await deliver(MEETING_CHANNEL, 'reaction', { emoji: sent.emoji, nonce: sent.nonce });

    expect(result.current.floaters).toHaveLength(1);
  });

  it('floats a reaction from SOMEBODY ELSE', async () => {
    const { result } = renderHook(() => useMeetingCallRealtime(callRealtimeInput()));

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    await deliver(MEETING_CHANNEL, 'reaction', {
      emoji: '🎉',
      nonce: 'b1c2d3e4-0000-4000-8000-000000000001',
    });

    expect(result.current.floaters).toHaveLength(1);
    expect(result.current.floaters[0]?.emoji).toBe('🎉');
  });

  it('⚠ an inbound file bumps `fileRevision` — the Files panel’s real invalidation', async () => {
    const { result } = renderHook(() => useMeetingCallRealtime(callRealtimeInput()));

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    expect(result.current.fileRevision).toBe(0);

    await deliver(MEETING_CHANNEL, 'file', {
      id: 'f1',
      meetingId: 'm1',
      fileName: 'deck.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      party: 'client',
      source: 'chat',
      uploadedByUserId: 'u1',
      createdAtIso: '2026-08-14T09:00:00.000Z',
    });

    expect(result.current.fileRevision).toBe(1);
    expect(result.current.fileFeed).toHaveLength(1);
  });

  it('⚠ exposes NO `clearUnreadChat` — the `isChatOpen` effect is the only clearer', async () => {
    // The field existed with ZERO consumers. Asserting its absence is what stops it coming back
    // as a second answer to a question that already has one.
    const { result } = renderHook(() => useMeetingCallRealtime(callRealtimeInput()));

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    expect(result.current).not.toHaveProperty('clearUnreadChat');
  });
});

describe('useMeetingCallRealtime — ⚠⚠ the send outcome reaches BOTH the analytics sink and the person', () => {
  it('reports `ok` on a successful send, and the float stays up', async () => {
    const onReactionSent = vi.fn();
    const onReactionError = vi.fn();
    const { result } = renderHook(() =>
      useMeetingCallRealtime(
        callRealtimeInput({
          registration: registration({
            sendReaction: vi.fn().mockResolvedValue({ success: true }),
          }),
          onReactionSent,
          onReactionError,
        })
      )
    );

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    await act(async () => {
      result.current.sendReaction('👏');
    });

    await waitFor(() => expect(onReactionSent).toHaveBeenCalledWith('👏', 'ok'));
    // ⚠ THE SUCCESS PATH SAYS NOTHING TO THE PERSON. The float IS the feedback.
    expect(onReactionError).not.toHaveBeenCalled();
    expect(result.current.floaters).toHaveLength(1);
  });

  it('reports the FAILED outcome for analytics, with the glyph', async () => {
    const onReactionSent = vi.fn();
    const { result } = renderHook(() =>
      useMeetingCallRealtime(
        callRealtimeInput({
          registration: registration({
            sendReaction: vi.fn().mockResolvedValue({ success: false, error: 'nope' }),
          }),
          onReactionSent,
        })
      )
    );

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    await act(async () => {
      result.current.sendReaction('😮');
    });

    await waitFor(() => expect(onReactionSent).toHaveBeenCalledWith('😮', 'failed'));
  });

  it('⚠⚠ A FAILED SEND **REMOVES THE OPTIMISTIC FLOAT** and says so — never a silent swallow', async () => {
    // The float has already risen by the time the action answers. Leaving it up tells the sender
    // the room saw something the room never received.
    const onReactionError = vi.fn();
    const { result } = renderHook(() =>
      useMeetingCallRealtime(
        callRealtimeInput({
          registration: registration({
            sendReaction: vi.fn().mockResolvedValue({ success: false, error: 'Could not send.' }),
          }),
          onReactionError,
        })
      )
    );

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    await act(async () => {
      result.current.sendReaction('👍');
    });

    await waitFor(() => expect(result.current.floaters).toHaveLength(0));
    expect(onReactionError).toHaveBeenCalledWith('That reaction did not reach the call.');
  });

  it('⚠⚠ SURFACES THE SIGNED-OUT CASE EXPLICITLY — their next message would fail the same way', async () => {
    const onReactionError = vi.fn();
    const { result } = renderHook(() =>
      useMeetingCallRealtime(
        callRealtimeInput({
          registration: registration({
            // ⚠ THE ACTION'S OWN LITERAL, verbatim — this is the string the seam matches on.
            sendReaction: vi
              .fn()
              .mockResolvedValue({ success: false, error: 'You are not signed in.' }),
          }),
          onReactionError,
        })
      )
    );

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    await act(async () => {
      result.current.sendReaction('👍');
    });

    await waitFor(() => expect(onReactionError).toHaveBeenCalledTimes(1));
    const [[message]] = onReactionError.mock.calls as [[string]];
    expect(message).toContain('session ended');
    // ⚠ IT MUST NAME THE REMEDY, not just the fact — this is the cheap failure that warns them
    // about the expensive one.
    expect(message).toContain('Reload this page');
    expect(result.current.floaters).toHaveLength(0);
  });

  it('a THROWN send is treated exactly like a refused one', async () => {
    const onReactionError = vi.fn();
    const { result } = renderHook(() =>
      useMeetingCallRealtime(
        callRealtimeInput({
          registration: registration({
            sendReaction: vi.fn().mockRejectedValue(new Error('offline')),
          }),
          onReactionError,
        })
      )
    );

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    await act(async () => {
      result.current.sendReaction('👍');
    });

    await waitFor(() => expect(result.current.floaters).toHaveLength(0));
    expect(onReactionError).toHaveBeenCalledWith('That reaction did not reach the call.');
  });
});

describe('useMeetingCallRealtime — ⚠⚠ the floater lifecycle', () => {
  it('⚠⚠ the cooldown bounds the NETWORK CALL, and the second tap STILL FLOATS', async () => {
    // ⚠ THE OLD BEHAVIOUR RETURNED BEFORE THE FLOAT, so a second tap inside 600ms produced no
    // float, no toast and no analytics event — a control that visibly did nothing.
    const sendReaction = vi.fn().mockResolvedValue({ success: true });
    const { result } = renderHook(() =>
      useMeetingCallRealtime(callRealtimeInput({ registration: registration({ sendReaction }) }))
    );

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));

    act(() => result.current.sendReaction('👍'));
    act(() => result.current.sendReaction('👍'));

    // One fan-out — two taps 600ms apart are one gesture.
    expect(sendReaction).toHaveBeenCalledTimes(1);
    // ⚠ BUT BOTH TAPS ARE VISIBLE TO THE PERSON WHO MADE THEM.
    expect(result.current.floaters).toHaveLength(2);
  });

  it(`⚠⚠ a floater EXPIRES after REACTION_FLOAT_MS (${REACTION_FLOAT_MS}ms)`, async () => {
    /**
     * ⚠ NOTHING ELSE IN THIS FILE PROVES A FLOATER EVER DISAPPEARS. Without it the cap below is
     * the only thing standing between a long call and an unbounded overlay.
     *
     * ⚠⚠ **THE FAKE CLOCK IS INSTALLED BEFORE THE HOOK MOUNTS, AND THE EARLIER VERSION OF THIS
     * TEST INSTALLED IT AFTER — WHICH IS WHY IT FAILED.** `pushFloater` arms the expiry with
     * whatever `setTimeout` was global AT THE MOMENT THE FLOATER WAS PUSHED. A timeout already
     * scheduled on the real clock is not adopted by `vi.useFakeTimers()`, so
     * `advanceTimersByTime` could not reach it however far it was advanced, and the floater was
     * still there. The comment it carried ("armed after the async setup, because `waitFor` polls
     * on timers") had the right worry and the wrong remedy.
     *
     * ⚠⚠ **`shouldAdvanceTime` IS WHAT MAKES INSTALLING IT EARLY SURVIVABLE, AND IT IS NOT
     * OPTIONAL HERE.** The worry in the old comment was real, just misdiagnosed: it is not
     * `waitFor`'s polling that a frozen clock stalls, it is Testing Library's `asyncWrapper`,
     * which awaits its own `setTimeout(resolve, 0)` after every async helper. Under a hard freeze
     * that timeout never fires and the FIRST `waitFor` hangs until vitest's 5s timeout — which is
     * exactly what a naive "arm the fake clock first" fix does. `shouldAdvanceTime` lets the fake
     * clock creep forward in real time, so those zero-delay flushes still land while
     * `advanceTimersByTime` remains available for the 2.2s jump this test actually needs.
     */
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useMeetingCallRealtime(callRealtimeInput()));

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));
    await deliver(MEETING_CHANNEL, 'reaction', {
      emoji: '👍',
      nonce: 'c1c2d3e4-0000-4000-8000-000000000001',
    });
    expect(result.current.floaters).toHaveLength(1);

    // ⚠ IT DOES NOT VANISH IMMEDIATELY — otherwise "expires after 2200ms" would also be satisfied
    // by a floater that never rendered long enough to be seen. ⚠ A COARSE 100ms rather than
    // `REACTION_FLOAT_MS - 1`, deliberately: `shouldAdvanceTime` means tens of milliseconds of
    // real time have already been folded into the clock, so an assertion one tick below the
    // deadline would be a flake generator. 100ms is nowhere near 2200 and proves the same thing.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.floaters).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(REACTION_FLOAT_MS);
    });
    expect(result.current.floaters).toHaveLength(0);
  });

  it(`⚠ a burst is CAPPED at MAX_FLOATERS (${MAX_FLOATERS}) — newest kept, oldest dropped`, async () => {
    const { result } = renderHook(() => useMeetingCallRealtime(callRealtimeInput()));

    await waitFor(() => expect(channels.has(MEETING_CHANNEL)).toBe(true));

    const burst = MAX_FLOATERS + 3;
    for (let index = 0; index < burst; index += 1) {
      // ⚠ SEQUENTIAL ON PURPOSE — each delivery is its own `act`, so the state settles between
      // them and the cap is exercised on real successive updates rather than one batch.
      // (No `eslint-disable` for `no-await-in-loop`: the rule is not enabled in this config, and
      // the unused directive is itself a warning under web's `--max-warnings 0`.)
      await deliver(MEETING_CHANNEL, 'reaction', {
        emoji: '👍',
        nonce: `d1c2d3e4-0000-4000-8000-00000000${String(index).padStart(4, '0')}`,
      });
    }

    expect(result.current.floaters).toHaveLength(MAX_FLOATERS);
    // Newest-last: the survivor at the end is the LAST one delivered.
    expect(result.current.floaters.at(-1)?.nonce).toContain(String(burst - 1).padStart(4, '0'));
  });
});

describe('useMeetingRealtime — ⚠⚠ the authCallback, both arms', () => {
  const TOKEN_REQUEST = { keyName: 'app.key', nonce: 'n', mac: 'm' };

  it('a successful fetch reports `(null, tokenRequest)` on Ably’s node-callback contract', async () => {
    const fetchToken = vi
      .fn<() => Promise<RealtimeTokenResult>>()
      .mockResolvedValue({ success: true, tokenRequest: TOKEN_REQUEST } as RealtimeTokenResult);
    renderHook(() =>
      useMeetingRealtime({
        registration: registration({ fetchToken }),
        onMessage: vi.fn(),
        onFile: vi.fn(),
        onReaction: vi.fn(),
      })
    );

    await waitFor(() => expect(realtimeOptions.current).toBeDefined());
    const reported = await runAuthCallback();

    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(reported).toEqual({ error: null, token: TOKEN_REQUEST });
  });

  it('a refused fetch reports the action’s error string, and NO token', async () => {
    const fetchToken = vi
      .fn<() => Promise<RealtimeTokenResult>>()
      .mockResolvedValue({ success: false, error: 'You do not have access to this call.' });
    renderHook(() =>
      useMeetingRealtime({
        registration: registration({ fetchToken }),
        onMessage: vi.fn(),
        onFile: vi.fn(),
        onReaction: vi.fn(),
      })
    );

    await waitFor(() => expect(realtimeOptions.current).toBeDefined());

    expect(await runAuthCallback()).toEqual({
      error: 'You do not have access to this call.',
      token: null,
    });
  });

  it('⚠ `disabled: true` (no ABLY_API_KEY) reports the fallback label, not `undefined`', async () => {
    renderHook(() =>
      useMeetingRealtime({
        registration: registration(),
        onMessage: vi.fn(),
        onFile: vi.fn(),
        onReaction: vi.fn(),
      })
    );

    await waitFor(() => expect(realtimeOptions.current).toBeDefined());

    // The default `registration()` fetcher answers `{ success: false, disabled: true }`.
    expect(await runAuthCallback()).toEqual({ error: 'Realtime disabled', token: null });
  });

  it('⚠⚠ NO fetcher at all ⇒ `callback("Realtime disabled", null)` — the defensive arm', async () => {
    /**
     * ⚠ THE CAST IS DELIBERATE AND IS THE POINT. `fetchToken` is REQUIRED on
     * `MeetingRealtimeRegistration`, so this state is unreachable through the type — which is
     * exactly why the branch would otherwise never be executed by any test and could rot into
     * an unhandled `undefined is not a function` if the type ever loosened. It is a defensive
     * arm; a defensive arm nobody runs is decoration.
     */
    const broken = {
      ...registration(),
      fetchToken: undefined,
    } as unknown as MeetingRealtimeRegistration;
    renderHook(() =>
      useMeetingRealtime({
        registration: broken,
        onMessage: vi.fn(),
        onFile: vi.fn(),
        onReaction: vi.fn(),
      })
    );

    await waitFor(() => expect(realtimeOptions.current).toBeDefined());

    expect(await runAuthCallback()).toEqual({ error: 'Realtime disabled', token: null });
  });

  it('⚠⚠ USES THE **CURRENT** FETCHER ON A REFRESH — the whole justification for the ref', async () => {
    /**
     * ⚠⚠ THIS IS THE ASSERTION THAT EARNS THE DEVIATION. The shipped conversation hook makes
     * `fetchToken` an effect DEPENDENCY; this one holds it in a ref so an unmemoised caller
     * cannot flap the connection. The ref is only *more* correct if it also hands ably-js the
     * CURRENT function when the token expires 15 minutes later — otherwise it would be a
     * stale-closure bug wearing a performance argument. So: re-render with a NEW fetcher, then
     * invoke `authCallback` as a refresh would, and assert the NEW one ran.
     */
    const first = vi
      .fn<() => Promise<RealtimeTokenResult>>()
      .mockResolvedValue({ success: false, error: 'first' });
    const second = vi
      .fn<() => Promise<RealtimeTokenResult>>()
      .mockResolvedValue({ success: false, error: 'second' });

    const { rerender } = renderHook(
      ({ fetchToken }: { fetchToken: () => Promise<RealtimeTokenResult> }) =>
        useMeetingRealtime({
          // ⚠ THE CHANNELS ARE IDENTICAL ACROSS BOTH RENDERS, so the effect does NOT re-run and
          // the client is NOT rebuilt — which is precisely the situation the ref exists for.
          registration: registration({ fetchToken }),
          onMessage: vi.fn(),
          onFile: vi.fn(),
          onReaction: vi.fn(),
        }),
      { initialProps: { fetchToken: first } }
    );

    await waitFor(() => expect(realtimeOptions.current).toBeDefined());

    await act(async () => {
      rerender({ fetchToken: second });
    });

    expect(close).not.toHaveBeenCalled();
    expect(await runAuthCallback()).toEqual({ error: 'second', token: null });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

describe('useMeetingCallRealtime — ⚠ the unread dot', () => {
  const MESSAGE = {
    id: 'm1',
    conversationId: 'c1',
    bodyHtml: '<p>hi</p>',
    senderUserId: 'u1',
    senderName: 'Dana',
    createdAtIso: '2026-08-14T09:00:00.000Z',
  };

  it('sets when a message arrives with the panel CLOSED', async () => {
    const { result } = renderHook(() => useMeetingCallRealtime(callRealtimeInput()));

    await waitFor(() => expect(channels.has(CONVERSATION_CHANNEL)).toBe(true));
    await deliver(CONVERSATION_CHANNEL, 'message', MESSAGE);

    expect(result.current.unreadChat).toBe(true);
    expect(result.current.chatFeed).toHaveLength(1);
  });

  it('⚠ does NOT set while the panel is OPEN — they are looking at it', async () => {
    const { result } = renderHook(() =>
      useMeetingCallRealtime(callRealtimeInput({ isChatOpen: true }))
    );

    await waitFor(() => expect(channels.has(CONVERSATION_CHANNEL)).toBe(true));
    await deliver(CONVERSATION_CHANNEL, 'message', MESSAGE);

    expect(result.current.unreadChat).toBe(false);
  });

  it('clears when the panel opens', async () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) =>
        useMeetingCallRealtime(callRealtimeInput({ isChatOpen: open })),
      { initialProps: { open: false } }
    );

    await waitFor(() => expect(channels.has(CONVERSATION_CHANNEL)).toBe(true));
    await deliver(CONVERSATION_CHANNEL, 'message', MESSAGE);
    expect(result.current.unreadChat).toBe(true);

    await act(async () => {
      rerender({ open: true });
    });

    expect(result.current.unreadChat).toBe(false);
  });

  it('⚠ the feed dedupes by id — a redelivery does not grow it', async () => {
    const { result } = renderHook(() => useMeetingCallRealtime(callRealtimeInput()));

    await waitFor(() => expect(channels.has(CONVERSATION_CHANNEL)).toBe(true));
    await deliver(CONVERSATION_CHANNEL, 'message', MESSAGE);
    await deliver(CONVERSATION_CHANNEL, 'message', MESSAGE);

    expect(result.current.chatFeed).toHaveLength(1);
  });
});
