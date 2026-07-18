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

// Stub the Stripe SDK — Elements/PaymentElement render as plain nodes; `useStripe` returns
// the confirm mock (inline form path) and `loadStripe` resolves a Stripe instance carrying
// `retrieveSetupIntent` (the 3DS/SCA redirect-return path).
vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn(() =>
    Promise.resolve({
      confirmSetup: mockConfirmSetup,
      retrieveSetupIntent: mockRetrieveSetupIntent,
    })
  ),
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  globalThis.history.replaceState({}, '', '/');
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
      publishableKey: 'pk_test_abc',
    });
    const user = userEvent.setup();
    render(<ContinueToMandate companyId={COMPANY_ID} />);
    await user.click(screen.getByRole('button', { name: /add a card/i }));

    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save card/i })).toBeInTheDocument();
  });

  it('confirms the card and fires promo_continue_card_captured + a toast on success', async () => {
    mockStart.mockResolvedValue({
      status: 'ready',
      clientSecret: 'seti_secret',
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

  it('surfaces a card error inline without firing the captured event', async () => {
    mockStart.mockResolvedValue({
      status: 'ready',
      clientSecret: 'seti_secret',
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
    function setReturnUrl(status = 'succeeded'): void {
      globalThis.history.replaceState(
        {},
        '',
        `/redeem?setup_intent=seti_x&setup_intent_client_secret=seti_x_secret&redirect_status=${status}`
      );
    }

    it('confirms a succeeded SetupIntent on return — captured + toast, no exhausted event, URL cleaned', async () => {
      vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_redirect');
      setReturnUrl('succeeded');
      mockRetrieveSetupIntent.mockResolvedValue({ setupIntent: { status: 'succeeded' } });

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

    it('shows a finishing state while the SetupIntent is still processing', async () => {
      vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_redirect');
      setReturnUrl('processing');
      mockRetrieveSetupIntent.mockResolvedValue({ setupIntent: { status: 'processing' } });

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
        setupIntent: { status: 'requires_payment_method' },
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
  });
});
