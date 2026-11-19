import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCallRingSound } from './use-call-ring-sound';

const audio = vi.hoisted(() => ({
  contexts: [] as {
    close: ReturnType<typeof vi.fn>;
    createOscillator: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  }[],
  resumeRejects: false,
  throwOnCreate: false,
}));

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  close = vi.fn(() => Promise.resolve());
  resume = vi.fn(() =>
    audio.resumeRejects ? Promise.reject(new Error('blocked')) : Promise.resolve()
  );
  createGain = vi.fn(() => ({
    gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  }));
  createOscillator = vi.fn(() => ({
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }));
  constructor() {
    if (audio.throwOnCreate) throw new Error('no audio');
    audio.contexts.push(this);
  }
}

const realAudioContext = globalThis.AudioContext;

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

beforeEach(() => {
  vi.useFakeTimers();
  audio.contexts.length = 0;
  audio.resumeRejects = false;
  audio.throwOnCreate = false;
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.AudioContext = realAudioContext;
});

describe('useCallRingSound', () => {
  it('rings a 440 + 480 Hz double burst at once, then again every three seconds', () => {
    renderHook(() => useCallRingSound(true));
    const [context] = audio.contexts;

    expect(audio.contexts).toHaveLength(1);
    expect(context?.createOscillator).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(3000);
    expect(context?.createOscillator).toHaveBeenCalledTimes(8);
  });

  it('plays nothing while inactive', () => {
    renderHook(() => useCallRingSound(false));

    expect(audio.contexts).toHaveLength(0);
  });

  it('stops and closes the context when the ring ends', () => {
    const { rerender } = renderHook(({ active }) => useCallRingSound(active), {
      initialProps: { active: true },
    });
    const [context] = audio.contexts;

    rerender({ active: false });
    vi.advanceTimersByTime(9000);

    expect(context?.close).toHaveBeenCalledTimes(1);
    expect(context?.createOscillator).toHaveBeenCalledTimes(4);
  });

  it('closes on unmount', () => {
    const { unmount } = renderHook(() => useCallRingSound(true));
    const [context] = audio.contexts;

    unmount();

    expect(context?.close).toHaveBeenCalledTimes(1);
  });

  it('stays silent in a hidden tab and starts when the tab returns', () => {
    setVisibility('hidden');
    renderHook(() => useCallRingSound(true));
    expect(audio.contexts).toHaveLength(0);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(audio.contexts).toHaveLength(1);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(audio.contexts[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('swallows an autoplay rejection and a construction failure', () => {
    audio.resumeRejects = true;
    expect(() => renderHook(() => useCallRingSound(true))).not.toThrow();

    audio.throwOnCreate = true;
    expect(() => renderHook(() => useCallRingSound(true))).not.toThrow();
  });

  it('does nothing where Web Audio does not exist', () => {
    // @ts-expect-error simulating a browser without Web Audio
    globalThis.AudioContext = undefined;

    expect(() => renderHook(() => useCallRingSound(true))).not.toThrow();
  });
});
