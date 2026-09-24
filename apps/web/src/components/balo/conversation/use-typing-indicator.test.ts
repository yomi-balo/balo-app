import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { TypingSignal } from '@/lib/realtime/channels';
import {
  TYPING_HEARTBEAT_MS,
  TYPING_IDLE_STOP_MS,
  TYPING_RECEIVER_EXPIRY_MS,
  useTypingIndicator,
  type TypingIndicator,
} from './use-typing-indicator';

/**
 * The "typing…" state machine, driven entirely by fake timers.
 *
 * ⚠ THE RECEIVER EXPIRY IS THE PART MOST LIKELY TO BE SUBTLY WRONG. It is the only thing that
 * clears the indicator when `typing.stopped` never arrives (killed tab, dropped connection), it
 * must count from the LATEST `started` rather than the first, a cancelled timer must never
 * fire against a re-added id, and a heartbeat for a present id must not produce a new array
 * (a new array re-renders the surface and re-announces the live region every 10 s).
 */

type Publish = (signal: TypingSignal) => boolean;

/** A publish whose every signal is SENT — a live channel on a `connected` connection. */
function sentPublish(): ReturnType<typeof vi.fn<Publish>> {
  return vi.fn<Publish>(() => true);
}

const KEYSTROKE_GAP_MS = 500;

function renderMachine(publish: Publish | null): {
  current: () => TypingIndicator;
  renders: () => number;
  rerender: (next: { publish: Publish | null }) => void;
  unmount: () => void;
} {
  let renderCount = 0;
  const hook = renderHook(
    (props: { publish: Publish | null }) => {
      renderCount += 1;
      return useTypingIndicator(props);
    },
    { initialProps: { publish } }
  );
  return {
    current: () => hook.result.current,
    renders: () => renderCount,
    rerender: (next) => hook.rerender(next),
    unmount: () => hook.unmount(),
  };
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Keystrokes every {@link KEYSTROKE_GAP_MS}, starting now, spanning `durationMs`. */
function typeContinuously(machine: { current: () => TypingIndicator }, durationMs: number): void {
  for (let elapsed = 0; elapsed < durationMs; elapsed += KEYSTROKE_GAP_MS) {
    act(() => machine.current().onKeystroke());
    advance(KEYSTROKE_GAP_MS);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('timing constants', () => {
  it('pins Ably Chat’s heartbeat and expiry, and an idle stop inside the ~2 s AC', () => {
    expect(TYPING_HEARTBEAT_MS).toBe(10_000);
    expect(TYPING_RECEIVER_EXPIRY_MS).toBe(12_000);
    expect(TYPING_IDLE_STOP_MS).toBe(1_500);
  });
});

describe('sender', () => {
  it('publishes "started" exactly once on the first keystroke', () => {
    const publish = sentPublish();
    const machine = renderMachine(publish);

    act(() => machine.current().onKeystroke());

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('started');
  });

  it('publishes nothing more for further keystrokes inside the burst', () => {
    const publish = sentPublish();
    const machine = renderMachine(publish);

    act(() => machine.current().onKeystroke());
    advance(200);
    act(() => machine.current().onKeystroke());
    advance(200);
    act(() => machine.current().onKeystroke());

    expect(publish.mock.calls).toEqual([['started']]);
  });

  it('heartbeats "started" at exactly TYPING_HEARTBEAT_MS of continuous typing, not before', () => {
    const publish = sentPublish();
    const machine = renderMachine(publish);

    typeContinuously(machine, TYPING_HEARTBEAT_MS - KEYSTROKE_GAP_MS);
    // 9 500 ms elapsed, keystrokes every 500 ms: still only the opening "started".
    act(() => machine.current().onKeystroke());
    advance(KEYSTROKE_GAP_MS - 1);
    expect(publish.mock.calls).toEqual([['started']]);

    advance(1);
    expect(publish.mock.calls).toEqual([['started'], ['started']]);
  });

  it('keeps heartbeating every TYPING_HEARTBEAT_MS for as long as the burst lasts', () => {
    const publish = sentPublish();
    const machine = renderMachine(publish);

    typeContinuously(machine, 3 * TYPING_HEARTBEAT_MS);

    expect(publish.mock.calls).toEqual([['started'], ['started'], ['started'], ['started']]);
    expect(publish).not.toHaveBeenCalledWith('stopped');
  });

  it('publishes "stopped" TYPING_IDLE_STOP_MS after the LAST keystroke, not before', () => {
    const publish = sentPublish();
    const machine = renderMachine(publish);

    act(() => machine.current().onKeystroke());
    advance(1_000);
    act(() => machine.current().onKeystroke());
    advance(TYPING_IDLE_STOP_MS - 1);
    expect(publish.mock.calls).toEqual([['started']]);

    advance(1);
    expect(publish.mock.calls).toEqual([['started'], ['stopped']]);
  });

  it('stops heartbeating after an idle stop, and a new keystroke opens a fresh burst', () => {
    const publish = sentPublish();
    const machine = renderMachine(publish);

    act(() => machine.current().onKeystroke());
    advance(TYPING_IDLE_STOP_MS);
    advance(3 * TYPING_HEARTBEAT_MS);
    expect(publish.mock.calls).toEqual([['started'], ['stopped']]);
    expect(vi.getTimerCount()).toBe(0);

    act(() => machine.current().onKeystroke());
    expect(publish.mock.calls).toEqual([['started'], ['stopped'], ['started']]);
  });

  it('onStopped publishes "stopped" once, is idempotent, and cancels every sender timer', () => {
    const publish = sentPublish();
    const machine = renderMachine(publish);

    act(() => machine.current().onKeystroke());
    act(() => machine.current().onStopped());
    expect(vi.getTimerCount()).toBe(0);

    act(() => machine.current().onStopped());
    advance(3 * TYPING_HEARTBEAT_MS);

    expect(publish.mock.calls).toEqual([['started'], ['stopped']]);
  });

  it('onStopped publishes nothing when no burst was ever started', () => {
    const publish = sentPublish();
    const machine = renderMachine(publish);

    act(() => machine.current().onStopped());

    expect(publish).not.toHaveBeenCalled();
  });

  it('a null publish makes keystrokes inert and arms no timer', () => {
    const machine = renderMachine(null);

    act(() => machine.current().onKeystroke());
    act(() => machine.current().onKeystroke());

    expect(vi.getTimerCount()).toBe(0);
    act(() => machine.current().onStopped());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads publish at call time: a replaced function receives the next signal', () => {
    const first = sentPublish();
    const second = sentPublish();
    const machine = renderMachine(first);

    act(() => machine.current().onKeystroke());
    machine.rerender({ publish: second });
    typeContinuously(machine, TYPING_HEARTBEAT_MS);
    advance(TYPING_IDLE_STOP_MS);

    expect(first.mock.calls).toEqual([['started']]);
    expect(second.mock.calls).toEqual([['started'], ['stopped']]);
  });

  it('unmount mid-burst publishes "stopped" and leaves no pending timer', () => {
    const publish = sentPublish();
    const machine = renderMachine(publish);

    act(() => machine.current().onKeystroke());
    act(() => machine.current().receive('started', 'user-b'));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    machine.unmount();

    expect(publish.mock.calls).toEqual([['started'], ['stopped']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unmount with no open burst publishes nothing', () => {
    const publish = sentPublish();
    const machine = renderMachine(publish);

    machine.unmount();

    expect(publish).not.toHaveBeenCalled();
  });
});

describe('receiver', () => {
  it('"started" adds the id', () => {
    const machine = renderMachine(null);

    act(() => machine.current().receive('started', 'user-b'));

    expect(machine.current().typingClientIds).toEqual(['user-b']);
  });

  it('expires an id at exactly TYPING_RECEIVER_EXPIRY_MS with no further events', () => {
    const machine = renderMachine(null);

    act(() => machine.current().receive('started', 'user-b'));
    advance(TYPING_RECEIVER_EXPIRY_MS - 1);
    expect(machine.current().typingClientIds).toEqual(['user-b']);

    advance(1);
    expect(machine.current().typingClientIds).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a repeated "started" re-arms the expiry from the LATEST signal', () => {
    const machine = renderMachine(null);

    act(() => machine.current().receive('started', 'user-b'));
    advance(6_000);
    act(() => machine.current().receive('started', 'user-b'));

    // The first signal's deadline passes: the re-arm must have cancelled it.
    advance(TYPING_RECEIVER_EXPIRY_MS - 1);
    expect(machine.current().typingClientIds).toEqual(['user-b']);

    advance(1);
    expect(machine.current().typingClientIds).toEqual([]);
  });

  it('⚠ a repeated "started" keeps the SAME array and causes no re-render', () => {
    const machine = renderMachine(null);

    act(() => machine.current().receive('started', 'user-b'));
    const before = machine.current().typingClientIds;
    const rendersBefore = machine.renders();

    act(() => machine.current().receive('started', 'user-b'));
    act(() => machine.current().receive('started', 'user-b'));

    expect(machine.current().typingClientIds).toBe(before);
    expect(machine.renders()).toBe(rendersBefore);
  });

  it('⚠ a heartbeat stream keeps one typist present, never flickering and never re-rendering', () => {
    const machine = renderMachine(null);

    act(() => machine.current().receive('started', 'user-b'));
    const first = machine.current().typingClientIds;
    const rendersAfterFirst = machine.renders();

    for (let beat = 0; beat < 6; beat += 1) {
      advance(TYPING_HEARTBEAT_MS);
      expect(machine.current().typingClientIds).toBe(first);
      act(() => machine.current().receive('started', 'user-b'));
    }

    expect(machine.renders()).toBe(rendersAfterFirst);
    expect(machine.current().typingClientIds).toEqual(['user-b']);
  });

  it('two "started" from one id yield ONE entry', () => {
    const machine = renderMachine(null);

    act(() => {
      machine.current().receive('started', 'user-b');
      machine.current().receive('started', 'user-b');
    });

    expect(machine.current().typingClientIds).toEqual(['user-b']);
  });

  it('an explicit "stopped" clears the id immediately and cancels its expiry', () => {
    const machine = renderMachine(null);

    act(() => machine.current().receive('started', 'user-b'));
    act(() => machine.current().receive('stopped', 'user-b'));

    expect(machine.current().typingClientIds).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('⚠ a cancelled expiry never fires against the same id re-added later', () => {
    const machine = renderMachine(null);

    act(() => machine.current().receive('started', 'user-b'));
    advance(1_000);
    act(() => machine.current().receive('stopped', 'user-b'));
    advance(4_000);
    act(() => machine.current().receive('started', 'user-b'));

    // 12 s after the ORIGINAL start — only a leaked timer would act here.
    advance(TYPING_RECEIVER_EXPIRY_MS - 5_000);
    expect(machine.current().typingClientIds).toEqual(['user-b']);

    advance(5_000 - 1);
    expect(machine.current().typingClientIds).toEqual(['user-b']);
    advance(1);
    expect(machine.current().typingClientIds).toEqual([]);
  });

  it('"stopped" for an absent id changes nothing', () => {
    const machine = renderMachine(null);

    act(() => machine.current().receive('started', 'user-b'));
    const before = machine.current().typingClientIds;
    const rendersBefore = machine.renders();

    act(() => machine.current().receive('stopped', 'user-c'));

    expect(machine.current().typingClientIds).toBe(before);
    expect(machine.renders()).toBe(rendersBefore);
  });

  it('keeps first-seen order through re-arms and removals', () => {
    const machine = renderMachine(null);

    act(() => {
      machine.current().receive('started', 'user-a');
      machine.current().receive('started', 'user-b');
      machine.current().receive('started', 'user-c');
    });
    act(() => machine.current().receive('started', 'user-a'));
    expect(machine.current().typingClientIds).toEqual(['user-a', 'user-b', 'user-c']);

    act(() => machine.current().receive('stopped', 'user-b'));
    expect(machine.current().typingClientIds).toEqual(['user-a', 'user-c']);

    act(() => machine.current().receive('started', 'user-b'));
    expect(machine.current().typingClientIds).toEqual(['user-a', 'user-c', 'user-b']);
  });

  it('expires each id on its own clock', () => {
    const machine = renderMachine(null);

    act(() => machine.current().receive('started', 'user-a'));
    advance(5_000);
    act(() => machine.current().receive('started', 'user-b'));

    advance(TYPING_RECEIVER_EXPIRY_MS - 5_000);
    expect(machine.current().typingClientIds).toEqual(['user-b']);

    advance(5_000 - 1);
    expect(machine.current().typingClientIds).toEqual(['user-b']);
    advance(1);
    expect(machine.current().typingClientIds).toEqual([]);
  });

  it('re-adds an id that expired, as a new entry', () => {
    const machine = renderMachine(null);

    act(() => machine.current().receive('started', 'user-b'));
    advance(TYPING_RECEIVER_EXPIRY_MS);
    act(() => machine.current().receive('started', 'user-b'));

    expect(machine.current().typingClientIds).toEqual(['user-b']);
  });

  it('clear() drops every id and cancels every inbound timer', () => {
    const machine = renderMachine(null);

    act(() => {
      machine.current().receive('started', 'user-a');
      machine.current().receive('started', 'user-b');
    });
    act(() => machine.current().clear());

    expect(machine.current().typingClientIds).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    advance(TYPING_RECEIVER_EXPIRY_MS);
    act(() => machine.current().receive('started', 'user-c'));
    expect(machine.current().typingClientIds).toEqual(['user-c']);
  });

  it('clear() leaves the sender alone', () => {
    const publish = sentPublish();
    const machine = renderMachine(publish);

    act(() => machine.current().onKeystroke());
    act(() => machine.current().receive('started', 'user-b'));
    act(() => machine.current().clear());
    advance(TYPING_IDLE_STOP_MS);

    expect(publish.mock.calls).toEqual([['started'], ['stopped']]);
  });

  it('clear() on an empty set keeps the same array and causes no re-render', () => {
    const machine = renderMachine(null);
    const before = machine.current().typingClientIds;
    const rendersBefore = machine.renders();

    act(() => machine.current().clear());

    expect(machine.current().typingClientIds).toBe(before);
    expect(machine.renders()).toBe(rendersBefore);
  });

  it('clear() after expiry and a stop drained the set keeps the same array (no re-render)', () => {
    const machine = renderMachine(null);

    act(() => {
      machine.current().receive('started', 'user-a');
      machine.current().receive('started', 'user-b');
    });
    act(() => machine.current().receive('stopped', 'user-a'));
    advance(TYPING_RECEIVER_EXPIRY_MS);
    const drained = machine.current().typingClientIds;
    expect(drained).toEqual([]);
    const rendersBefore = machine.renders();

    act(() => machine.current().clear());

    expect(machine.current().typingClientIds).toBe(drained);
    expect(machine.renders()).toBe(rendersBefore);
  });
});

describe('identity', () => {
  it('every returned callback is referentially stable across re-renders and publish changes', () => {
    const machine = renderMachine(sentPublish());
    const { onKeystroke, onStopped, receive, clear } = machine.current();

    machine.rerender({ publish: sentPublish() });
    machine.rerender({ publish: null });
    act(() => machine.current().receive('started', 'user-b'));

    expect(machine.current().onKeystroke).toBe(onKeystroke);
    expect(machine.current().onStopped).toBe(onStopped);
    expect(machine.current().receive).toBe(receive);
    expect(machine.current().clear).toBe(clear);
  });

  it('the returned object keeps its identity while the typing set is unchanged', () => {
    const machine = renderMachine(null);
    const before = machine.current();

    machine.rerender({ publish: null });

    expect(machine.current()).toBe(before);
  });
});

describe('sender — ⚠⚠ a burst opens only on a SENT `started`', () => {
  it('a dropped `started` (not yet connected) opens nothing, and the next keystroke retries', () => {
    let connected = false;
    const publish = vi.fn<Publish>(() => connected);
    const machine = renderMachine(publish);

    act(() => machine.current().onKeystroke());
    expect(publish.mock.calls).toEqual([['started']]);

    connected = true;
    act(() => machine.current().onKeystroke());
    expect(publish.mock.calls).toEqual([['started'], ['started']]);

    // The burst is open now: a third keystroke publishes nothing, the heartbeat does.
    act(() => machine.current().onKeystroke());
    expect(publish).toHaveBeenCalledTimes(2);
    advance(TYPING_HEARTBEAT_MS);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('a dropped `started` arms no heartbeat and owes no `stopped`', () => {
    const publish = vi.fn<Publish>(() => false);
    const machine = renderMachine(publish);

    act(() => machine.current().onKeystroke());
    advance(TYPING_HEARTBEAT_MS * 2);
    act(() => machine.current().onStopped());

    expect(publish.mock.calls).toEqual([['started']]);
  });

  it('a heartbeat that is NOT sent closes the burst, so the next keystroke re-announces at once', () => {
    let connected = true;
    const publish = vi.fn<Publish>(() => connected);
    const machine = renderMachine(publish);

    act(() => machine.current().onKeystroke());
    connected = false;
    // Keep typing through the heartbeat so the idle stop cannot be what closes the burst.
    typeContinuously(machine, TYPING_HEARTBEAT_MS);
    expect(publish.mock.calls).toEqual([['started'], ['started']]);

    connected = true;
    act(() => machine.current().onKeystroke());
    expect(publish.mock.calls).toEqual([['started'], ['started'], ['started']]);
  });
});
