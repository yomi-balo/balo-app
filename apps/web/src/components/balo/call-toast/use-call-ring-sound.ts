'use client';

import { useEffect } from 'react';

const RING_HZ = [440, 480] as const;
const RING_GAIN = 0.08;
const BURST_SECONDS = 0.4;
const BURST_OFFSETS_SECONDS = [0, 0.6] as const;
const CADENCE_MS = 3000;

function scheduleBursts(context: AudioContext): void {
  const start = context.currentTime;
  for (const offset of BURST_OFFSETS_SECONDS) {
    const at = start + offset;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(RING_GAIN, at + 0.02);
    gain.gain.setValueAtTime(RING_GAIN, at + BURST_SECONDS - 0.02);
    gain.gain.linearRampToValueAtTime(0, at + BURST_SECONDS);
    gain.connect(context.destination);
    for (const hz of RING_HZ) {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = hz;
      oscillator.connect(gain);
      oscillator.start(at);
      oscillator.stop(at + BURST_SECONDS);
    }
  }
}

/**
 * A synthesised two-tone ring (440 + 480 Hz, two 400 ms bursts every 3 s) while `active` and the
 * tab is visible. It stops when the ring ends, the tab is hidden, or the component unmounts. A
 * browser that blocks audio before a gesture, or has no Web Audio, is silently quiet: the toast is
 * the signal, the sound is a bonus. No asset is loaded.
 */
export function useCallRingSound(active: boolean): void {
  useEffect(() => {
    if (!active || globalThis.AudioContext === undefined) return undefined;

    let context: AudioContext | null = null;
    let cadence: ReturnType<typeof setInterval> | undefined;

    const stop = (): void => {
      clearInterval(cadence);
      cadence = undefined;
      context?.close().catch(() => undefined);
      context = null;
    };

    const ring = (): void => {
      if (context === null) return;
      try {
        scheduleBursts(context);
      } catch {
        stop();
      }
    };

    const start = (): void => {
      if (context !== null || document.visibilityState !== 'visible') return;
      try {
        context = new globalThis.AudioContext();
        context.resume().catch(() => undefined);
        ring();
        cadence = setInterval(ring, CADENCE_MS);
      } catch {
        stop();
      }
    };

    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    start();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      stop();
    };
  }, [active]);
}
