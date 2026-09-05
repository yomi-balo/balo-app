import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const { mockStart, mockConfirmSetup, mockRetrieveSetupIntent, mockToastSuccess } = vi.hoisted(
  () => ({
    mockStart: vi.fn(),
    mockConfirmSetup: vi.fn(),
    mockRetrieveSetupIntent: vi.fn(),
    mockToastSuccess: vi.fn(),
  })
);

vi.mock('../_actions/start-continue-to-mandate', () => ({
  startContinueToMandate: (...a: unknown[]) => mockStart(...a),
}));
vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: vi.fn() } }));

// ⚠ BAL-526 — mock `@/lib/stripe-loader`'s `getStripe`, NOT `@stripe/stripe-js`'s `loadStripe`
// directly. The hook imports `getStripe`, which wraps `loadStripe` and MEMOISES it per key in a
// module-level `Map` — a `mockResolvedValueOnce`/`mockRejectedValueOnce` on `loadStripe` would be
// swallowed by that cache across tests in this file.
const mockGetStripe = vi.fn<
  (publishableKey: string) => Promise<{
    confirmSetup: typeof mockConfirmSetup;
    retrieveSetupIntent: typeof mockRetrieveSetupIntent;
  } | null>
>(() =>
  Promise.resolve({
    confirmSetup: mockConfirmSetup,
    retrieveSetupIntent: mockRetrieveSetupIntent,
  })
);
vi.mock('@/lib/stripe-loader', () => ({
  getStripe: (publishableKey: string) => mockGetStripe(publishableKey),
}));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmSetup: mockConfirmSetup }),
  useElements: () => ({}),
}));

import { ContinueToMandate } from './continue-to-mandate';
import { track, PROMO_EVENTS } from '@/lib/analytics';

const COMPANY_ID = 'company-1';
const SETUP_INTENT_KEY = 'balo.stripe.setup-intent.v1';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mockGetStripe.mockResolvedValue({
    confirmSetup: mockConfirmSetup,
    retrieveSetupIntent: mockRetrieveSetupIntent,
  });
  globalThis.history.replaceState({}, '', '/');
  // BAL-526 — jsdom persists sessionStorage across tests in a file.
  globalThis.sessionStorage.clear();
});

describe('ContinueToMandate', () => {
  it('renders the Model-C prompt and fires promo_continue_prompt_shown on mount', () => {
    render(<ContinueToMandate companyId={COMPANY_ID} />);
    expect(
      screen.getByText(/add a card to keep going — no charge until then/i)
    ).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(PROMO_EVENTS.PROMO_CONTINUE_PROMPT_SHOWN, {
      company_id: COMPANY_ID,
    });
  });

  it('mounts the card form when the seam returns ready', async () => {
    mockStart.mockResolvedValue({
      status: 'ready',
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_new',
      publishableKey: 'pk_test_abc',
    });
    const user = userEvent.setup();
    render(<ContinueToMandate companyId={COMPANY_ID} />);
    await user.click(screen.getByRole('button', { name: /add a card/i }));

    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save card/i })).toBeInTheDocument();
  });

  it('BAL-526: the start path records the binding', async () => {
    mockStart.mockResolvedValue({
      status: 'ready',
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_new',
      publishableKey: 'pk_test_abc',
    });
    const user = userEvent.setup();
    render(<ContinueToMandate companyId={COMPANY_ID} />);
    await user.click(screen.getByRole('button', { name: /add a card/i }));

    await screen.findByTestId('payment-element');
    expect(globalThis.sessionStorage.getItem(SETUP_INTENT_KEY)).toBe('seti_new');
  });

  it('confirms the card and fires promo_continue_card_captured + a toast on success', async () => {
    mockStart.mockResolvedValue({
      status: 'ready',
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_new',
      publishableKey: 'pk_test_abc',
    });
    mockConfirmSetup.mockResolvedValue({ setupIntent: { status: 'succeeded' } });
    const user = userEvent.setup();
    render(<ContinueToMandate companyId={COMPANY_ID} />);
    await user.click(screen.getByRole('button', { name: /add a card/i }));
    await user.click(await screen.findByRole('button', { name: /save card/i }));

    expect(await screen.findByText(/set to keep going/i)).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(PROMO_EVENTS.PROMO_CONTINUE_CARD_CAPTURED, {
      company_id: COMPANY_ID,
    });
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('A2 — confirmSetup return_url is origin+pathname ONLY, never the full URL, even when the address bar already carries a (crafted) setup_intent query string', async () => {
    globalThis.history.replaceState(
      {},
      '',
      '/redeem?setup_intent=seti_evil&setup_intent_client_secret=seti_evil_secret'
    );
    mockStart.mockResolvedValue({
      status: 'ready',
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_new',
      publishableKey: 'pk_test_abc',
    });
    mockConfirmSetup.mockResolvedValue({});
    const user = userEvent.setup();
    render(<ContinueToMandate companyId={COMPANY_ID} />);
    await user.click(screen.getByRole('button', { name: /add a card/i }));
    await user.click(await screen.findByRole('button', { name: /save card/i }));

    expect(mockConfirmSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmParams: { return_url: 'http://localhost:3000/redeem' },
      })
    );
  });

  it('BAL-526: an inline (non-redirect) capture clears the binding', async () => {
    mockStart.mockResolvedValue({
      status: 'ready',
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_new',
      publishableKey: 'pk_test_abc',
    });
    mockConfirmSetup.mockResolvedValue({ setupIntent: { status: 'succeeded' } });
    const user = userEvent.setup();
    render(<ContinueToMandate companyId={COMPANY_ID} />);
    await user.click(screen.getByRole('button', { name: /add a card/i }));
    await user.click(await screen.findByRole('button', { name: /save card/i }));

    await screen.findByText(/set to keep going/i);
    expect(globalThis.sessionStorage.getItem(SETUP_INTENT_KEY)).toBeNull();
  });

  it('surfaces a card error inline without firing the captured event', async () => {
    mockStart.mockResolvedValue({
      status: 'ready',
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_new',
      publishableKey: 'pk_test_abc',
    });
    mockConfirmSetup.mockResolvedValue({ error: { message: 'Your card was declined.' } });
    const user = userEvent.setup();
    render(<ContinueToMandate companyId={COMPANY_ID} />);
    await user.click(screen.getByRole('button', { name: /add a card/i }));
    await user.click(await screen.findByRole('button', { name: /save card/i }));

    expect(await screen.findByText('Your card was declined.')).toBeInTheDocument();
    expect(track).not.toHaveBeenCalledWith(PROMO_EVENTS.PROMO_CONTINUE_CARD_CAPTURED, {
      company_id: COMPANY_ID,
    });
  });

  it('short-circuits to the already-active message', async () => {
    mockStart.mockResolvedValue({ status: 'already_active' });
    const user = userEvent.setup();
    render(<ContinueToMandate companyId={COMPANY_ID} />);
    await user.click(screen.getByRole('button', { name: /add a card/i }));
    expect(await screen.findByText(/already have a card on file/i)).toBeInTheDocument();
  });

  it('shows the forbidden guidance when the caller cannot manage billing', async () => {
    mockStart.mockResolvedValue({ status: 'forbidden' });
    const user = userEvent.setup();
    render(<ContinueToMandate companyId={COMPANY_ID} />);
    await user.click(screen.getByRole('button', { name: /add a card/i }));
    expect(await screen.findByText(/ask an owner or admin/i)).toBeInTheDocument();
  });

  describe('3DS/SCA redirect return', () => {
    function setReturnUrl(status = 'succeeded', setupIntentId = 'seti_x'): void {
      // BAL-526 — the hook only reacts to a return this tab is BOUND to; seed the binding so
      // these tests keep testing what they claim.
      globalThis.sessionStorage.setItem(SETUP_INTENT_KEY, setupIntentId);
      globalThis.history.replaceState(
        {},
        '',
        `/redeem?setup_intent=${setupIntentId}&setup_intent_client_secret=${setupIntentId}_secret&redirect_status=${status}`
      );
    }

    it('confirms a succeeded SetupIntent on return — captured + toast, no exhausted event, URL cleaned', async () => {
      vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_redirect');
      setReturnUrl('succeeded');
      mockRetrieveSetupIntent.mockResolvedValue({
        setupIntent: { id: 'seti_x', status: 'succeeded' },
      });

      render(<ContinueToMandate companyId={COMPANY_ID} />);

      expect(await screen.findByText(/set to keep going/i)).toBeInTheDocument();
      expect(mockRetrieveSetupIntent).toHaveBeenCalledWith('seti_x_secret');
      expect(track).toHaveBeenCalledWith(PROMO_EVENTS.PROMO_CONTINUE_CARD_CAPTURED, {
        company_id: COMPANY_ID,
      });
      expect(mockToastSuccess).toHaveBeenCalled();
      // The prompt-shown event must NOT fire on a confirmation return.
      expect(track).not.toHaveBeenCalledWith(PROMO_EVENTS.PROMO_CONTINUE_PROMPT_SHOWN, {
        company_id: COMPANY_ID,
      });
      // The setup-intent params are stripped so a refresh doesn't re-confirm.
      expect(globalThis.location.search).toBe('');
    });

    it('F-B — a throwing track() call must not strand the redirect return on "Finishing up…" forever (the card is already persisted server-side)', async () => {
      vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_redirect');
      setReturnUrl('succeeded');
      mockRetrieveSetupIntent.mockResolvedValue({
        setupIntent: { id: 'seti_x', status: 'succeeded' },
      });
      const boom = new Error('posthog.capture blew up');
      vi.mocked(track).mockImplementationOnce(() => {
        throw boom;
      });

      // The throw escapes as an unhandled rejection by design (the hook does not, and must not,
      // swallow a callback's own throw) — swallow it here so this deliberately-thrown error
      // doesn't fail an unrelated test.
      const onUnhandledRejection = (reason: unknown): void => {
        expect(reason).toBe(boom);
      };
      process.once('unhandledRejection', onUnhandledRejection);

      render(<ContinueToMandate companyId={COMPANY_ID} />);

      // THE FIX: the phase must flip to "captured" even though the analytics call throws.
      expect(await screen.findByText(/set to keep going/i)).toBeInTheDocument();
      expect(screen.queryByText(/finishing up/i)).not.toBeInTheDocument();

      await new Promise((resolve) => setTimeout(resolve, 0));
      process.removeListener('unhandledRejection', onUnhandledRejection);
    });

    it('shows a finishing state while the SetupIntent is still processing', async () => {
      vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_redirect');
      setReturnUrl('processing');
      mockRetrieveSetupIntent.mockResolvedValue({
        setupIntent: { id: 'seti_x', status: 'processing' },
      });

      render(<ContinueToMandate companyId={COMPANY_ID} />);

      expect(await screen.findByText(/finishing up/i)).toBeInTheDocument();
      expect(track).not.toHaveBeenCalledWith(PROMO_EVENTS.PROMO_CONTINUE_CARD_CAPTURED, {
        company_id: COMPANY_ID,
      });
    });

    it('routes a failed SetupIntent to the warm retry state', async () => {
      vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_redirect');
      setReturnUrl('failed');
      mockRetrieveSetupIntent.mockResolvedValue({
        setupIntent: { id: 'seti_x', status: 'requires_payment_method' },
      });

      render(<ContinueToMandate companyId={COMPANY_ID} />);

      expect(await screen.findByText(/couldn't be confirmed/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add a card/i })).toBeInTheDocument();
    });

    it('skips the retrieve silently when the publishable key is unconfigured', async () => {
      vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', '');
      setReturnUrl('succeeded');

      render(<ContinueToMandate companyId={COMPANY_ID} />);

      expect(
        await screen.findByText(/add a card to keep going — no charge until then/i)
      ).toBeInTheDocument();
      expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
    });

    it('an unbound return is ignored — the prompt renders, no capture, no toast (security LOW)', async () => {
      vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_redirect');
      // Params set, nothing stored — a crafted link.
      globalThis.history.replaceState(
        {},
        '',
        '/redeem?setup_intent=seti_x&setup_intent_client_secret=seti_x_secret&redirect_status=succeeded'
      );

      render(<ContinueToMandate companyId={COMPANY_ID} />);

      expect(
        await screen.findByText(/add a card to keep going — no charge until then/i)
      ).toBeInTheDocument();
      expect(track).not.toHaveBeenCalledWith(PROMO_EVENTS.PROMO_CONTINUE_CARD_CAPTURED, {
        company_id: COMPANY_ID,
      });
      expect(mockToastSuccess).not.toHaveBeenCalled();
      expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
      expect(globalThis.location.search).toBe(
        '?setup_intent=seti_x&setup_intent_client_secret=seti_x_secret&redirect_status=succeeded'
      );
    });

    it('an unbound return still counts as a prompt render', async () => {
      vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_redirect');
      globalThis.history.replaceState(
        {},
        '',
        '/redeem?setup_intent=seti_x&setup_intent_client_secret=seti_x_secret&redirect_status=succeeded'
      );

      render(<ContinueToMandate companyId={COMPANY_ID} />);

      await screen.findByText(/add a card to keep going — no charge until then/i);
      expect(track).toHaveBeenCalledWith(PROMO_EVENTS.PROMO_CONTINUE_PROMPT_SHOWN, {
        company_id: COMPANY_ID,
      });
    });

    it('a bound return still suppresses the prompt-shown event', async () => {
      vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_redirect');
      setReturnUrl('succeeded');
      mockRetrieveSetupIntent.mockResolvedValue({
        setupIntent: { id: 'seti_x', status: 'succeeded' },
      });

      render(<ContinueToMandate companyId={COMPANY_ID} />);

      await screen.findByText(/set to keep going/i);
      expect(track).not.toHaveBeenCalledWith(PROMO_EVENTS.PROMO_CONTINUE_PROMPT_SHOWN, {
        company_id: COMPANY_ID,
      });
    });

    it('a null Stripe instance leaves the component on the warm retry state, never stuck on "Finishing up…" (bundled (a))', async () => {
      vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_redirect');
      setReturnUrl('succeeded');
      mockGetStripe.mockResolvedValueOnce(null);

      render(<ContinueToMandate companyId={COMPANY_ID} />);

      expect(await screen.findByText(/couldn't be confirmed/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add a card/i })).toBeInTheDocument();
      expect(screen.queryByText(/finishing up/i)).not.toBeInTheDocument();
    });

    it('a thrown retrieveSetupIntent leaves the component on the warm retry state, never stuck on "Finishing up…" (bundled (a))', async () => {
      vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_redirect');
      setReturnUrl('succeeded');
      mockRetrieveSetupIntent.mockRejectedValue(new Error('network blip'));

      render(<ContinueToMandate companyId={COMPANY_ID} />);

      expect(await screen.findByText(/couldn't be confirmed/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add a card/i })).toBeInTheDocument();
      expect(screen.queryByText(/finishing up/i)).not.toBeInTheDocument();
    });
  });
});
