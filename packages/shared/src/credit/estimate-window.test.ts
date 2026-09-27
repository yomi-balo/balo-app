import { describe, expect, it } from 'vitest';
import { MAX_SESSION_MINUTES } from '../pricing';
import { estimatedMinutesForWindow } from './estimate-window';

/**
 * BAL-474 — the ONE window estimator (moved from `apps/api`'s `join-meeting.ts`, BAL-466). It
 * sizes admission's hold and prices both booking funding checks, so its clamp is money-relevant.
 */
const MINUTE_MS = 60_000;

function window(minutes: number): [Date, Date] {
  const start = new Date(Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS);
  return [start, new Date(start.getTime() + minutes * MINUTE_MS)];
}

describe('estimatedMinutesForWindow', () => {
  it('is the window length in whole minutes', () => {
    expect(estimatedMinutesForWindow(...window(30))).toBe(30);
    expect(estimatedMinutesForWindow(...window(60))).toBe(60);
  });

  it('rounds a partial minute UP', () => {
    const [start] = window(0);
    expect(estimatedMinutesForWindow(start, new Date(start.getTime() + 30 * MINUTE_MS + 1))).toBe(
      31
    );
  });

  it(`clamps to MAX_SESSION_MINUTES (${MAX_SESSION_MINUTES}) — never an oversized hold`, () => {
    expect(estimatedMinutesForWindow(...window(MAX_SESSION_MINUTES + 60))).toBe(
      MAX_SESSION_MINUTES
    );
  });

  it('a zero-length or inverted window becomes 1, never 0', () => {
    const [start] = window(0);
    expect(estimatedMinutesForWindow(start, start)).toBe(1);
    expect(estimatedMinutesForWindow(start, new Date(start.getTime() - 10 * MINUTE_MS))).toBe(1);
  });

  it('an invalid instant becomes 1, never NaN', () => {
    const [start] = window(0);
    expect(estimatedMinutesForWindow(start, new Date(Number.NaN))).toBe(1);
  });
});
