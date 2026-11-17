import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';

const { mockRefresh, mockSetConsent, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockSetConsent: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));
vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: mockToastError } }));
vi.mock('@/lib/phone/client-sms-consent-actions', () => ({
  setClientSmsConsentAction: (input: unknown) => mockSetConsent(input),
}));
vi.mock('@/components/balo/phone-verification-flow', () => ({
  PhoneVerificationFlow: ({
    audience,
    initialPhone,
    onVerified,
    onCancel,
  }: {
    audience?: string;
    initialPhone?: string;
    onVerified: (e164: string) => void;
    onCancel?: () => void;
  }) => (
    <div data-testid="flow" data-audience={audience} data-initial={initialPhone ?? ''}>
      <button type="button" onClick={() => onVerified('+61411111111')}>
        Finish verify
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel}>
          Cancel flow
        </button>
      )}
    </div>
  ),
}));

import { track, PHONE_EVENTS } from '@/lib/analytics';
import { ClientSmsSection, type ClientSmsSectionProps } from './client-sms-section';

const PHONE = '+61406431059';

function renderSection(over: Partial<ClientSmsSectionProps> = {}) {
  return render(
    <ClientSmsSection verifiedPhone={PHONE} optedIn sharesExpertNumber={false} {...over} />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSetConsent.mockResolvedValue({ ok: true });
});

describe('ClientSmsSection', () => {
  describe('opted in', () => {
    it('shows the number with an On badge and no inline flow', () => {
      renderSection();
      expect(screen.getByRole('heading', { name: 'Text alerts' })).toBeInTheDocument();
      expect(screen.getByText('On')).toBeInTheDocument();
      expect(screen.getByText('+61 406 431 059')).toBeInTheDocument();
      expect(screen.queryByTestId('flow')).not.toBeInTheDocument();
    });

    it('Stop texts clears consent, toasts, tracks removed and refreshes', async () => {
      const user = userEvent.setup();
      renderSection();
      await user.click(screen.getByRole('button', { name: 'Stop texts' }));
      expect(mockSetConsent).toHaveBeenCalledWith({
        optedIn: false,
        surface: 'account_settings',
      });
      await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
      expect(mockToastSuccess).toHaveBeenCalledWith(
        'Text alerts are off. You can turn them back on any time.'
      );
      expect(track).toHaveBeenCalledWith(PHONE_EVENTS.CLIENT_SMS_OPT_IN_REMOVED, {
        surface: 'account_settings',
      });
    });

    it('a failed Stop texts toasts an error without tracking or refreshing', async () => {
      const user = userEvent.setup();
      mockSetConsent.mockResolvedValue({ ok: false, code: 'request_failed' });
      renderSection();
      await user.click(screen.getByRole('button', { name: 'Stop texts' }));
      await waitFor(() => expect(mockToastError).toHaveBeenCalled());
      expect(track).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('a throwing Stop texts toasts an error', async () => {
      const user = userEvent.setup();
      mockSetConsent.mockRejectedValue(new Error('network'));
      renderSection();
      await user.click(screen.getByRole('button', { name: 'Stop texts' }));
      await waitFor(() => expect(mockToastError).toHaveBeenCalled());
      expect(screen.getByRole('button', { name: 'Stop texts' })).toBeEnabled();
    });

    it('Change number mounts the client flow with the current number; verifying only refreshes', async () => {
      const user = userEvent.setup();
      renderSection();
      await user.click(screen.getByRole('button', { name: 'Change number' }));
      const flow = screen.getByTestId('flow');
      expect(flow).toHaveAttribute('data-audience', 'client');
      expect(flow).toHaveAttribute('data-initial', PHONE);

      await user.click(screen.getByRole('button', { name: 'Finish verify' }));
      expect(mockToastSuccess).toHaveBeenCalledWith('Number updated.');
      expect(mockRefresh).toHaveBeenCalled();
      expect(mockSetConsent).not.toHaveBeenCalled();
      expect(screen.queryByTestId('flow')).not.toBeInTheDocument();
    });

    it('cancelling Change number returns to the number view', async () => {
      const user = userEvent.setup();
      renderSection();
      await user.click(screen.getByRole('button', { name: 'Change number' }));
      await user.click(screen.getByRole('button', { name: 'Cancel flow' }));
      expect(screen.getByRole('button', { name: 'Stop texts' })).toBeInTheDocument();
    });
  });

  describe('verified but not opted in', () => {
    it('offers a one-click opt-in on the verified number', async () => {
      const user = userEvent.setup();
      renderSection({ optedIn: false });
      expect(screen.queryByText('On')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Text me at +61 406 431 059' }));
      expect(mockSetConsent).toHaveBeenCalledWith({
        optedIn: true,
        surface: 'account_settings',
      });
      await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
      expect(track).toHaveBeenCalledWith(PHONE_EVENTS.CLIENT_SMS_OPT_IN_COMPLETED, {
        surface: 'account_settings',
        method: 'existing_number',
      });
      expect(mockToastSuccess).toHaveBeenCalled();
    });

    it('a failed opt-in toasts an error and does not track completion', async () => {
      const user = userEvent.setup();
      mockSetConsent.mockResolvedValue({ ok: false, code: 'phone_not_verified' });
      renderSection({ optedIn: false });
      await user.click(screen.getByRole('button', { name: /Text me at/ }));
      await waitFor(() => expect(mockToastError).toHaveBeenCalled());
      expect(track).not.toHaveBeenCalled();
    });

    it('a throwing opt-in toasts an error', async () => {
      const user = userEvent.setup();
      mockSetConsent.mockRejectedValue(new Error('network'));
      renderSection({ optedIn: false });
      await user.click(screen.getByRole('button', { name: /Text me at/ }));
      await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    });

    it('"Use a different number" verifies a new number, then consents', async () => {
      const user = userEvent.setup();
      renderSection({ optedIn: false });
      await user.click(screen.getByRole('button', { name: 'Use a different number' }));
      expect(screen.getByTestId('flow')).toHaveAttribute('data-audience', 'client');
      await user.click(screen.getByRole('button', { name: 'Finish verify' }));
      await waitFor(() =>
        expect(track).toHaveBeenCalledWith(PHONE_EVENTS.CLIENT_SMS_OPT_IN_COMPLETED, {
          surface: 'account_settings',
          method: 'new_number',
        })
      );
    });

    it('a consent write failing after the new number verified leaves the flow and refreshes to the retry', async () => {
      mockSetConsent.mockResolvedValue({ ok: false, code: 'request_failed' });
      const user = userEvent.setup();
      renderSection({ optedIn: false });
      await user.click(screen.getByRole('button', { name: 'Use a different number' }));
      await user.click(screen.getByRole('button', { name: 'Finish verify' }));
      await waitFor(() => expect(mockToastError).toHaveBeenCalled());
      expect(mockRefresh).toHaveBeenCalled();
      expect(screen.queryByTestId('flow')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Text me at/ })).toBeInTheDocument();
      expect(track).not.toHaveBeenCalled();
    });

    it('cancelling the different-number flow returns to the offer', async () => {
      const user = userEvent.setup();
      renderSection({ optedIn: false });
      await user.click(screen.getByRole('button', { name: 'Use a different number' }));
      await user.click(screen.getByRole('button', { name: 'Cancel flow' }));
      expect(screen.getByRole('button', { name: /Text me at/ })).toBeInTheDocument();
    });
  });

  describe('no verified phone', () => {
    it('shows the inline flow and consents once a number is verified', async () => {
      const user = userEvent.setup();
      renderSection({ verifiedPhone: null, optedIn: false });
      expect(screen.getByTestId('flow')).toHaveAttribute('data-audience', 'client');
      await user.click(screen.getByRole('button', { name: 'Finish verify' }));
      expect(mockSetConsent).toHaveBeenCalledWith({
        optedIn: true,
        surface: 'account_settings',
      });
      await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    });
  });

  describe('shared expert number hint', () => {
    it('shows the hint only when the number is shared with the expert profile', () => {
      const { unmount } = renderSection({ sharesExpertNumber: true });
      expect(
        screen.getByText('This is also the number on your expert profile.')
      ).toBeInTheDocument();
      unmount();
      renderSection({ sharesExpertNumber: false });
      expect(
        screen.queryByText('This is also the number on your expert profile.')
      ).not.toBeInTheDocument();
    });
  });
});
