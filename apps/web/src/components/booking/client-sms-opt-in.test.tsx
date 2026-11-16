import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';

const { mockGetState, mockSetConsent, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockGetState: vi.fn(),
  mockSetConsent: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: mockToastError } }));
vi.mock('@/lib/phone/client-sms-consent-actions', () => ({
  getClientSmsConsentStateAction: () => mockGetState(),
  setClientSmsConsentAction: (input: unknown) => mockSetConsent(input),
}));
vi.mock('@/components/balo/phone-verification-flow', () => ({
  PhoneVerificationFlow: ({
    audience,
    onVerified,
    onCancel,
  }: {
    audience?: string;
    onVerified: (e164: string) => void;
    onCancel?: () => void;
  }) => (
    <div data-testid="flow" data-audience={audience}>
      <button type="button" onClick={() => onVerified('+61406431059')}>
        Finish verify
      </button>
      <button type="button" onClick={onCancel}>
        Cancel flow
      </button>
    </div>
  ),
}));

import { track, PHONE_EVENTS } from '@/lib/analytics';
import { ClientSmsOptIn } from './client-sms-opt-in';

function renderCard(
  surface: 'booking_confirmation' | 'intro_call_confirmation' = 'booking_confirmation'
) {
  return render(<ClientSmsOptIn surface={surface} expertFirstName="Amara" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSetConsent.mockResolvedValue({ ok: true });
});

describe('ClientSmsOptIn', () => {
  it('shows a busy placeholder while the state loads', () => {
    mockGetState.mockReturnValue(new Promise(() => undefined));
    renderCard();
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading text alert options')).toBeInTheDocument();
    expect(track).not.toHaveBeenCalled();
  });

  it.each([
    ['unavailable', { status: 'unavailable' }],
    ['opted_in', { status: 'opted_in', phone: '+61406431059' }],
  ])('renders nothing and tracks nothing when %s', async (_name, state) => {
    mockGetState.mockResolvedValue(state);
    const { container } = renderCard();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(track).not.toHaveBeenCalled();
  });

  it('renders nothing when the state read rejects', async () => {
    mockGetState.mockRejectedValue(new Error('boom'));
    const { container } = renderCard();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('offers "Add my mobile" with no verified phone, and tracks shown once', async () => {
    mockGetState.mockResolvedValue({ status: 'not_opted_in', verifiedPhone: null });
    const { rerender } = renderCard('intro_call_confirmation');
    expect(await screen.findByText('Text me when Amara is ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add my mobile' })).toBeInTheDocument();
    rerender(<ClientSmsOptIn surface="intro_call_confirmation" expertFirstName="Amara" />);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(PHONE_EVENTS.CLIENT_SMS_OPT_IN_SHOWN, {
      surface: 'intro_call_confirmation',
      has_verified_phone: false,
    });
  });

  it('falls back to "your expert" without a first name', async () => {
    mockGetState.mockResolvedValue({ status: 'not_opted_in', verifiedPhone: null });
    render(<ClientSmsOptIn surface="booking_confirmation" expertFirstName={null} />);
    expect(await screen.findByText('Text me when your expert is ready')).toBeInTheDocument();
  });

  it('consents in one click on an already-verified number', async () => {
    const user = userEvent.setup();
    mockGetState.mockResolvedValue({ status: 'not_opted_in', verifiedPhone: '+61406431059' });
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Text me at +61 406 431 059' }));
    expect(mockSetConsent).toHaveBeenCalledWith({
      optedIn: true,
      surface: 'booking_confirmation',
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      "You're all set — we'll text +61 406 431 059."
    );
    expect(mockToastSuccess).toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(PHONE_EVENTS.CLIENT_SMS_OPT_IN_COMPLETED, {
      surface: 'booking_confirmation',
      method: 'existing_number',
    });
    expect(screen.queryByTestId('flow')).not.toBeInTheDocument();
  });

  it('falls back to the OTP flow when the one-click consent says the phone is not verified', async () => {
    const user = userEvent.setup();
    mockGetState.mockResolvedValue({ status: 'not_opted_in', verifiedPhone: '+61406431059' });
    mockSetConsent.mockResolvedValue({ ok: false, code: 'phone_not_verified' });
    renderCard();
    await user.click(await screen.findByRole('button', { name: /Text me at/ }));
    expect(await screen.findByTestId('flow')).toBeInTheDocument();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('opens the client OTP flow, then consents on verified', async () => {
    const user = userEvent.setup();
    mockGetState.mockResolvedValue({ status: 'not_opted_in', verifiedPhone: null });
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Add my mobile' }));
    expect(screen.getByTestId('flow')).toHaveAttribute('data-audience', 'client');
    await user.click(screen.getByRole('button', { name: 'Finish verify' }));
    expect(mockSetConsent).toHaveBeenCalledWith({
      optedIn: true,
      surface: 'booking_confirmation',
    });
    await waitFor(() =>
      expect(track).toHaveBeenCalledWith(PHONE_EVENTS.CLIENT_SMS_OPT_IN_COMPLETED, {
        surface: 'booking_confirmation',
        method: 'new_number',
      })
    );
  });

  it('"Use a different number" opens the flow, and cancelling returns to the offer', async () => {
    const user = userEvent.setup();
    mockGetState.mockResolvedValue({ status: 'not_opted_in', verifiedPhone: '+61406431059' });
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Use a different number' }));
    expect(screen.getByTestId('flow')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel flow' }));
    expect(screen.getByRole('button', { name: /Text me at/ })).toBeInTheDocument();
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('toasts and offers "Try again" when consent fails, retrying only the consent action', async () => {
    const user = userEvent.setup();
    mockGetState.mockResolvedValue({ status: 'not_opted_in', verifiedPhone: null });
    mockSetConsent.mockResolvedValueOnce({ ok: false, code: 'request_failed' });
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Add my mobile' }));
    await user.click(screen.getByRole('button', { name: 'Finish verify' }));
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(track).not.toHaveBeenCalledWith(
      PHONE_EVENTS.CLIENT_SMS_OPT_IN_COMPLETED,
      expect.anything()
    );

    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(mockSetConsent).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('flow')).not.toBeInTheDocument();
  });

  it('toasts when the consent action throws', async () => {
    const user = userEvent.setup();
    mockGetState.mockResolvedValue({ status: 'not_opted_in', verifiedPhone: '+61406431059' });
    mockSetConsent.mockRejectedValue(new Error('network'));
    renderCard();
    await user.click(await screen.findByRole('button', { name: /Text me at/ }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('"No thanks" hides the card and a rerender keeps it hidden', async () => {
    const user = userEvent.setup();
    mockGetState.mockResolvedValue({ status: 'not_opted_in', verifiedPhone: null });
    const { container, rerender } = renderCard();
    await user.click(await screen.findByRole('button', { name: 'No thanks' }));
    expect(container).toBeEmptyDOMElement();
    rerender(<ClientSmsOptIn surface="booking_confirmation" expertFirstName="Amara" />);
    expect(container).toBeEmptyDOMElement();
    expect(mockSetConsent).not.toHaveBeenCalled();
  });
});
