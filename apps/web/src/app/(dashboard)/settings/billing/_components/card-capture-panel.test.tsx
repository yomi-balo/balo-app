import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockStartCardCaptureAction, mockConfirmSetup } = vi.hoisted(() => ({
  mockStartCardCaptureAction: vi.fn(),
  mockConfirmSetup: vi.fn(),
}));

vi.mock('@/lib/credit/actions', () => ({
  startCardCaptureAction: (...a: unknown[]) => mockStartCardCaptureAction(...a),
}));
vi.mock('@/lib/stripe-loader', () => ({ getStripe: vi.fn(() => Promise.resolve({})) }));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmSetup: mockConfirmSetup }),
  useElements: () => ({}),
}));

import { CardCapturePanel } from './card-capture-panel';

const SETUP_INTENT_KEY = 'balo.stripe.setup-intent.v1';

beforeEach(() => {
  vi.clearAllMocks();
  // BAL-526 — jsdom persists sessionStorage across tests in a file.
  globalThis.sessionStorage.clear();
});

describe('CardCapturePanel', () => {
  it('shows the consent line and mounts the Payment Element once the start action resolves ok', async () => {
    mockStartCardCaptureAction.mockResolvedValue({
      ok: true,
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_settings',
      publishableKey: 'pk_test_abc',
    });

    render(<CardCapturePanel onCancel={vi.fn()} onCaptured={vi.fn()} />);

    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();
    // ⚠ THIS IS THE MANDATE DISCLOSURE OF RECORD — pin what it CLAIMS, not just that it renders.
    // The consent line must NOT condition charging on the client turning a card-backed mode on:
    // `setup_intent.succeeded` arms `mandate_status = 'active'` the moment the card is saved,
    // and grace entry + `settleOverdraft` gate on the MANDATE ALONE (the low-balance mode is read
    // only by the auto-top-up engine — see BAL-523). An earlier revision said "only if you turn
    // on Auto top-up or Keep me going", which was false the instant it rendered.
    const consent = screen.getByText(/This card won't be charged today/i);
    expect(consent).toHaveTextContent(/settle consultation time you use beyond your balance/i);
    expect(consent).not.toHaveTextContent(/only if you turn on/i);
    // Top-ups ARE mode-conditional — that half of the sentence is true and must stay.
    expect(consent).toHaveTextContent(/if you turn on Auto top-up/i);
    expect(screen.getByRole('button', { name: /save card/i })).toBeInTheDocument();
  });

  it('BAL-526: the ok start path binds the SetupIntent BEFORE Elements can mount', async () => {
    mockStartCardCaptureAction.mockResolvedValue({
      ok: true,
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_settings_bound',
      publishableKey: 'pk_test_abc',
    });

    render(<CardCapturePanel onCancel={vi.fn()} onCaptured={vi.fn()} />);

    await screen.findByTestId('payment-element');
    expect(globalThis.sessionStorage.getItem(SETUP_INTENT_KEY)).toBe('seti_settings_bound');
  });

  it('maps unconfigured to the fallback line and offers Cancel, never mounting Elements', async () => {
    mockStartCardCaptureAction.mockResolvedValue({ ok: false, error: 'unconfigured' });
    const onCancel = vi.fn();

    render(<CardCapturePanel onCancel={onCancel} onCaptured={vi.fn()} />);

    expect(
      await screen.findByText("Card payments aren't configured right now. Please try again later.")
    ).toBeInTheDocument();
    expect(screen.queryByTestId('payment-element')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('maps a generic start failure to the start-error message', async () => {
    mockStartCardCaptureAction.mockResolvedValue({ ok: false, error: 'error' });

    render(<CardCapturePanel onCancel={vi.fn()} onCaptured={vi.fn()} />);

    expect(await screen.findByText(/couldn't start card setup/i)).toBeInTheDocument();
  });

  it('maps settlement_outstanding to its own factual message, never the generic start-error line (fix round 2 G2)', async () => {
    mockStartCardCaptureAction.mockResolvedValue({ ok: false, error: 'settlement_outstanding' });
    const onCancel = vi.fn();

    render(<CardCapturePanel onCancel={onCancel} onCaptured={vi.fn()} />);

    expect(
      await screen.findByText(/unsettled consultation time in progress on this card/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/couldn't start card setup/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-element')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('confirmSetup error surfaces inline via role="alert", never a toast, and does not call onCaptured', async () => {
    mockStartCardCaptureAction.mockResolvedValue({
      ok: true,
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_settings',
      publishableKey: 'pk_test_abc',
    });
    mockConfirmSetup.mockResolvedValue({ error: { message: 'Your card was declined.' } });
    const onCaptured = vi.fn();

    render(<CardCapturePanel onCancel={vi.fn()} onCaptured={onCaptured} />);
    await userEvent.click(await screen.findByRole('button', { name: /save card/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Your card was declined.');
    expect(onCaptured).not.toHaveBeenCalled();
    // BAL-526 — a decline retries against the SAME SetupIntent; the binding must be kept.
    expect(globalThis.sessionStorage.getItem(SETUP_INTENT_KEY)).toBe('seti_settings');
  });

  it('A2 — confirmSetup return_url is origin+pathname ONLY, never the full URL, even when the address bar already carries a (crafted) setup_intent query string', async () => {
    globalThis.history.replaceState(
      {},
      '',
      '/settings/billing?setup_intent=seti_evil&setup_intent_client_secret=seti_evil_secret'
    );
    mockStartCardCaptureAction.mockResolvedValue({
      ok: true,
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_settings',
      publishableKey: 'pk_test_abc',
    });
    mockConfirmSetup.mockResolvedValue({});

    render(<CardCapturePanel onCancel={vi.fn()} onCaptured={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /save card/i }));

    expect(mockConfirmSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmParams: { return_url: 'http://localhost:3000/settings/billing' },
      })
    );
  });

  it('calls onCaptured on a successful confirmSetup with no error', async () => {
    mockStartCardCaptureAction.mockResolvedValue({
      ok: true,
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_settings',
      publishableKey: 'pk_test_abc',
    });
    mockConfirmSetup.mockResolvedValue({});
    const onCaptured = vi.fn();

    render(<CardCapturePanel onCancel={vi.fn()} onCaptured={onCaptured} />);
    await userEvent.click(await screen.findByRole('button', { name: /save card/i }));

    expect(onCaptured).toHaveBeenCalledTimes(1);
    // BAL-526 — `redirect: 'if_required'` took the non-redirect path: the writer clears its own
    // binding rather than leaving an orphan.
    expect(globalThis.sessionStorage.getItem(SETUP_INTENT_KEY)).toBeNull();
  });

  it('Cancel from the ready form calls onCancel with zero server calls beyond the initial start', async () => {
    mockStartCardCaptureAction.mockResolvedValue({
      ok: true,
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_settings',
      publishableKey: 'pk_test_abc',
    });
    const onCancel = vi.fn();

    render(<CardCapturePanel onCancel={onCancel} onCaptured={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mockStartCardCaptureAction).toHaveBeenCalledTimes(1);
  });
});
