import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isMismatchAnswered,
  markMismatchAnswered,
  MISMATCH_KEEP_TTL_MS,
} from './mismatch-dismissal';

const SYDNEY = 'Australia/Sydney';
const LONDON = 'Europe/London';
const KEY = `balo:tz-mismatch-kept:${SYDNEY}|${LONDON}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

const store = new Map<string, string>();
const getItem = vi.fn((key: string): string | null => store.get(key) ?? null);
const setItem = vi.fn((key: string, value: string): void => {
  store.set(key, value);
});

beforeEach(() => {
  store.clear();
  getItem.mockClear();
  setItem.mockClear();
  vi.stubGlobal('localStorage', { getItem, setItem });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mismatch dismissal', () => {
  it('is unanswered until the pair is marked', () => {
    expect(isMismatchAnswered(SYDNEY, LONDON, NOW)).toBe(false);
    markMismatchAnswered(SYDNEY, LONDON, NOW);
    expect(isMismatchAnswered(SYDNEY, LONDON, NOW)).toBe(true);
  });

  it('writes the answer time under the pair-specific key', () => {
    markMismatchAnswered(SYDNEY, LONDON, NOW);
    expect(setItem).toHaveBeenCalledWith(KEY, String(NOW));
  });

  it('defaults to the real clock', () => {
    markMismatchAnswered(SYDNEY, LONDON);
    expect(isMismatchAnswered(SYDNEY, LONDON)).toBe(true);
  });

  it('stays answered after 29 days', () => {
    markMismatchAnswered(SYDNEY, LONDON, NOW);
    expect(isMismatchAnswered(SYDNEY, LONDON, NOW + 29 * DAY_MS)).toBe(true);
  });

  it('expires after 31 days', () => {
    markMismatchAnswered(SYDNEY, LONDON, NOW);
    expect(isMismatchAnswered(SYDNEY, LONDON, NOW + 31 * DAY_MS)).toBe(false);
  });

  it('expires exactly at the TTL boundary', () => {
    markMismatchAnswered(SYDNEY, LONDON, NOW);
    expect(isMismatchAnswered(SYDNEY, LONDON, NOW + MISMATCH_KEEP_TTL_MS - 1)).toBe(true);
    expect(isMismatchAnswered(SYDNEY, LONDON, NOW + MISMATCH_KEEP_TTL_MS)).toBe(false);
  });

  it('treats the legacy "1" value as not answered', () => {
    store.set(KEY, '1');
    expect(isMismatchAnswered(SYDNEY, LONDON, NOW)).toBe(false);
  });

  it.each(['', 'abc', '12abc', '-5', '1.5', '1e9', 'NaN', '99999999999999999999'])(
    'treats the garbage value %j as not answered',
    (value) => {
      store.set(KEY, value);
      expect(isMismatchAnswered(SYDNEY, LONDON, NOW)).toBe(false);
    }
  );

  it('treats an answer time in the future as not answered', () => {
    store.set(KEY, String(NOW + DAY_MS));
    expect(isMismatchAnswered(SYDNEY, LONDON, NOW)).toBe(false);
  });

  it('keeps a different device zone unanswered', () => {
    markMismatchAnswered(SYDNEY, LONDON, NOW);
    expect(isMismatchAnswered(SYDNEY, 'America/New_York', NOW)).toBe(false);
  });

  it('keeps a different schedule zone unanswered', () => {
    markMismatchAnswered(SYDNEY, LONDON, NOW);
    expect(isMismatchAnswered('Australia/Perth', LONDON, NOW)).toBe(false);
  });

  it('reads as unanswered when storage throws', () => {
    getItem.mockImplementationOnce(() => {
      throw new Error('blocked');
    });
    expect(isMismatchAnswered(SYDNEY, LONDON, NOW)).toBe(false);
  });

  it('swallows a throwing write', () => {
    setItem.mockImplementationOnce(() => {
      throw new Error('quota');
    });
    expect(() => markMismatchAnswered(SYDNEY, LONDON, NOW)).not.toThrow();
  });
});
