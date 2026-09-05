import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SETUP_INTENT_BINDING_STORAGE_KEY,
  rememberSetupIntent,
  forgetSetupIntent,
  readRememberedSetupIntent,
  readSetupIntentReturnParams,
  matchSetupIntentReturn,
  isSetupIntentReturnBound,
  clearSetupIntentReturnParams,
} from './setup-intent-return';

beforeEach(() => {
  globalThis.sessionStorage.clear();
  globalThis.history.replaceState({}, '', '/settings/billing');
});

function setUrl(setupIntent: string | null, clientSecret: string | null): void {
  const params = new URLSearchParams();
  if (setupIntent !== null) params.set('setup_intent', setupIntent);
  if (clientSecret !== null) params.set('setup_intent_client_secret', clientSecret);
  const query = params.toString();
  const suffix = query.length > 0 ? `?${query}` : '';
  globalThis.history.replaceState({}, '', `/settings/billing${suffix}`);
}

describe('rememberSetupIntent / readRememberedSetupIntent', () => {
  it('round-trips under the exact documented key', () => {
    rememberSetupIntent('seti_abc');
    expect(globalThis.sessionStorage.getItem(SETUP_INTENT_BINDING_STORAGE_KEY)).toBe('seti_abc');
    expect(readRememberedSetupIntent()).toBe('seti_abc');
  });

  it('writes nothing for a blank id', () => {
    rememberSetupIntent('');
    expect(globalThis.sessionStorage.getItem(SETUP_INTENT_BINDING_STORAGE_KEY)).toBeNull();
    expect(readRememberedSetupIntent()).toBeNull();
  });

  it('B1 — degrades to a no-op, never throws, for a non-string value smuggled past the type system (an unvalidated api response cast)', () => {
    // `postInternal`'s bare `as T` cast means a rolled-back api can hand this a 2xx body with no
    // `setupIntentId` at all — TS believes `string`, the runtime value is `undefined`.
    expect(() => rememberSetupIntent(undefined as unknown as string)).not.toThrow();
    expect(globalThis.sessionStorage.getItem(SETUP_INTENT_BINDING_STORAGE_KEY)).toBeNull();
  });

  it('readRememberedSetupIntent returns null when nothing is stored', () => {
    expect(readRememberedSetupIntent()).toBeNull();
  });

  it('degrades to a no-op / null, never throws, when the store throws on access', () => {
    // F-C — restore each spy in `finally`: a failed assertion above would otherwise leave a
    // throwing `Storage.prototype` method installed for every later test in this file.
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(() => rememberSetupIntent('seti_abc')).not.toThrow();
    } finally {
      setSpy.mockRestore();
    }

    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(readRememberedSetupIntent()).toBeNull();
    } finally {
      getSpy.mockRestore();
    }
  });

  it('B6 — degrades to null/no-op when merely ACCESSING `sessionStorage` throws (private-mode Safari), not just a method call on it', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      get(): Storage {
        throw new Error('SecurityError');
      },
      configurable: true,
    });
    try {
      expect(() => rememberSetupIntent('seti_abc')).not.toThrow();
      expect(readRememberedSetupIntent()).toBeNull();
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'sessionStorage', descriptor);
      }
    }
  });
});

describe('forgetSetupIntent', () => {
  it('clears the stored binding', () => {
    rememberSetupIntent('seti_abc');
    forgetSetupIntent();
    expect(readRememberedSetupIntent()).toBeNull();
  });

  it('calling it twice does not throw', () => {
    forgetSetupIntent();
    expect(() => forgetSetupIntent()).not.toThrow();
  });

  it('never throws even when the store throws on access', () => {
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => forgetSetupIntent()).not.toThrow();
    removeSpy.mockRestore();
  });
});

describe('readSetupIntentReturnParams', () => {
  it('returns null when both params are absent', () => {
    setUrl(null, null);
    expect(readSetupIntentReturnParams()).toBeNull();
  });

  it('returns null when setup_intent is absent', () => {
    setUrl(null, 'secret');
    expect(readSetupIntentReturnParams()).toBeNull();
  });

  it('returns null when setup_intent_client_secret is absent', () => {
    setUrl('seti_x', null);
    expect(readSetupIntentReturnParams()).toBeNull();
  });

  it('returns null when setup_intent is an empty string', () => {
    globalThis.history.replaceState(
      {},
      '',
      '/settings/billing?setup_intent=&setup_intent_client_secret=secret'
    );
    expect(readSetupIntentReturnParams()).toBeNull();
  });

  it('returns null when setup_intent_client_secret is an empty string', () => {
    globalThis.history.replaceState(
      {},
      '',
      '/settings/billing?setup_intent=seti_x&setup_intent_client_secret='
    );
    expect(readSetupIntentReturnParams()).toBeNull();
  });

  it('returns both params when present', () => {
    setUrl('seti_x', 'seti_x_secret');
    expect(readSetupIntentReturnParams()).toEqual({
      setupIntentId: 'seti_x',
      clientSecret: 'seti_x_secret',
    });
  });

  it('A2 — fails closed on a duplicate `setup_intent` (return_url poisoning: an attacker pair survives into a Stripe-appended genuine pair)', () => {
    globalThis.history.replaceState(
      {},
      '',
      '/settings/billing?setup_intent=seti_evil&setup_intent_client_secret=seti_evil_secret&setup_intent=seti_real&setup_intent_client_secret=seti_real_secret'
    );
    expect(readSetupIntentReturnParams()).toBeNull();
  });

  it('A2 — fails closed on a duplicate `setup_intent_client_secret` even when `setup_intent` itself is unique', () => {
    const params = new URLSearchParams();
    params.append('setup_intent', 'seti_real');
    params.append('setup_intent_client_secret', 'seti_evil_secret');
    params.append('setup_intent_client_secret', 'seti_real_secret');
    globalThis.history.replaceState({}, '', `/settings/billing?${params.toString()}`);
    expect(readSetupIntentReturnParams()).toBeNull();
  });
});

describe('matchSetupIntentReturn — the security predicate', () => {
  it('returns the params when the ids match', () => {
    rememberSetupIntent('seti_x');
    setUrl('seti_x', 'seti_x_secret');
    expect(matchSetupIntentReturn()).toEqual({
      setupIntentId: 'seti_x',
      clientSecret: 'seti_x_secret',
    });
  });

  it('returns null when nothing is stored (the security case)', () => {
    setUrl('seti_x', 'seti_x_secret');
    expect(matchSetupIntentReturn()).toBeNull();
  });

  it('returns null when the stored id differs (the security case)', () => {
    rememberSetupIntent('seti_mine');
    setUrl('seti_theirs', 'seti_theirs_secret');
    expect(matchSetupIntentReturn()).toBeNull();
  });

  it('does NOT clear the binding on a mismatch (the griefing case)', () => {
    rememberSetupIntent('seti_mine');
    setUrl('seti_theirs', 'seti_theirs_secret');
    matchSetupIntentReturn();
    expect(readRememberedSetupIntent()).toBe('seti_mine');
  });

  it('does not clear the binding when there is no return at all', () => {
    rememberSetupIntent('seti_mine');
    setUrl(null, null);
    matchSetupIntentReturn();
    expect(readRememberedSetupIntent()).toBe('seti_mine');
  });
});

describe('isSetupIntentReturnBound', () => {
  it('is true exactly when matchSetupIntentReturn is non-null', () => {
    rememberSetupIntent('seti_x');
    setUrl('seti_x', 'seti_x_secret');
    expect(isSetupIntentReturnBound()).toBe(true);
  });

  it('is false for an unbound return', () => {
    setUrl('seti_x', 'seti_x_secret');
    expect(isSetupIntentReturnBound()).toBe(false);
  });
});

describe('clearSetupIntentReturnParams', () => {
  it('leaves location.search empty and preserves the pathname', () => {
    setUrl('seti_x', 'seti_x_secret');
    clearSetupIntentReturnParams();
    expect(globalThis.location.search).toBe('');
    expect(globalThis.location.pathname).toBe('/settings/billing');
  });

  it('B4 — never throws even when `history.replaceState` throws (Firefox throttling)', () => {
    setUrl('seti_x', 'seti_x_secret');
    const spy = vi.spyOn(globalThis.history, 'replaceState').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(() => clearSetupIntentReturnParams()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
