import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isMismatchAnswered, markMismatchAnswered } from './mismatch-dismissal';

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
    expect(isMismatchAnswered('Australia/Sydney', 'Europe/London')).toBe(false);
    markMismatchAnswered('Australia/Sydney', 'Europe/London');
    expect(isMismatchAnswered('Australia/Sydney', 'Europe/London')).toBe(true);
  });

  it('writes under the pair-specific key', () => {
    markMismatchAnswered('Australia/Sydney', 'Europe/London');
    expect(setItem).toHaveBeenCalledWith(
      'balo:tz-mismatch-kept:Australia/Sydney|Europe/London',
      '1'
    );
  });

  it('keeps a different device zone unanswered', () => {
    markMismatchAnswered('Australia/Sydney', 'Europe/London');
    expect(isMismatchAnswered('Australia/Sydney', 'America/New_York')).toBe(false);
  });

  it('keeps a different schedule zone unanswered', () => {
    markMismatchAnswered('Australia/Sydney', 'Europe/London');
    expect(isMismatchAnswered('Australia/Perth', 'Europe/London')).toBe(false);
  });

  it('reads as unanswered when storage throws', () => {
    getItem.mockImplementationOnce(() => {
      throw new Error('blocked');
    });
    expect(isMismatchAnswered('Australia/Sydney', 'Europe/London')).toBe(false);
  });

  it('swallows a throwing write', () => {
    setItem.mockImplementationOnce(() => {
      throw new Error('quota');
    });
    expect(() => markMismatchAnswered('Australia/Sydney', 'Europe/London')).not.toThrow();
  });
});
