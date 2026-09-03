import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, SETTINGS_EVENTS } from '@/lib/analytics';
import type { LowBalanceDraft } from './low-balance-section';

const mockTrack = vi.mocked(track);

const mockSaveLowBalanceConfigAction = vi.fn();
const mockArmSavedCardMandateAction = vi.fn();
vi.mock('@/lib/credit/actions', () => ({
  saveLowBalanceConfigAction: (...a: unknown[]) => mockSaveLowBalanceConfigAction(...a),
  armSavedCardMandateAction: (...a: unknown[]) => mockArmSavedCardMandateAction(...a),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockHandleNextAction = vi.fn();
vi.mock('@/lib/stripe-loader', () => ({
  getStripe: vi.fn(() => Promise.resolve({ handleNextAction: mockHandleNextAction })),
}));

import { LowBalanceSection } from './low-balance-section';

const PREV_PK = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

function renderSection(
  overrides: {
    initialConfig?: LowBalanceDraft;
    cardAvailable?: boolean;
    cardLabel?: string | null;
    mandateActive?: boolean;
  } = {}
) {
  const props = {
    initialConfig: { mode: 'notify_only', reloadMinor: 10_000, thresholdMinor: 2_000 } as const,
    cardAvailable: true,
    cardLabel: 'Visa •••• 4242',
    mandateActive: true,
    ...overrides,
  };
  render(
    <LowBalanceSection
      initialConfig={props.initialConfig}
      cardAvailable={props.cardAvailable}
      cardLabel={props.cardLabel}
      mandateActive={props.mandateActive}
    />
  );
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTrack.mockClear();
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_settings';
});

afterEach(() => {
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = PREV_PK;
});

describe('LowBalanceSection', () => {
  it('disables Save until the form is dirty, then enables it on a mode change', async () => {
    renderSection({ mandateActive: true });
    const save = screen.getByRole('button', { name: /save changes/i });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByRole('radio', { name: /Keep me going/i }));
    expect(save).not.toBeDisabled();
  });

  it('blocks Save on a field error without ever calling the server', async () => {
    renderSection({
      initialConfig: { mode: 'notify_only', reloadMinor: 1_000, thresholdMinor: 2_000 },
      cardAvailable: true,
    });

    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    expect(screen.getByText(/Minimum top-up is/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(mockSaveLowBalanceConfigAction).not.toHaveBeenCalled();
  });

  it('on success (mandate already active) re-baselines, toasts, and tracks — Save disables again', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    renderSection({ mandateActive: true, cardAvailable: true });

    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Low-balance settings updated.')
    );
    expect(mockArmSavedCardMandateAction).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(SETTINGS_EVENTS.BILLING_LOW_BALANCE_SAVED, {
      mode: 'auto_topup',
    });
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('on failure, toasts the error and leaves the draft dirty (nothing reverts)', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: false, error: 'invalid_input' });
    renderSection({ mandateActive: true });

    await userEvent.click(screen.getByRole('radio', { name: /Keep me going/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("We couldn't save that — please try again.")
    );
    expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled();
    expect(screen.getByRole('radio', { name: /Keep me going/i })).toBeChecked();
  });

  it('a THROWN Save toasts the failure message (review MINOR) — previously silent', async () => {
    mockSaveLowBalanceConfigAction.mockRejectedValue(new Error('network blip'));
    renderSection({ mandateActive: true });

    await userEvent.click(screen.getByRole('radio', { name: /Keep me going/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("We couldn't save that — please try again.")
    );
    expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled();
  });

  it('a Save that does not need to arm clears an earlier arm warning, and Retry becomes unreachable (review IMPORTANT)', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    mockArmSavedCardMandateAction.mockResolvedValueOnce({ ok: false, error: 'failed' });
    renderSection({ mandateActive: false, cardAvailable: true });

    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await screen.findByText(/couldn't finish setting up automatic charging/i);

    // Switch away to a mode that does not need arming and save again.
    await userEvent.click(screen.getByRole('radio', { name: /Just notify me/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Low-balance settings updated.')
    );
    // The stale warning (and its now-dead Retry control) must not survive this Save.
    expect(
      screen.queryByText(/couldn't finish setting up automatic charging/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(mockArmSavedCardMandateAction).toHaveBeenCalledTimes(1);
  });

  it('fires onSaved with the persisted draft right after a successful Save (review CRITICAL — feeds the remove dialog)', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    const onSaved = vi.fn();
    render(
      <LowBalanceSection
        initialConfig={{ mode: 'notify_only', reloadMinor: 10_000, thresholdMinor: 2_000 }}
        cardAvailable={true}
        cardLabel="Visa •••• 4242"
        mandateActive={true}
        onSaved={onSaved}
      />
    );

    await userEvent.click(screen.getByRole('radio', { name: /Keep me going/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({
        mode: 'keep_going',
        reloadMinor: 10_000,
        thresholdMinor: 2_000,
      })
    );
  });

  it('does not arm when the outgoing mode is notify_only', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    renderSection({
      initialConfig: { mode: 'auto_topup', reloadMinor: 10_000, thresholdMinor: 2_000 },
      cardAvailable: true,
      mandateActive: false,
    });

    await userEvent.click(screen.getByRole('radio', { name: /Just notify me/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Low-balance settings updated.')
    );
    expect(mockArmSavedCardMandateAction).not.toHaveBeenCalled();
  });

  it('arms the mandate with a fresh uuid when card-backed + mandateActive is false, captured → mode toast + BILLING_MANDATE_ARMED', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    mockArmSavedCardMandateAction.mockResolvedValue({ ok: true, outcome: 'captured' });
    renderSection({ mandateActive: false, cardAvailable: true });

    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockArmSavedCardMandateAction).toHaveBeenCalledTimes(1));
    const [armCall] = mockArmSavedCardMandateAction.mock.calls;
    if (armCall === undefined) throw new Error('expected armSavedCardMandateAction to be called');
    const [armInput] = armCall as [{ clientRequestId: string }];
    expect(typeof armInput.clientRequestId).toBe('string');
    expect(armInput.clientRequestId.length).toBeGreaterThan(0);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Auto top-up turned on.'));
    expect(toast.success).not.toHaveBeenCalledWith('Low-balance settings updated.');
    expect(mockTrack).toHaveBeenCalledWith(SETTINGS_EVENTS.BILLING_MANDATE_ARMED, {
      mode: 'auto_topup',
    });
  });

  it('never arms when the card already has an active mandate', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    renderSection({ mandateActive: true, cardAvailable: true });

    await userEvent.click(screen.getByRole('radio', { name: /Keep me going/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Low-balance settings updated.')
    );
    expect(mockArmSavedCardMandateAction).not.toHaveBeenCalled();
  });

  it('requires_action → handleNextAction succeeded resolves to captured', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    mockArmSavedCardMandateAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'seti_secret',
    });
    mockHandleNextAction.mockResolvedValue({ setupIntent: { status: 'succeeded' } });
    renderSection({ mandateActive: false, cardAvailable: true });

    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Auto top-up turned on.'));
    expect(
      screen.queryByText(/couldn't finish setting up automatic charging/i)
    ).not.toBeInTheDocument();
  });

  it('requires_action → an abandoned challenge (no error, still requires_action) shows the inline warning, not captured', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    mockArmSavedCardMandateAction.mockResolvedValue({
      ok: true,
      outcome: 'requires_action',
      clientSecret: 'seti_secret',
    });
    mockHandleNextAction.mockResolvedValue({ setupIntent: { status: 'requires_action' } });
    renderSection({ mandateActive: false, cardAvailable: true });

    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await screen.findByText(/couldn't finish setting up automatic charging/i);
    expect(toast.success).not.toHaveBeenCalledWith('Auto top-up turned on.');
    expect(mockTrack).not.toHaveBeenCalledWith(
      SETTINGS_EVENTS.BILLING_MANDATE_ARMED,
      expect.anything()
    );
  });

  it('arm failure shows the inline warning + Retry, and Retry mints a NEW uuid', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    mockArmSavedCardMandateAction.mockResolvedValueOnce({ ok: false, error: 'failed' });
    renderSection({ mandateActive: false, cardAvailable: true });

    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await screen.findByText(/couldn't finish setting up automatic charging/i);
    expect(mockArmSavedCardMandateAction).toHaveBeenCalledTimes(1);

    mockArmSavedCardMandateAction.mockResolvedValueOnce({ ok: true, outcome: 'captured' });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(mockArmSavedCardMandateAction).toHaveBeenCalledTimes(2));
    const [firstEntry, secondEntry] = mockArmSavedCardMandateAction.mock.calls as Array<
      [{ clientRequestId: string }]
    >;
    if (firstEntry === undefined || secondEntry === undefined) {
      throw new Error('expected armSavedCardMandateAction to have been called twice');
    }
    const [firstCall] = firstEntry;
    const [secondCall] = secondEntry;
    expect(secondCall.clientRequestId).not.toBe(firstCall.clientRequestId);

    // The preference stayed saved even while the warning was showing — no failure toast fired.
    expect(toast.error).not.toHaveBeenCalled();
  });
});
