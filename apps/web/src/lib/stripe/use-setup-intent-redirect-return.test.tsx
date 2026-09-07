import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { track, STRIPE_REDIRECT_EVENTS } from '@/lib/analytics';
import { rememberSetupIntent } from './setup-intent-return';

const { mockRetrieveSetupIntent, mockGetStripe } = vi.hoisted(() => {
  const retrieveSetupIntent = vi.fn();
  return {
    mockRetrieveSetupIntent: retrieveSetupIntent,
    mockGetStripe: vi.fn(() =>
      Promise.resolve<{ retrieveSetupIntent: typeof retrieveSetupIntent } | null>({
        retrieveSetupIntent,
      })
    ),
  };
});
vi.mock('@/lib/stripe/loader', () => ({ getStripe: mockGetStripe }));

import {
  useSetupIntentRedirectReturn,
  PROCESSING_FALLBACK_DELAY_MS,
} from './use-setup-intent-redirect-return';

const RETRY_MESSAGE = 'That card could not be confirmed. Try again.';
const PREV_PK = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

function setReturnUrl(setupIntentId = 'seti_x'): void {
  globalThis.history.replaceState(
    {},
    '',
    `/settings/billing?setup_intent=${setupIntentId}&setup_intent_client_secret=${setupIntentId}_secret&redirect_status=succeeded`
  );
}

function makeCallbacks(): {
  surface: 'settings';
  onStarted: ReturnType<typeof vi.fn<() => void>>;
  onSucceeded: ReturnType<typeof vi.fn<() => void>>;
  onProcessing: ReturnType<typeof vi.fn<() => void>>;
  onProcessingTimeout: ReturnType<typeof vi.fn<() => void>>;
  onFailed: ReturnType<typeof vi.fn<(message: string) => void>>;
} {
  return {
    surface: 'settings',
    onStarted: vi.fn<() => void>(),
    onSucceeded: vi.fn<() => void>(),
    onProcessing: vi.fn<() => void>(),
    onProcessingTimeout: vi.fn<() => void>(),
    onFailed: vi.fn<(message: string) => void>(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage.clear();
  globalThis.history.replaceState({}, '', '/settings/billing');
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_hook';
});

afterEach(() => {
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = PREV_PK;
});

describe('useSetupIntentRedirectReturn', () => {
  it('no params: no callback fires', () => {
    const cb = makeCallbacks();
    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    expect(cb.onStarted).not.toHaveBeenCalled();
    expect(cb.onSucceeded).not.toHaveBeenCalled();
    expect(cb.onProcessing).not.toHaveBeenCalled();
    expect(cb.onFailed).not.toHaveBeenCalled();
    expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
  });

  it('⚠ unbound return (params present, nothing stored) — no callback fires, retrieveSetupIntent is never called, location.search is unchanged (THE SECURITY FIX)', () => {
    setReturnUrl('seti_x');
    const searchBefore = globalThis.location.search;
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    expect(cb.onStarted).not.toHaveBeenCalled();
    expect(cb.onSucceeded).not.toHaveBeenCalled();
    expect(cb.onProcessing).not.toHaveBeenCalled();
    expect(cb.onFailed).not.toHaveBeenCalled();
    expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
    expect(globalThis.location.search).toBe(searchBefore);
  });

  it('⚠ mismatched binding (stored seti_mine, URL says seti_theirs) — same total inertness, and seti_mine is still stored', () => {
    rememberSetupIntent('seti_mine');
    setReturnUrl('seti_theirs');
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    expect(cb.onStarted).not.toHaveBeenCalled();
    expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
    expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBe('seti_mine');
  });

  it("⚠⚠ A1 — the id-matched binding does NOT vouch for the client secret: stored seti_mine, URL seti_mine + an ATTACKER-supplied client secret. retrieveSetupIntent (correctly, per that secret) resolves the ATTACKER's own succeeded SetupIntent (id seti_theirs) — onSucceeded must NOT fire, onFailed must", async () => {
    rememberSetupIntent('seti_mine');
    globalThis.history.replaceState(
      {},
      '',
      '/settings/billing?setup_intent=seti_mine&setup_intent_client_secret=seti_theirs_secret&redirect_status=succeeded'
    );
    mockRetrieveSetupIntent.mockResolvedValue({
      setupIntent: { id: 'seti_theirs', status: 'succeeded' },
    });
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    // The binding DOES match on id, so the retrieve does happen — that is the whole point:
    // the id match alone is not sufficient, the retrieved object's OWN id must be re-checked.
    await waitFor(() => expect(mockRetrieveSetupIntent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(cb.onFailed).toHaveBeenCalledWith(RETRY_MESSAGE));
    expect(cb.onSucceeded).not.toHaveBeenCalled();
  });

  it("F-A — an id-mismatch return does NOT clear the victim's binding (Edge case 2): the victim's own still-pending genuine return must still be able to bind afterwards", async () => {
    rememberSetupIntent('seti_mine');
    globalThis.history.replaceState(
      {},
      '',
      '/settings/billing?setup_intent=seti_mine&setup_intent_client_secret=seti_theirs_secret&redirect_status=succeeded'
    );
    mockRetrieveSetupIntent.mockResolvedValue({
      setupIntent: { id: 'seti_theirs', status: 'succeeded' },
    });
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    await waitFor(() => expect(cb.onFailed).toHaveBeenCalledWith(RETRY_MESSAGE));
    // THE FIX: unlike every other terminal branch, an id-mismatch must leave the binding intact.
    expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBe('seti_mine');
    // The params ARE cleared, though — a refresh must not re-run this same doomed retrieve.
    expect(globalThis.location.search).toBe('');
  });

  it('bound + succeeded: onStarted then onSucceeded; params stripped; binding cleared', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    mockRetrieveSetupIntent.mockResolvedValue({
      setupIntent: { id: 'seti_x', status: 'succeeded' },
    });
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    expect(cb.onStarted).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(cb.onSucceeded).toHaveBeenCalledTimes(1));
    expect(globalThis.location.search).toBe('');
    expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBeNull();
  });

  it('B3 — an exception thrown by onSucceeded is NOT misread as a retrieve failure (a redeem-page regression: track()/posthog.capture is unguarded, and the card is already persisted server-side)', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    mockRetrieveSetupIntent.mockResolvedValue({
      setupIntent: { id: 'seti_x', status: 'succeeded' },
    });
    const cb = makeCallbacks();
    const boom = new Error('onSucceeded blew up (e.g. an unguarded analytics call)');
    cb.onSucceeded.mockImplementation(() => {
      throw boom;
    });

    // The throw escapes as an unhandled rejection by design (see the hook's docblock) — swallow
    // it here so this one deliberately-thrown error doesn't fail an unrelated test.
    const onUnhandledRejection = (reason: unknown): void => {
      expect(reason).toBe(boom);
    };
    process.once('unhandledRejection', onUnhandledRejection);

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    await waitFor(() => expect(cb.onSucceeded).toHaveBeenCalledTimes(1));
    // Let the rejected promise surface (and be swallowed by the listener above).
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.removeListener('unhandledRejection', onUnhandledRejection);

    // THE FIX: the throw must not be caught by a trailing `.catch()` and re-dispatched as
    // `onFailed` — that would repaint a card the webhook already persisted as unconfirmed.
    expect(cb.onFailed).not.toHaveBeenCalled();
    // B4 — the clear/forget already ran BEFORE `onSucceeded` was invoked.
    expect(globalThis.location.search).toBe('');
    expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBeNull();
  });

  it('B4 — a throwing history.replaceState (Firefox rapid-call throttling) still clears the binding and still fires onSucceeded, never stranding the component on "finishing" forever', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    mockRetrieveSetupIntent.mockResolvedValue({
      setupIntent: { id: 'seti_x', status: 'succeeded' },
    });
    const cb = makeCallbacks();
    const replaceStateSpy = vi.spyOn(globalThis.history, 'replaceState').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    // F-C — restore in `finally`: a failed assertion above would otherwise leave the throwing
    // spy installed for every later test in this file, turning one real regression into a wall
    // of unrelated `SecurityError` failures (the `beforeEach`'s own `history.replaceState` call).
    try {
      renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

      await waitFor(() => expect(cb.onSucceeded).toHaveBeenCalledTimes(1));
      expect(cb.onFailed).not.toHaveBeenCalled();
      expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBeNull();
    } finally {
      replaceStateSpy.mockRestore();
    }
  });

  it('bound + processing: onStarted then onProcessing; params KEPT; binding KEPT', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    mockRetrieveSetupIntent.mockResolvedValue({
      setupIntent: { id: 'seti_x', status: 'processing' },
    });
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    expect(cb.onStarted).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(cb.onProcessing).toHaveBeenCalledTimes(1));
    expect(cb.onSucceeded).not.toHaveBeenCalled();
    expect(cb.onFailed).not.toHaveBeenCalled();
    expect(globalThis.location.search).not.toBe('');
    expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBe('seti_x');
  });

  it('bound + requires_payment_method: onFailed(retryMessage) with the exact string; params stripped; binding cleared', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    mockRetrieveSetupIntent.mockResolvedValue({
      setupIntent: { id: 'seti_x', status: 'requires_payment_method' },
    });
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    await waitFor(() => expect(cb.onFailed).toHaveBeenCalledWith(RETRY_MESSAGE));
    expect(globalThis.location.search).toBe('');
    expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBeNull();
  });

  it('bound + getStripe resolves null: onFailed, and the binding SURVIVES (bundled (a) + F-A)', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    mockGetStripe.mockResolvedValueOnce(null);
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    await waitFor(() => expect(cb.onFailed).toHaveBeenCalledWith(RETRY_MESSAGE));
    // 'unresolved', not 'failed' — Stripe.js never loaded, so NOTHING was learned about the
    // bound intent. Deny on evidence, not absence: the binding must survive.
    expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBe('seti_x');
  });

  it('bound + retrieveSetupIntent rejects: onFailed, and the binding SURVIVES (bundled (a) + F-A)', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    mockRetrieveSetupIntent.mockRejectedValue(new Error('network blip'));
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    await waitFor(() => expect(cb.onFailed).toHaveBeenCalledWith(RETRY_MESSAGE));
    // ⚠⚠ SECURITY — an attacker CHOOSES this branch: a malformed
    // `setup_intent_client_secret` rejects deterministically. If a rejection cleared the
    // binding, a crafted link would deny the victim their OWN genuine return.
    expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBe('seti_x');
  });

  it('⚠⚠ bound + retrieveSetupIntent RESOLVES {error} (a Stripe 5xx/429 on an HONEST return): onFailed, params cleared, binding SURVIVES', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    // `retrieveSetupIntent` RESOLVES `{ setupIntent: undefined, error }` — it does NOT reject —
    // on any API error. A genuine return during a Stripe blip lands here, so this branch must
    // never be treated as a mismatch or a terminal failure.
    mockRetrieveSetupIntent.mockResolvedValue({ error: { type: 'api_error' } });
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    await waitFor(() => expect(cb.onFailed).toHaveBeenCalledWith(RETRY_MESSAGE));
    expect(cb.onSucceeded).not.toHaveBeenCalled();
    expect(globalThis.location.search).toBe('');
    expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBe('seti_x');
  });

  it('bound but NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY unset: no callback, no retrieve', () => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    expect(cb.onStarted).not.toHaveBeenCalled();
    expect(mockGetStripe).not.toHaveBeenCalled();
    expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
  });

  it('unmount before the retrieve resolves: no callback fires afterwards', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    let resolveRetrieve: (value: { setupIntent: { id: string; status: string } }) => void = () =>
      undefined;
    mockRetrieveSetupIntent.mockReturnValue(
      new Promise((resolve) => {
        resolveRetrieve = resolve;
      })
    );
    const cb = makeCallbacks();

    const { unmount } = renderHook(() =>
      useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb })
    );
    await waitFor(() => expect(cb.onStarted).toHaveBeenCalledTimes(1));
    unmount();
    resolveRetrieve({ setupIntent: { id: 'seti_x', status: 'succeeded' } });
    await new Promise((r) => setTimeout(r, 0));

    expect(cb.onSucceeded).not.toHaveBeenCalled();
    expect(cb.onFailed).not.toHaveBeenCalled();
  });

  it('changing a callback identity between renders does not re-run the effect (one retrieve total)', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    mockRetrieveSetupIntent.mockResolvedValue({
      setupIntent: { id: 'seti_x', status: 'succeeded' },
    });
    const cb = makeCallbacks();

    const { rerender } = renderHook(
      (props: { onSucceeded: () => void }) =>
        useSetupIntentRedirectReturn({
          retryMessage: RETRY_MESSAGE,
          surface: 'settings',
          onStarted: cb.onStarted,
          onSucceeded: props.onSucceeded,
          onProcessing: cb.onProcessing,
          onProcessingTimeout: cb.onProcessingTimeout,
          onFailed: cb.onFailed,
        }),
      { initialProps: { onSucceeded: cb.onSucceeded } }
    );

    const secondOnSucceeded = vi.fn<() => void>();
    rerender({ onSucceeded: secondOnSucceeded });

    await waitFor(() => expect(mockRetrieveSetupIntent).toHaveBeenCalledTimes(1));
    // The LATEST callback (post-rerender) is the one that fires — proving the ref, not a stale
    // closure, drives the call — while the effect itself only ran once.
    expect(secondOnSucceeded).toHaveBeenCalledTimes(1);
    expect(cb.onSucceeded).not.toHaveBeenCalled();
    expect(mockGetStripe).toHaveBeenCalledTimes(1);
  });
});

describe('BAL-529 §D — unbound-return observability', () => {
  it('fires exactly ONE stripe_redirect_return_unbound with { surface, reason: no_binding } and NOTHING else', () => {
    setReturnUrl('seti_x');
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(STRIPE_REDIRECT_EVENTS.RETURN_UNBOUND, {
      surface: 'settings',
      reason: 'no_binding',
    });
  });

  it('reason: id_mismatch for a mismatched binding', () => {
    rememberSetupIntent('seti_mine');
    setReturnUrl('seti_theirs');
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    expect(track).toHaveBeenCalledWith(STRIPE_REDIRECT_EVENTS.RETURN_UNBOUND, {
      surface: 'settings',
      reason: 'id_mismatch',
    });
  });

  it('reason: duplicate_params for a duplicated pair', () => {
    globalThis.history.replaceState(
      {},
      '',
      '/settings/billing?setup_intent=seti_evil&setup_intent_client_secret=seti_evil_secret&setup_intent=seti_real&setup_intent_client_secret=seti_real_secret'
    );
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    expect(track).toHaveBeenCalledWith(STRIPE_REDIRECT_EVENTS.RETURN_UNBOUND, {
      surface: 'settings',
      reason: 'duplicate_params',
    });
  });

  it('a bound return fires NO unbound event', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    mockRetrieveSetupIntent.mockResolvedValue({
      setupIntent: { id: 'seti_x', status: 'succeeded' },
    });
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    await waitFor(() => expect(cb.onSucceeded).toHaveBeenCalledTimes(1));
    expect(track).not.toHaveBeenCalledWith(
      STRIPE_REDIRECT_EVENTS.RETURN_UNBOUND,
      expect.anything()
    );
  });

  it('no params at all fires NO event', () => {
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    expect(track).not.toHaveBeenCalled();
  });

  it('⚠ the event does NOT break inertness: no callback, location.search unchanged, binding untouched', () => {
    rememberSetupIntent('seti_mine');
    setReturnUrl('seti_theirs');
    const searchBefore = globalThis.location.search;
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));

    expect(cb.onStarted).not.toHaveBeenCalled();
    expect(cb.onSucceeded).not.toHaveBeenCalled();
    expect(cb.onProcessing).not.toHaveBeenCalled();
    expect(cb.onFailed).not.toHaveBeenCalled();
    expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
    expect(globalThis.location.search).toBe(searchBefore);
    expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBe('seti_mine');
  });

  it('surface: redeem is reported when the redeem surface mounts the hook', () => {
    setReturnUrl('seti_x');

    renderHook(() =>
      useSetupIntentRedirectReturn({
        retryMessage: RETRY_MESSAGE,
        surface: 'redeem',
        onStarted: vi.fn(),
        onSucceeded: vi.fn(),
        onProcessing: vi.fn(),
        onProcessingTimeout: vi.fn(),
        onFailed: vi.fn(),
      })
    );

    expect(track).toHaveBeenCalledWith(STRIPE_REDIRECT_EVENTS.RETURN_UNBOUND, {
      surface: 'redeem',
      reason: 'no_binding',
    });
  });
});

/**
 * BAL-529 M5 — drains the hook's `getStripe().then().catch().then()` chain (real Promise
 * microtasks — NOT part of Vitest's faked timer system, which only intercepts
 * setTimeout/setInterval/Date) without tying the fake clock to real wall time. Deliberately NOT
 * `vi.useFakeTimers({ shouldAdvanceTime: true })` + `waitFor`: that ties the fake 15s delay to
 * REAL elapsed wall-clock time, which is exactly what makes a timer test flake on a loaded
 * machine (memory `reference_web_timer_tests_flake_under_local_load`) — several hops are needed
 * to drain the chain, so a fixed count is used rather than a real-time-bounded `waitFor`.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('BAL-529 M5 — the bounded processing timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('M5 — onProcessingTimeout fires exactly once, PROCESSING_FALLBACK_DELAY_MS after onProcessing', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    mockRetrieveSetupIntent.mockResolvedValue({
      setupIntent: { id: 'seti_x', status: 'processing' },
    });
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));
    await act(flushMicrotasks);
    expect(cb.onProcessing).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROCESSING_FALLBACK_DELAY_MS - 1);
    });
    expect(cb.onProcessingTimeout).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(cb.onProcessingTimeout).toHaveBeenCalledTimes(1);
  });

  it('⚠⚠ M5 — the timeout does NOT clear the URL params and does NOT clear the binding', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    const searchBefore = globalThis.location.search;
    mockRetrieveSetupIntent.mockResolvedValue({
      setupIntent: { id: 'seti_x', status: 'processing' },
    });
    const cb = makeCallbacks();

    renderHook(() => useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb }));
    await act(flushMicrotasks);
    expect(cb.onProcessing).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROCESSING_FALLBACK_DELAY_MS);
    });

    expect(cb.onProcessingTimeout).toHaveBeenCalledTimes(1);
    // The ticket's hard constraint — a `processing` intent is still live, and a refresh must
    // still be able to re-check it.
    expect(globalThis.location.search).toBe(searchBefore);
    expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBe('seti_x');
  });

  it('M5 — no timer is armed on succeeded / failed / unresolved', async () => {
    const scenarios = [
      {
        label: 'succeeded',
        arrange: (): void => {
          mockRetrieveSetupIntent.mockResolvedValue({
            setupIntent: { id: 'seti_x', status: 'succeeded' },
          });
        },
        assertSettled: (cb: ReturnType<typeof makeCallbacks>): void => {
          expect(cb.onSucceeded).toHaveBeenCalledTimes(1);
        },
      },
      {
        label: 'failed',
        arrange: (): void => {
          mockRetrieveSetupIntent.mockResolvedValue({
            setupIntent: { id: 'seti_x', status: 'requires_payment_method' },
          });
        },
        assertSettled: (cb: ReturnType<typeof makeCallbacks>): void => {
          expect(cb.onFailed).toHaveBeenCalledTimes(1);
        },
      },
      {
        label: 'unresolved',
        arrange: (): void => {
          mockRetrieveSetupIntent.mockRejectedValue(new Error('network blip'));
        },
        assertSettled: (cb: ReturnType<typeof makeCallbacks>): void => {
          expect(cb.onFailed).toHaveBeenCalledTimes(1);
        },
      },
    ];

    for (const scenario of scenarios) {
      globalThis.sessionStorage.clear();
      rememberSetupIntent('seti_x');
      setReturnUrl('seti_x');
      scenario.arrange();
      const cb = makeCallbacks();

      const { unmount } = renderHook(() =>
        useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb })
      );
      await act(flushMicrotasks);
      scenario.assertSettled(cb);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PROCESSING_FALLBACK_DELAY_MS + 1_000);
      });

      expect(cb.onProcessingTimeout).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('M5 — unmounting before the bound clears the timer (no callback after unmount)', async () => {
    rememberSetupIntent('seti_x');
    setReturnUrl('seti_x');
    mockRetrieveSetupIntent.mockResolvedValue({
      setupIntent: { id: 'seti_x', status: 'processing' },
    });
    const cb = makeCallbacks();
    // ⚠ The `cancelled` flag ALSO guards the callback, so a behavioural assertion alone
    // ("no callback after unmount") stays green even if `clearTimeout` itself is deleted from
    // the cleanup — that guard is redundant-by-design defence in depth, not proof this specific
    // line runs. Spy on the real `clearTimeout` so dropping the call is directly observable.
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const { unmount } = renderHook(() =>
      useSetupIntentRedirectReturn({ retryMessage: RETRY_MESSAGE, ...cb })
    );
    await act(flushMicrotasks);
    expect(cb.onProcessing).toHaveBeenCalledTimes(1);

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROCESSING_FALLBACK_DELAY_MS + 1_000);
    });

    expect(cb.onProcessingTimeout).not.toHaveBeenCalled();
  });
});
