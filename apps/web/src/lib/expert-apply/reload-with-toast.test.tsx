import { describe, it, expect, vi } from 'vitest';
import { reloadWithToast, consumePendingToast, PENDING_TOAST_KEY } from './reload-with-toast';

function makeFakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

describe('reloadWithToast', () => {
  it('stashes the message under PENDING_TOAST_KEY, then navigates to /expert/apply', () => {
    const store = makeFakeStorage();
    const navigate = vi.fn();

    reloadWithToast('hello', { navigate, store });

    expect(store.getItem(PENDING_TOAST_KEY)).toBe('hello');
    expect(navigate).toHaveBeenCalledWith('/expert/apply');
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('still navigates even when the store throws on setItem (best-effort persistence)', () => {
    const store = makeFakeStorage();
    store.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    const navigate = vi.fn();

    expect(() => reloadWithToast('hello', { navigate, store })).not.toThrow();
    expect(navigate).toHaveBeenCalledWith('/expert/apply');
  });

  it('defaults to globalThis.sessionStorage when no store is injected', () => {
    globalThis.sessionStorage.clear();
    const navigate = vi.fn();

    reloadWithToast('default-store-message', { navigate });

    expect(globalThis.sessionStorage.getItem(PENDING_TOAST_KEY)).toBe('default-store-message');
    expect(navigate).toHaveBeenCalledWith('/expert/apply');
  });
});

describe('consumePendingToast', () => {
  it('returns the stashed message and clears it (read-once)', () => {
    const store = makeFakeStorage({ [PENDING_TOAST_KEY]: 'stashed' });

    expect(consumePendingToast(store)).toBe('stashed');
    expect(store.getItem(PENDING_TOAST_KEY)).toBeNull();
    expect(consumePendingToast(store)).toBeNull();
  });

  it('returns null when nothing is stashed', () => {
    const store = makeFakeStorage();
    expect(consumePendingToast(store)).toBeNull();
  });

  it('returns null (never throws) when the store throws on getItem', () => {
    const store = makeFakeStorage();
    store.getItem = () => {
      throw new Error('SecurityError');
    };
    expect(() => consumePendingToast(store)).not.toThrow();
    expect(consumePendingToast(store)).toBeNull();
  });

  it('defaults to globalThis.sessionStorage when no store is injected', () => {
    globalThis.sessionStorage.clear();
    globalThis.sessionStorage.setItem(PENDING_TOAST_KEY, 'from-default-store');

    expect(consumePendingToast()).toBe('from-default-store');
    expect(globalThis.sessionStorage.getItem(PENDING_TOAST_KEY)).toBeNull();
  });
});
