import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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
vi.mock('@/lib/stripe-loader', () => ({ getStripe: mockGetStripe }));

import { useSetupIntentRedirectReturn } from './use-setup-intent-redirect-return';

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
  onStarted: ReturnType<typeof vi.fn<() => void>>;
  onSucceeded: ReturnType<typeof vi.fn<() => void>>;
  onProcessing: ReturnType<typeof vi.fn<() => void>>;
  onFailed: ReturnType<typeof vi.fn<(message: string) => void>>;
} {
  return {
    onStarted: vi.fn<() => void>(),
    onSucceeded: vi.fn<() => void>(),
    onProcessing: vi.fn<() => void>(),
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
          onStarted: cb.onStarted,
          onSucceeded: props.onSucceeded,
          onProcessing: cb.onProcessing,
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
