import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ANON_DRAFT_KEY,
  ANON_DRAFT_MAX_AGE_MS,
  readAnonymousDraft,
  writeAnonymousDraft,
  clearAnonymousDraft,
  stampAuthGate,
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

// ── BAL-562 ──────────────────────────────────────────────────────

describe('BAL-562 — authGateAt survives a later envelope write (the sticky stamp)', () => {
  it('carries a stored stamp forward when the incoming envelope has none — the debounce can no longer strip it', () => {
    const stamp = new Date('2026-09-14T10:00:00.000Z').toISOString();
    const store = makeFakeStorage();

    // The submit gate stamps...
    writeAnonymousDraft(fullDraft({ authGateAt: stamp }), store);
    // ...then the 800ms debounce lands with an envelope rebuilt from live state,
    // which has no idea a gate was ever crossed.
    writeAnonymousDraft(fullDraft({ steps: { profile: { yearStartedSalesforce: 2019 } } }), store);

    const stored = readAnonymousDraft(store);
    expect(stored?.authGateAt).toBe(stamp);
    // ...and the debounce's fresher payload is still what got written.
    expect(stored?.steps.profile).toEqual({ yearStartedSalesforce: 2019 });
  });

  it('an explicit stamp on the incoming envelope OVERRIDES the stored one, so a fresh gate always moves the window forward', () => {
    const older = new Date('2026-09-14T10:00:00.000Z').toISOString();
    const newer = new Date('2026-09-14T10:20:00.000Z').toISOString();
    const store = makeFakeStorage();

    writeAnonymousDraft(fullDraft({ authGateAt: older }), store);
    writeAnonymousDraft(fullDraft({ authGateAt: newer }), store);

    expect(readAnonymousDraft(store)?.authGateAt).toBe(newer);
  });

  it('writes no authGateAt key at all when there was never a stamp to carry (undefined is not serialized)', () => {
    const store = makeFakeStorage();
    writeAnonymousDraft(fullDraft(), store);

    const raw = JSON.parse(store.getItem(ANON_DRAFT_KEY) ?? '{}') as Record<string, unknown>;
    expect('authGateAt' in raw).toBe(false);
  });

  it('does not break, and does not invent a stamp, when the stored payload is corrupt', () => {
    const store = makeFakeStorage({ [ANON_DRAFT_KEY]: '{not json' });
    expect(writeAnonymousDraft(fullDraft(), store)).toBe(true);
    expect(readAnonymousDraft(store)?.authGateAt).toBeUndefined();
  });

  it('does not break, and does not invent a stamp, when the stored payload is a bare JSON null', () => {
    const store = makeFakeStorage({ [ANON_DRAFT_KEY]: 'null' });
    expect(writeAnonymousDraft(fullDraft(), store)).toBe(true);
    expect(readAnonymousDraft(store)?.authGateAt).toBeUndefined();
  });

  it('ignores a non-string stored stamp rather than carrying garbage forward', () => {
    const store = makeFakeStorage({
      [ANON_DRAFT_KEY]: JSON.stringify({ ...fullDraft(), authGateAt: 12345 }),
    });
    writeAnonymousDraft(fullDraft(), store);
    expect(readAnonymousDraft(store)?.authGateAt).toBeUndefined();
  });

  it('the carry-forward read never clears an over-age envelope as a side effect', () => {
    const stale = new Date(Date.now() - ANON_DRAFT_MAX_AGE_MS - 1000).toISOString();
    const store = makeFakeStorage({
      [ANON_DRAFT_KEY]: JSON.stringify(fullDraft({ savedAt: stale, authGateAt: stale })),
    });

    // A fresh write replaces it wholesale; the point is that the lookup itself did
    // not remove the key out from under the write.
    expect(writeAnonymousDraft(fullDraft(), store)).toBe(true);
    expect(store.getItem(ANON_DRAFT_KEY)).not.toBeNull();
  });
});

describe('BAL-562 — stampAuthGate', () => {
  it('stamps an existing envelope in place and leaves its content untouched', () => {
    const store = makeFakeStorage({ [ANON_DRAFT_KEY]: JSON.stringify(fullDraft()) });

    expect(stampAuthGate(store)).toBe(true);

    const stored = readAnonymousDraft(store);
    expect(typeof stored?.authGateAt).toBe('string');
    expect(stored?.steps).toEqual(fullDraft().steps);
    expect(stored?.maxReachedStep).toBe(3);
  });

  it('returns false and writes nothing when there is no envelope — the ordinary case on every (apply) route except the wizard', () => {
    const store = makeFakeStorage();
    expect(stampAuthGate(store)).toBe(false);
    expect(store.getItem(ANON_DRAFT_KEY)).toBeNull();
  });

  it('refuses to resurrect an envelope past ANON_DRAFT_MAX_AGE_MS', () => {
    const stale = new Date(Date.now() - ANON_DRAFT_MAX_AGE_MS - 1000).toISOString();
    const store = makeFakeStorage({
      [ANON_DRAFT_KEY]: JSON.stringify(fullDraft({ savedAt: stale })),
    });

    expect(stampAuthGate(store)).toBe(false);
    expect(store.getItem(ANON_DRAFT_KEY)).toBeNull(); // readAnonymousDraft cleared it
  });

  it('returns false (never throws) when the write fails', () => {
    const store = makeFakeStorage({ [ANON_DRAFT_KEY]: JSON.stringify(fullDraft()) });
    store.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(stampAuthGate(store)).toBe(false);
  });

  it('moves an existing stamp forward rather than leaving the first one in place', () => {
    const older = new Date('2020-01-01T00:00:00.000Z').toISOString();
    const store = makeFakeStorage({
      [ANON_DRAFT_KEY]: JSON.stringify(fullDraft({ authGateAt: older })),
    });

    stampAuthGate(store);
    expect(readAnonymousDraft(store)?.authGateAt).not.toBe(older);
  });
});

describe('BAL-562 — stepStatuses on the envelope', () => {
  it('round-trips the progress rail', () => {
    const store = makeFakeStorage();
    writeAnonymousDraft(
      fullDraft({ stepStatuses: ['completed', 'completed', 'skipped', 'pending'] }),
      store
    );
    expect(readAnonymousDraft(store)?.stepStatuses).toEqual([
      'completed',
      'completed',
      'skipped',
      'pending',
    ]);
  });

  it('an envelope written before the field existed still validates (optional, backward-compatible)', () => {
    const store = makeFakeStorage({ [ANON_DRAFT_KEY]: JSON.stringify(fullDraft()) });
    const stored = readAnonymousDraft(store);
    expect(stored).not.toBeNull();
    expect(stored?.stepStatuses).toBeUndefined();
  });

  it('rejects an envelope carrying an unknown status rather than half-hydrating the rail', () => {
    const store = makeFakeStorage({
      [ANON_DRAFT_KEY]: JSON.stringify({ ...fullDraft(), stepStatuses: ['completed', 'bogus'] }),
    });
    expect(readAnonymousDraft(store)).toBeNull();
  });
});
