import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ANON_DRAFT_KEY,
  ANON_DRAFT_MAX_AGE_MS,
  readAnonymousDraft,
  writeAnonymousDraft,
  clearAnonymousDraft,
  type AnonymousApplicationDraftV1,
} from './anonymous-draft';

// ── Fake Storage ─────────────────────────────────────────────────
// An injectable fake so every test drives the store directly — no jsdom gymnastics,
// and a `setItem`/`getItem` that can be made to throw on demand (QuotaExceededError,
// Safari-private-mode simulation).

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

function fullDraft(
  overrides: Partial<AnonymousApplicationDraftV1> = {}
): AnonymousApplicationDraftV1 {
  return {
    v: 1,
    savedAt: new Date().toISOString(),
    currentStep: 2,
    maxReachedStep: 3,
    steps: {
      profile: { yearStartedSalesforce: 2018 },
      products: { productIds: ['11111111-1111-1111-1111-111111111111'] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('writeAnonymousDraft + readAnonymousDraft', () => {
  it('round-trips a full envelope through JSON.stringify/parse (asserts on the serialized string)', () => {
    const store = makeFakeStorage();
    const draft = fullDraft();

    expect(writeAnonymousDraft(draft, store)).toBe(true);
    expect(store.getItem(ANON_DRAFT_KEY)).toBe(JSON.stringify(draft));

    const read = readAnonymousDraft(store);
    expect(read).toEqual(draft);
  });

  it('returns null for a truncated string', () => {
    const store = makeFakeStorage({ [ANON_DRAFT_KEY]: '{"v":1,"steps":{' });
    expect(readAnonymousDraft(store)).toBeNull();
  });

  it('returns null for a wrong-version envelope ({v: 2})', () => {
    const store = makeFakeStorage({
      [ANON_DRAFT_KEY]: JSON.stringify({ ...fullDraft(), v: 2 }),
    });
    expect(readAnonymousDraft(store)).toBeNull();
  });

  it('returns null for valid JSON with the wrong shape', () => {
    const store = makeFakeStorage({ [ANON_DRAFT_KEY]: JSON.stringify({ hello: 'world' }) });
    expect(readAnonymousDraft(store)).toBeNull();
  });

  it('returns null AND clears the key for an envelope older than ANON_DRAFT_MAX_AGE_MS', () => {
    const stale = fullDraft({
      savedAt: new Date(Date.now() - ANON_DRAFT_MAX_AGE_MS - 1000).toISOString(),
    });
    const store = makeFakeStorage({ [ANON_DRAFT_KEY]: JSON.stringify(stale) });

    expect(readAnonymousDraft(store)).toBeNull();
    expect(store.getItem(ANON_DRAFT_KEY)).toBeNull();
  });

  it('an envelope just under the max age is still valid', () => {
    const fresh = fullDraft({
      savedAt: new Date(Date.now() - ANON_DRAFT_MAX_AGE_MS + 60_000).toISOString(),
    });
    const store = makeFakeStorage({ [ANON_DRAFT_KEY]: JSON.stringify(fresh) });
    expect(readAnonymousDraft(store)).toEqual(fresh);
  });

  it('writeAnonymousDraft returns false (never throws) when setItem throws QuotaExceededError', () => {
    const store = makeFakeStorage();
    store.setItem = () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    expect(() => writeAnonymousDraft(fullDraft(), store)).not.toThrow();
    expect(writeAnonymousDraft(fullDraft(), store)).toBe(false);
  });

  it('readAnonymousDraft returns null (never throws) when getItem throws (private-window simulation)', () => {
    const store = makeFakeStorage();
    store.getItem = () => {
      throw new Error('SecurityError');
    };
    expect(() => readAnonymousDraft(store)).not.toThrow();
    expect(readAnonymousDraft(store)).toBeNull();
  });

  it('returns null for an absent key (private-window / cleared-store case)', () => {
    const store = makeFakeStorage();
    expect(readAnonymousDraft(store)).toBeNull();
  });

  it('round-trips authGateAt when present (BAL-502 FIX round WARNING 6)', () => {
    const store = makeFakeStorage();
    const draft = fullDraft({ authGateAt: new Date().toISOString() });
    expect(writeAnonymousDraft(draft, store)).toBe(true);
    expect(readAnonymousDraft(store)).toEqual(draft);
  });

  it('still validates an envelope with no authGateAt at all (field is optional)', () => {
    const store = makeFakeStorage();
    const draft = fullDraft();
    writeAnonymousDraft(draft, store);
    const read = readAnonymousDraft(store);
    expect(read).not.toBeNull();
    expect(read?.authGateAt).toBeUndefined();
  });

  it('degrades to null when no store is available at all', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('sessionStorage inaccessible');
      },
    });
    try {
      expect(readAnonymousDraft()).toBeNull();
      expect(writeAnonymousDraft(fullDraft())).toBe(false);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'sessionStorage', originalDescriptor);
      }
    }
  });
});

describe('clearAnonymousDraft', () => {
  it('removes the key', () => {
    const store = makeFakeStorage({ [ANON_DRAFT_KEY]: JSON.stringify(fullDraft()) });
    clearAnonymousDraft(store);
    expect(store.getItem(ANON_DRAFT_KEY)).toBeNull();
  });

  it('never throws even when removeItem throws', () => {
    const store = makeFakeStorage();
    store.removeItem = () => {
      throw new Error('boom');
    };
    expect(() => clearAnonymousDraft(store)).not.toThrow();
  });
});
