import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  rememberPendingHomeProject,
  forgetPendingHomeProject,
  hasPendingHomeProject,
  consumePendingHomeProject,
} from './pending-home-project';

const STORAGE_KEY = 'balo:pending-intent:home';
const THIRTY_MIN_MS = 30 * 60 * 1000;

beforeEach(() => {
  globalThis.sessionStorage.clear();
  globalThis.localStorage.clear();
  globalThis.history.replaceState(null, '', '/');
});

describe('rememberPendingHomeProject / hasPendingHomeProject / consumePendingHomeProject', () => {
  it('round-trips: remember sets it, has sees it, consume reads it and removes it', () => {
    const now = Date.now();
    rememberPendingHomeProject(now);

    expect(hasPendingHomeProject(now)).toBe(true);
    expect(consumePendingHomeProject(now)).toBe(true);
    expect(hasPendingHomeProject(now)).toBe(false);
    expect(globalThis.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('has does not remove the marker (read-only)', () => {
    const now = Date.now();
    rememberPendingHomeProject(now);

    expect(hasPendingHomeProject(now)).toBe(true);
    expect(globalThis.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(hasPendingHomeProject(now)).toBe(true);
  });

  it('returns false with nothing stored', () => {
    expect(hasPendingHomeProject()).toBe(false);
    expect(consumePendingHomeProject()).toBe(false);
  });

  describe('TTL edges', () => {
    it('is valid at age 0', () => {
      const now = Date.now();
      rememberPendingHomeProject(now);
      expect(hasPendingHomeProject(now)).toBe(true);
    });

    it('is valid at exactly 30 minutes', () => {
      const created = Date.now();
      rememberPendingHomeProject(created);
      expect(hasPendingHomeProject(created + THIRTY_MIN_MS)).toBe(true);
    });

    it('is invalid one millisecond past 30 minutes', () => {
      const created = Date.now();
      rememberPendingHomeProject(created);
      expect(hasPendingHomeProject(created + THIRTY_MIN_MS + 1)).toBe(false);
    });

    it('is invalid for a negative age (now before createdAt — clock skew)', () => {
      const created = Date.now();
      rememberPendingHomeProject(created);
      expect(hasPendingHomeProject(created - 1)).toBe(false);
    });

    it('consume also removes an expired marker', () => {
      const created = Date.now();
      rememberPendingHomeProject(created);
      expect(consumePendingHomeProject(created + THIRTY_MIN_MS + 1)).toBe(false);
      expect(globalThis.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  it('consume removes malformed JSON and reports false', () => {
    globalThis.sessionStorage.setItem(STORAGE_KEY, '{not json');
    expect(consumePendingHomeProject()).toBe(false);
    expect(globalThis.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('consume removes a marker with the wrong intent and reports false', () => {
    globalThis.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ intent: 'consultation', createdAt: Date.now() })
    );
    expect(consumePendingHomeProject()).toBe(false);
    expect(globalThis.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('has treats malformed JSON and the wrong intent as absent, without removing them', () => {
    globalThis.sessionStorage.setItem(STORAGE_KEY, '{not json');
    expect(hasPendingHomeProject()).toBe(false);
    expect(globalThis.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('degrades to false, never throws, when the store throws on access', () => {
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(() => rememberPendingHomeProject()).not.toThrow();
    } finally {
      setSpy.mockRestore();
    }

    rememberPendingHomeProject();
    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(hasPendingHomeProject()).toBe(false);
      expect(consumePendingHomeProject()).toBe(false);
    } finally {
      getSpy.mockRestore();
    }
  });

  it('degrades to false/no-op, never throws, when merely accessing sessionStorage throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      get(): Storage {
        throw new Error('SecurityError');
      },
      configurable: true,
    });
    try {
      expect(() => rememberPendingHomeProject()).not.toThrow();
      expect(hasPendingHomeProject()).toBe(false);
      expect(consumePendingHomeProject()).toBe(false);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'sessionStorage', descriptor);
      }
    }
  });
});

describe('forgetPendingHomeProject', () => {
  it('clears the stored marker', () => {
    rememberPendingHomeProject();
    forgetPendingHomeProject();
    expect(hasPendingHomeProject()).toBe(false);
    expect(globalThis.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('calling it twice does not throw', () => {
    forgetPendingHomeProject();
    expect(() => forgetPendingHomeProject()).not.toThrow();
  });

  it('degrades to a no-op, never throws, when the store throws on removal', () => {
    rememberPendingHomeProject();
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(() => forgetPendingHomeProject()).not.toThrow();
    } finally {
      removeSpy.mockRestore();
    }
  });
});
