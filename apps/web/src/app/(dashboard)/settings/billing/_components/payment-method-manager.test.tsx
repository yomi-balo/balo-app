import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, SETTINGS_EVENTS } from '@/lib/analytics';
import {
  SETUP_INTENT_PROCESSING_FALLBACK_MESSAGE,
  PROCESSING_FALLBACK_DELAY_MS,
} from '@/lib/stripe/use-setup-intent-redirect-return';
import type { SavedCard } from '@/components/billing/top-up/types';

const mockPush = vi.fn();
const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh, back: vi.fn() }),
}));

const mockRemoveSavedCardAction = vi.fn();
vi.mock('@/lib/credit/actions', () => ({
  removeSavedCardAction: (...a: unknown[]) => mockRemoveSavedCardAction(...a),
  // The capture panel's own action, mocked so a Change/Add press never depends on real Stripe.
  startCardCaptureAction: vi.fn(async () => ({
    ok: true,
    clientSecret: 'seti_secret',
    setupIntentId: 'seti_settings_capture',
    publishableKey: 'pk_test_settings',
  })),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

const { mockConfirmSetup } = vi.hoisted(() => ({ mockConfirmSetup: vi.fn() }));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmSetup: mockConfirmSetup }),
  useElements: () => ({}),
}));

const mockTrack = vi.mocked(track);

// BAL-529 M4 — the manager now wraps its phase bodies in a real `AnimatePresence`. Web tests do
// not globally stub `motion/react`, and under the real thing an exiting child stays mounted
// until its exit animation completes, so "the old content is gone after the phase changes"
// assertions go flaky. Precedent: `onboarding-wizard.test.tsx:78`, `referral-invite-section.
// test.tsx:35`. The animation itself is therefore untestable here — see M4's own test comments
// for what IS pinned instead.
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...rest }: React.ComponentProps<'div'>) => <div {...rest}>{children}</div>,
  },
  useReducedMotion: () => true,
}));

import { PaymentMethodManager } from './payment-method-manager';

const CARD: SavedCard = {
  brand: 'visa',
  last4: '4242',
  expMonth: 8,
  expYear: 2028,
  mandateActive: true,
};

const PREV_PK = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_settings';
  globalThis.history.replaceState({}, '', '/settings/billing');
  // BAL-526 — jsdom persists sessionStorage across tests in a file; without this a binding
  // written by one test leaks into the next and produces a false green.
  globalThis.sessionStorage.clear();
});

afterEach(() => {
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = PREV_PK;
});

describe('PaymentMethodManager', () => {
  it('renders the saved-card row with an accessible Remove button when a card is present', () => {
    render(<PaymentMethodManager card={CARD} currentMode="notify_only" onRemoved={vi.fn()} />);
    expect(screen.getByText('Visa •••• 4242')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove card' })).toBeInTheDocument();
  });

  it('renders the "Add a card" empty state when there is no card', () => {
    render(<PaymentMethodManager card={null} currentMode="notify_only" onRemoved={vi.fn()} />);
    expect(screen.getByRole('button', { name: /add a card/i })).toBeInTheDocument();
  });

  describe('Stripe unconfigured', () => {
    beforeEach(() => {
      delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    });

    it('shows the fallback line and disables the empty-state Add button', () => {
      render(<PaymentMethodManager card={null} currentMode="notify_only" onRemoved={vi.fn()} />);
      expect(
        screen.getByText("Card payments aren't configured right now. Please try again later.")
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add a card/i })).toBeDisabled();
    });

    it('makes Change inert (no capture panel opens) while Remove stays live', async () => {
      render(<PaymentMethodManager card={CARD} currentMode="auto_topup" onRemoved={vi.fn()} />);

      await userEvent.click(screen.getByRole('button', { name: /change/i }));
      expect(screen.queryByTestId('payment-element')).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
      expect(
        await screen.findByRole('button', { name: 'Remove card & switch to Just notify me' })
      ).toBeInTheDocument();
    });

    it('M3 — with Stripe unconfigured the Change control is disabled and carries the reason', () => {
      render(<PaymentMethodManager card={CARD} currentMode="auto_topup" onRemoved={vi.fn()} />);

      const change = screen.getByRole('button', { name: 'Change' });
      expect(change).toBeDisabled();
      expect(change).toHaveAccessibleDescription(
        "Changing your card isn't available right now — please try again later."
      );
    });
  });

  it('M3 — with Stripe configured Change is enabled and has NO description', () => {
    render(<PaymentMethodManager card={CARD} currentMode="notify_only" onRemoved={vi.fn()} />);

    const change = screen.getByRole('button', { name: 'Change' });
    expect(change).toBeEnabled();
    expect(change).not.toHaveAccessibleDescription();
  });

  it('M3 — the accessible name is still exactly "Change"', () => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    render(<PaymentMethodManager card={CARD} currentMode="notify_only" onRemoved={vi.fn()} />);

    // A widened name (e.g. "Change — Changing your card isn't available right now — please try
    // again later.") would make this throw — the reason must be attached only via
    // `aria-describedby`.
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('Change opens the capture panel, and Cancel returns to the row with zero action calls', async () => {
    render(<PaymentMethodManager card={CARD} currentMode="notify_only" onRemoved={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /change/i }));
    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Visa •••• 4242')).toBeInTheDocument();
    expect(mockRemoveSavedCardAction).not.toHaveBeenCalled();
  });

  it('M4 — pressing Change swaps the row for the capture panel', async () => {
    render(<PaymentMethodManager card={CARD} currentMode="notify_only" onRemoved={vi.fn()} />);
    expect(screen.getByText('Visa •••• 4242')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /change/i }));

    // The swap still works through `AnimatePresence` (with the test-local motion stub in
    // place, this is the whole point of the stub — the row unmounts, the panel mounts).
    expect(screen.queryByText('Visa •••• 4242')).not.toBeInTheDocument();
    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();
  });

  it('M4 — Cancel swaps back to the saved-card row', async () => {
    render(<PaymentMethodManager card={CARD} currentMode="notify_only" onRemoved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /change/i }));
    await screen.findByTestId('payment-element');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByTestId('payment-element')).not.toBeInTheDocument();
    expect(screen.getByText('Visa •••• 4242')).toBeInTheDocument();
  });

  it('remove confirm calls the action and fires onRemoved with the response', async () => {
    mockRemoveSavedCardAction.mockResolvedValue({
      ok: true,
      lowBalanceMode: 'notify_only',
      modeReconciled: true,
    });
    const onRemoved = vi.fn();

    render(<PaymentMethodManager card={CARD} currentMode="auto_topup" onRemoved={onRemoved} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove card & switch to Just notify me' })
    );

    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith('notify_only', true));
  });

  it('remove failure toasts and keeps the dialog open with the card untouched', async () => {
    mockRemoveSavedCardAction.mockResolvedValue({ ok: false, error: 'error' });
    const onRemoved = vi.fn();

    render(<PaymentMethodManager card={CARD} currentMode="notify_only" onRemoved={onRemoved} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove card' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("We couldn't remove that card — please try again.")
    );
    expect(onRemoved).not.toHaveBeenCalled();
    expect(screen.getByText('Remove Visa •••• 4242?')).toBeInTheDocument();
  });

  it('a settlement_outstanding refusal blocks removal with factual copy, never the generic failure toast (security MEDIUM)', async () => {
    mockRemoveSavedCardAction.mockResolvedValue({ ok: false, error: 'settlement_outstanding' });
    const onRemoved = vi.fn();

    render(<PaymentMethodManager card={CARD} currentMode="notify_only" onRemoved={onRemoved} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove card' }));

    expect(
      await screen.findByText(/unsettled consultation time on this card/i)
    ).toBeInTheDocument();
    expect(onRemoved).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove card/i })).not.toBeInTheDocument();

    // Closing and reopening the dialog clears the block — it is not a permanent dead end.
    await userEvent.click(screen.getByRole('button', { name: 'Keep card' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
    expect(screen.queryByText(/unsettled consultation time on this card/i)).not.toBeInTheDocument();
  });

  describe('3DS/SCA redirect return', () => {
    function setReturnUrl(status = 'succeeded', setupIntentId = 'seti_x'): void {
      // BAL-526 — the hook only reacts to a return this tab is BOUND to; seed the binding so
      // these tests keep testing what they claim.
      globalThis.sessionStorage.setItem('balo.stripe.setup-intent.v1', setupIntentId);
      globalThis.history.replaceState(
        {},
        '',
        `/settings/billing?setup_intent=${setupIntentId}&setup_intent_client_secret=${setupIntentId}_secret&redirect_status=${status}`
      );
    }

    it('succeeded: moves to syncing, strips the URL params, and refreshes', async () => {
      setReturnUrl('succeeded');
      mockRetrieveSetupIntent.mockResolvedValue({
        setupIntent: { id: 'seti_x', status: 'succeeded' },
      });

      render(<PaymentMethodManager card={null} currentMode="notify_only" onRemoved={vi.fn()} />);

      expect(await screen.findByText(/Card saved — updating/i)).toBeInTheDocument();
      expect(globalThis.location.search).toBe('');
      expect(mockRefresh).toHaveBeenCalled();
    });

    it('failed: strips params and shows the inline retry message', async () => {
      setReturnUrl('failed');
      mockRetrieveSetupIntent.mockResolvedValue({
        setupIntent: { id: 'seti_x', status: 'requires_payment_method' },
      });

      render(<PaymentMethodManager card={null} currentMode="notify_only" onRemoved={vi.fn()} />);

      expect(
        await screen.findByText("That card couldn't be confirmed. You can try again.")
      ).toBeInTheDocument();
      expect(globalThis.location.search).toBe('');
    });

    it('processing: stays on the finishing state and keeps the params', async () => {
      setReturnUrl('processing');
      mockRetrieveSetupIntent.mockResolvedValue({
        setupIntent: { id: 'seti_x', status: 'processing' },
      });

      render(<PaymentMethodManager card={null} currentMode="notify_only" onRemoved={vi.fn()} />);

      expect(await screen.findByText(/Finishing up/i)).toBeInTheDocument();
      expect(globalThis.location.search).not.toBe('');
      // BAL-526 — the binding must ALSO survive, or a refresh's re-check would be rejected.
      expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBe('seti_x');
    });

    describe('BAL-529 M5 — the bounded processing fallback', () => {
      // Deterministic: no `shouldAdvanceTime` — the fake clock only moves via explicit
      // `advanceTimersByTimeAsync`, so this is not sensitive to real wall-clock load (memory
      // `reference_web_timer_tests_flake_under_local_load`).
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('M5 — a processing return shows the finishing spinner, then the fallback copy after the bound', async () => {
        setReturnUrl('processing');
        mockRetrieveSetupIntent.mockResolvedValue({
          setupIntent: { id: 'seti_x', status: 'processing' },
        });

        render(<PaymentMethodManager card={null} currentMode="notify_only" onRemoved={vi.fn()} />);
        // Drain the hook's promise chain (real microtasks, unaffected by the faked clock).
        await act(async () => {
          for (let i = 0; i < 10; i += 1) await Promise.resolve();
        });
        expect(screen.getByText('Finishing up — just confirming your card…')).toBeInTheDocument();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(PROCESSING_FALLBACK_DELAY_MS);
        });

        expect(screen.getByText(SETUP_INTENT_PROCESSING_FALLBACK_MESSAGE)).toBeInTheDocument();
        expect(
          screen.queryByText('Finishing up — just confirming your card…')
        ).not.toBeInTheDocument();
        // FIX ROUND 2 G3 — hand-copied FULL LITERAL, not just the imported constant. Every
        // other assertion in this suite reads `SETUP_INTENT_PROCESSING_FALLBACK_MESSAGE` on
        // BOTH sides (source and spec), which is a vacuous pin: editing the copy in
        // `use-setup-intent-redirect-return.ts` changes both sides at once and every test stays
        // green. ⚠ `toBe` on `.textContent`, NOT `toHaveTextContent` — jest-dom's
        // `toHaveTextContent` does a PARTIAL (substring) match by default, so appending or
        // prepending text to the constant would still satisfy it; only exact equality catches
        // every mutation.
        expect(screen.getByText(SETUP_INTENT_PROCESSING_FALLBACK_MESSAGE).textContent).toBe(
          'This is taking longer than usual. Your card is still being confirmed — refresh this page in a moment to check again.'
        );
      });

      it('M5 — the fallback leaves location.search and the binding untouched', async () => {
        setReturnUrl('processing');
        mockRetrieveSetupIntent.mockResolvedValue({
          setupIntent: { id: 'seti_x', status: 'processing' },
        });
        const searchBefore = globalThis.location.search;

        render(<PaymentMethodManager card={null} currentMode="notify_only" onRemoved={vi.fn()} />);
        await act(async () => {
          for (let i = 0; i < 10; i += 1) await Promise.resolve();
        });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(PROCESSING_FALLBACK_DELAY_MS);
        });

        expect(screen.getByText(SETUP_INTENT_PROCESSING_FALLBACK_MESSAGE)).toBeInTheDocument();
        expect(globalThis.location.search).toBe(searchBefore);
        expect(globalThis.sessionStorage.getItem('balo.stripe.setup-intent.v1')).toBe('seti_x');
      });

      it('FIX ROUND 1 F7 (UX U2) — the fallback copy carries aria-live="polite", both before and after the swap', async () => {
        setReturnUrl('processing');
        mockRetrieveSetupIntent.mockResolvedValue({
          setupIntent: { id: 'seti_x', status: 'processing' },
        });

        render(<PaymentMethodManager card={null} currentMode="notify_only" onRemoved={vi.fn()} />);
        await act(async () => {
          for (let i = 0; i < 10; i += 1) await Promise.resolve();
        });

        const finishingCopy = screen.getByText('Finishing up — just confirming your card…');
        expect(finishingCopy).toHaveAttribute('aria-live', 'polite');
        expect(finishingCopy).not.toHaveAttribute('role', 'status');
        expect(finishingCopy).not.toHaveAttribute('role', 'alert');

        await act(async () => {
          await vi.advanceTimersByTimeAsync(PROCESSING_FALLBACK_DELAY_MS);
        });

        const fallbackCopy = screen.getByText(SETUP_INTENT_PROCESSING_FALLBACK_MESSAGE);
        expect(fallbackCopy).toHaveAttribute('aria-live', 'polite');
        expect(fallbackCopy).not.toHaveAttribute('role', 'status');
        expect(fallbackCopy).not.toHaveAttribute('role', 'alert');
      });
    });

    it('a thrown retrieveSetupIntent recovers to idle with the retry message — not a permanent spinner (review MINOR)', async () => {
      setReturnUrl('succeeded');
      mockRetrieveSetupIntent.mockRejectedValue(new Error('network blip'));

      render(<PaymentMethodManager card={CARD} currentMode="notify_only" onRemoved={vi.fn()} />);

      expect(
        await screen.findByText("That card couldn't be confirmed. You can try again.")
      ).toBeInTheDocument();
      expect(globalThis.location.search).toBe('');
      // The section recovers to the saved-card row — never stuck on "Finishing up…" forever.
      expect(screen.getByText('Visa •••• 4242')).toBeInTheDocument();
      expect(screen.queryByText(/Finishing up/i)).not.toBeInTheDocument();
    });

    it('a null Stripe instance also recovers to idle, never sticking on "Finishing up…" (review MINOR)', async () => {
      setReturnUrl('succeeded');
      mockGetStripe.mockResolvedValueOnce(null);

      render(<PaymentMethodManager card={CARD} currentMode="notify_only" onRemoved={vi.fn()} />);

      expect(
        await screen.findByText("That card couldn't be confirmed. You can try again.")
      ).toBeInTheDocument();
      expect(globalThis.location.search).toBe('');
    });

    it('a redirect return this session never started is ignored — no syncing paint, no URL rewrite (security LOW)', async () => {
      // Set the URL WITHOUT storing a binding — a crafted link.
      globalThis.history.replaceState(
        {},
        '',
        '/settings/billing?setup_intent=seti_x&setup_intent_client_secret=seti_x_secret&redirect_status=succeeded'
      );
      mockRetrieveSetupIntent.mockResolvedValue({ setupIntent: { status: 'succeeded' } });

      render(<PaymentMethodManager card={CARD} currentMode="notify_only" onRemoved={vi.fn()} />);

      expect(screen.getByText('Visa •••• 4242')).toBeInTheDocument();
      expect(screen.queryByText(/Card saved — updating/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Finishing up/i)).not.toBeInTheDocument();
      expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
      expect(globalThis.location.search).toBe(
        '?setup_intent=seti_x&setup_intent_client_secret=seti_x_secret&redirect_status=succeeded'
      );
    });

    it('a redirect return this session never started, with no card on file, still renders the empty state as normal (security LOW)', async () => {
      globalThis.history.replaceState(
        {},
        '',
        '/settings/billing?setup_intent=seti_x&setup_intent_client_secret=seti_x_secret&redirect_status=succeeded'
      );

      render(<PaymentMethodManager card={null} currentMode="notify_only" onRemoved={vi.fn()} />);

      expect(screen.getByRole('button', { name: /add a card/i })).toBeInTheDocument();
      expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
    });

    it('fires BILLING_CARD_SAVED only once the refreshed card prop actually differs — not on the redirect return alone (security LOW)', async () => {
      setReturnUrl('succeeded');
      mockRetrieveSetupIntent.mockResolvedValue({
        setupIntent: { id: 'seti_x', status: 'succeeded' },
      });

      const { rerender } = render(
        <PaymentMethodManager card={null} currentMode="notify_only" onRemoved={vi.fn()} />
      );

      expect(await screen.findByText(/Card saved — updating/i)).toBeInTheDocument();
      expect(mockTrack).not.toHaveBeenCalledWith(
        SETTINGS_EVENTS.BILLING_CARD_SAVED,
        expect.anything()
      );

      rerender(<PaymentMethodManager card={CARD} currentMode="notify_only" onRemoved={vi.fn()} />);

      await waitFor(() =>
        expect(mockTrack).toHaveBeenCalledWith(SETTINGS_EVENTS.BILLING_CARD_SAVED, {
          intent: 'add',
        })
      );
    });
  });

  it('fires BILLING_CARD_SAVED with intent "change" once the refreshed card prop actually differs after an inline capture (security LOW / review MINOR)', async () => {
    mockConfirmSetup.mockResolvedValue({});

    const { rerender } = render(
      <PaymentMethodManager card={CARD} currentMode="notify_only" onRemoved={vi.fn()} />
    );

    await userEvent.click(screen.getByRole('button', { name: /change/i }));
    await userEvent.click(await screen.findByRole('button', { name: /save card/i }));

    expect(await screen.findByText(/Card saved — updating/i)).toBeInTheDocument();
    expect(mockTrack).not.toHaveBeenCalledWith(
      SETTINGS_EVENTS.BILLING_CARD_SAVED,
      expect.anything()
    );

    const newCard: SavedCard = { ...CARD, last4: '1111' };
    rerender(<PaymentMethodManager card={newCard} currentMode="notify_only" onRemoved={vi.fn()} />);

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith(SETTINGS_EVENTS.BILLING_CARD_SAVED, {
        intent: 'change',
      })
    );
  });
});
