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

interface RenderSectionOverrides {
  initialConfig?: LowBalanceDraft;
  cardAvailable?: boolean;
  cardLabel?: string | null;
  mandateActive?: boolean;
  hasUnsettledOverdraft?: boolean;
}

function renderSection(overrides: RenderSectionOverrides = {}) {
  const props = {
    initialConfig: { mode: 'notify_only', reloadMinor: 10_000, thresholdMinor: 2_000 } as const,
    cardAvailable: true,
    cardLabel: 'Visa •••• 4242',
    mandateActive: true,
    // BAL-523 — defaults to false so every pre-existing (unrelated) case in this file takes the
    // no-note / generic-toast path unchanged; only the R1 block below opts in.
    hasUnsettledOverdraft: false,
    ...overrides,
  };
  const view = render(
    <LowBalanceSection
      initialConfig={props.initialConfig}
      cardAvailable={props.cardAvailable}
      cardLabel={props.cardLabel}
      mandateActive={props.mandateActive}
      hasUnsettledOverdraft={props.hasUnsettledOverdraft}
    />
  );
  return {
    ...props,
    /**
     * FIX ROUND (F3) — re-render the SAME mounted instance with a prop change, never a fresh
     * `render()`. `LowBalanceSection` is re-mounted by its parent's `key={reconcileNonce}` only
     * on a reconciled removal; a `cardAvailable` flip alone (the ordinary same-tab path this
     * component's F3 test pins) is an in-place prop update, so the test harness must exercise
     * exactly that — not a remount, which would trivially reset any dirty local state.
     */
    rerender: (nextOverrides: RenderSectionOverrides = {}) => {
      const nextProps = { ...props, ...nextOverrides };
      view.rerender(
        <LowBalanceSection
          initialConfig={nextProps.initialConfig}
          cardAvailable={nextProps.cardAvailable}
          cardLabel={nextProps.cardLabel}
          mandateActive={nextProps.mandateActive}
          hasUnsettledOverdraft={nextProps.hasUnsettledOverdraft}
        />
      );
    },
  };
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
    const save = screen.getByRole('button', { name: 'Save low-balance settings' });
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
    expect(screen.getByRole('button', { name: 'Save low-balance settings' })).toBeDisabled();
    expect(mockSaveLowBalanceConfigAction).not.toHaveBeenCalled();
  });

  it('on success (mandate already active) re-baselines, toasts, and tracks — Save disables again', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    renderSection({ mandateActive: true, cardAvailable: true });

    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Low-balance settings updated.')
    );
    expect(mockArmSavedCardMandateAction).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(SETTINGS_EVENTS.BILLING_LOW_BALANCE_SAVED, {
      mode: 'auto_topup',
    });
    expect(screen.getByRole('button', { name: 'Save low-balance settings' })).toBeDisabled();
  });

  it('on failure, toasts the error and leaves the draft dirty (nothing reverts)', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: false, error: 'invalid_input' });
    renderSection({ mandateActive: true });

    await userEvent.click(screen.getByRole('radio', { name: /Keep me going/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("We couldn't save that — please try again.")
    );
    expect(screen.getByRole('button', { name: 'Save low-balance settings' })).not.toBeDisabled();
    expect(screen.getByRole('radio', { name: /Keep me going/i })).toBeChecked();
  });

  // ── BAL-524 — the no_saved_card refusal ──────────────────────────────────────────────────

  it('no_saved_card renders the specific copy for keep_going, not "please try again"', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: false, error: 'no_saved_card' });
    // cardAvailable: true — the stale-tab shape: the page loaded with a card, the server no
    // longer sees one (removed in another tab between load and Save).
    renderSection({ cardAvailable: true, mandateActive: false });

    await userEvent.click(screen.getByRole('radio', { name: /Keep me going/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Keep me going needs a card on file.', {
        description: 'Add a card in the Payment method section below, then save this again.',
      })
    );
  });

  it('no_saved_card renders the specific copy for auto_topup', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: false, error: 'no_saved_card' });
    renderSection({ cardAvailable: true, mandateActive: false });

    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Auto top-up needs a card on file.', {
        description: 'Add a card in the Payment method section below, then save this again.',
      })
    );
  });

  it('a no_saved_card refusal does not fire the saved-analytics event, does not re-baseline, and never arms the mandate', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: false, error: 'no_saved_card' });
    renderSection({ cardAvailable: true, mandateActive: false });

    await userEvent.click(screen.getByRole('radio', { name: /Keep me going/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    expect(mockTrack).not.toHaveBeenCalledWith(
      SETTINGS_EVENTS.BILLING_LOW_BALANCE_SAVED,
      expect.anything()
    );
    expect(mockArmSavedCardMandateAction).not.toHaveBeenCalled();
    // The draft is never reverted — the shipped no-revert-on-failure posture.
    expect(screen.getByRole('radio', { name: /Keep me going/i })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save low-balance settings' })).not.toBeDisabled();
  });

  it('F3 — a mid-session card removal (cardAvailable flips true→false under a dirty card-backed draft) blocks Save client-side instead of letting it reach the server', async () => {
    const section = renderSection({
      initialConfig: { mode: 'notify_only', reloadMinor: 10_000, thresholdMinor: 2_000 },
      cardAvailable: true,
      mandateActive: false,
    });

    // An ordinary, unsaved edit — the saved mode is still notify_only.
    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    expect(screen.getByRole('button', { name: 'Save low-balance settings' })).not.toBeDisabled();

    // The card is removed in the SAME session (Payment method, below) — a RE-RENDER, not a
    // remount: the saved mode was notify_only, so nothing reconciles and `key={reconcileNonce}`
    // (the parent's remount trigger) never bumps. The dirty draft survives; only `cardAvailable`
    // changes, exactly as it would if the real parent re-rendered this same mounted instance.
    section.rerender({ cardAvailable: false });

    // Save is now BLOCKED — not silently reset, not left clickable to hit a refusal it could
    // have avoided entirely.
    expect(screen.getByRole('button', { name: 'Save low-balance settings' })).toBeDisabled();
    const inlineWarning = screen.getByText(/Auto top-up needs a card on file/i);
    expect(inlineWarning).toBeInTheDocument();
    // R2 (external review, BAL-524) — the INLINE warning must use its OWN copy, distinct from
    // the toast's ("...then save this again"), because nothing was submitted here: Save was
    // blocked before it ever reached the server.
    expect(inlineWarning).toHaveTextContent(
      'Add a card in the Payment method section below to use this setting.'
    );
    expect(inlineWarning).not.toHaveTextContent('then save this again');
    // The chosen mode is preserved — a silent reset would be worse than a blocked button.
    expect(screen.getByRole('radio', { name: /Auto top-up/i })).toBeChecked();
    expect(mockSaveLowBalanceConfigAction).not.toHaveBeenCalled();
  });

  it('a THROWN Save toasts the failure message (review MINOR) — previously silent', async () => {
    mockSaveLowBalanceConfigAction.mockRejectedValue(new Error('network blip'));
    renderSection({ mandateActive: true });

    await userEvent.click(screen.getByRole('radio', { name: /Keep me going/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("We couldn't save that — please try again.")
    );
    expect(screen.getByRole('button', { name: 'Save low-balance settings' })).not.toBeDisabled();
  });

  it('a Save that does not need to arm clears an earlier arm warning, and Retry becomes unreachable (review IMPORTANT)', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    mockArmSavedCardMandateAction.mockResolvedValueOnce({ ok: false, error: 'failed' });
    renderSection({ mandateActive: false, cardAvailable: true });

    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));
    await screen.findByText(/couldn't finish setting up automatic charging/i);

    // Switch away to a mode that does not need arming and save again.
    await userEvent.click(screen.getByRole('radio', { name: /Just notify me/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

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
        hasUnsettledOverdraft={false}
        onSaved={onSaved}
      />
    );

    await userEvent.click(screen.getByRole('radio', { name: /Keep me going/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

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
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

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
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

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
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

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
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

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
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

    await screen.findByText(/couldn't finish setting up automatic charging/i);
    expect(toast.success).not.toHaveBeenCalledWith('Auto top-up turned on.');
    expect(mockTrack).not.toHaveBeenCalledWith(
      SETTINGS_EVENTS.BILLING_MANDATE_ARMED,
      expect.anything()
    );
  });

  // ── R1 + R2 (BAL-523 FIX ROUND 2) — TRUTHFUL residual-settlement copy, re-gated ──────────
  //
  // ⚠ Round 1 shipped two FALSE strings here ("From here we'll pause instead of charging your
  // card" / "Just notify me means we'll pause rather than charge") and narrowed the gate onto
  // `hasUnsettledOverdraft` on the same false premise. Selecting Just notify me does NOT stop the
  // card being charged: the gate is in the live meter, every production Case session is
  // `durationSource: 'presence'`, and the presence finalizer posts every billable minute at
  // meeting end with no mode check and settles off-session (BAL-535).
  //
  // Every case below asserts the EXACT body text. A test that would pass on the false string is
  // not a test, and that is precisely how the false strings shipped.

  const RESIDUAL_TOAST_TITLE = 'Just notify me is on.';
  const TOAST_FACT =
    'Automatic top-ups are off. Time you use beyond your balance during a consultation is still settled to the card on file when it wraps up.';
  const NOTE_FACT =
    'Just notify me turns off automatic top-ups. Time you use beyond your balance during a consultation is still settled to the card on file when it wraps up.';
  const LEVER_REMOVE_CARD = ' Removing the card in Payment method below stops that.';
  const LEVER_REACH_OUT =
    " There's consultation time on your account still to settle — email support@balo.expert and we'll square it up with you.";

  const NOTE_REMOVABLE = NOTE_FACT + LEVER_REMOVE_CARD;
  const NOTE_EXPOSURE = NOTE_FACT + LEVER_REACH_OUT;

  async function switchToNotifyOnlyAndSave(): Promise<void> {
    await userEvent.click(screen.getByRole('radio', { name: /Just notify me/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));
  }

  it('⚠ R2: Save success on notify_only + card + live mandate shows the residual-settlement toast even with NO exposure — the re-gate this round restores', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    renderSection({
      initialConfig: { mode: 'auto_topup', reloadMinor: 10_000, thresholdMinor: 2_000 },
      mandateActive: true,
      cardAvailable: true,
      hasUnsettledOverdraft: false,
    });

    await switchToNotifyOnlyAndSave();

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(RESIDUAL_TOAST_TITLE, {
        description: TOAST_FACT + LEVER_REMOVE_CARD,
      })
    );
    expect(toast.success).not.toHaveBeenCalledWith('Low-balance settings updated.');
  });

  it('⚠ R2: with unsettled exposure the SAME toast names a channel instead of card removal', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    renderSection({
      initialConfig: { mode: 'auto_topup', reloadMinor: 10_000, thresholdMinor: 2_000 },
      mandateActive: true,
      cardAvailable: true,
      hasUnsettledOverdraft: true,
    });

    await switchToNotifyOnlyAndSave();

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(RESIDUAL_TOAST_TITLE, {
        description: TOAST_FACT + LEVER_REACH_OUT,
      })
    );
    // Removal is the case most likely to be refused here, so it must NOT be pointed at.
    expect(toast.success).not.toHaveBeenCalledWith(RESIDUAL_TOAST_TITLE, {
      description: TOAST_FACT + LEVER_REMOVE_CARD,
    });
  });

  it('⚠⚠ R1: NO surface claims a pause or a no-charge — the exact false strings this round removed', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    renderSection({
      initialConfig: { mode: 'auto_topup', reloadMinor: 10_000, thresholdMinor: 2_000 },
      mandateActive: true,
      cardAvailable: true,
      hasUnsettledOverdraft: true,
    });

    await switchToNotifyOnlyAndSave();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    // ⚠ JSON.stringify, NOT `.map(String)` — the description rides in the second argument's
    // `{ description }` object, which `String()` flattens to "[object Object]" and would let the
    // false string through untouched. That near-miss is exactly this round's failure mode.
    const toastCopy = JSON.stringify(vi.mocked(toast.success).mock.calls);
    const screenCopy = document.body.textContent ?? '';
    for (const claim of [
      'pause instead of charging',
      "we'll pause rather than charge",
      'pause rather than charge',
    ]) {
      expect(toastCopy).not.toContain(claim);
      expect(screenCopy).not.toContain(claim);
    }
  });

  it('⚠ F3/R5: a settlement_outstanding refusal gets its OWN copy, never the generic "please try again"', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({
      ok: false,
      error: 'settlement_outstanding',
    });
    renderSection({
      initialConfig: { mode: 'keep_going', reloadMinor: 10_000, thresholdMinor: 2_000 },
      mandateActive: true,
      cardAvailable: true,
    });

    await switchToNotifyOnlyAndSave();

    // ⚠ R5 — NEUTRAL. `hasActiveSessionForWallet` also matches a `pending` session that never
    // connected and an ENDED session still settling, so "A consultation is still running." and
    // "the expert is paid for the time they're delivering" were false on two of three arms.
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("We're still finalising a consultation.", {
        description:
          "We'll keep your current setting until that's wrapped up. You can switch to Just notify me once it's done.",
      })
    );
    // A retry cannot fix this, so the retry copy must NOT fire.
    expect(toast.error).not.toHaveBeenCalledWith("We couldn't save that — please try again.");
  });

  it('F3: any OTHER save failure still shows the generic retry toast', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: false, error: 'invalid_input' });
    renderSection({
      initialConfig: { mode: 'keep_going', reloadMinor: 10_000, thresholdMinor: 2_000 },
    });

    await switchToNotifyOnlyAndSave();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("We couldn't save that — please try again.")
    );
    expect(toast.error).not.toHaveBeenCalledWith(
      "We're still finalising a consultation.",
      expect.anything()
    );
  });

  it('R2: the generic Save toast still fires for notify_only with an INACTIVE mandate', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    renderSection({
      initialConfig: { mode: 'auto_topup', reloadMinor: 10_000, thresholdMinor: 2_000 },
      mandateActive: false,
      cardAvailable: true,
    });

    await switchToNotifyOnlyAndSave();

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Low-balance settings updated.')
    );
    expect(toast.success).not.toHaveBeenCalledWith(RESIDUAL_TOAST_TITLE, expect.anything());
  });

  it('R2: the generic Save toast still fires for notify_only with NO card on file', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    renderSection({
      initialConfig: { mode: 'auto_topup', reloadMinor: 10_000, thresholdMinor: 2_000 },
      mandateActive: false,
      cardAvailable: false,
    });

    await switchToNotifyOnlyAndSave();

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Low-balance settings updated.')
    );
    expect(toast.success).not.toHaveBeenCalledWith(RESIDUAL_TOAST_TITLE, expect.anything());
  });

  it('⚠ R2: the inline note appears for notify_only + card + active mandate with NO exposure, and names card removal — VERBATIM', async () => {
    renderSection({
      initialConfig: { mode: 'notify_only', reloadMinor: 10_000, thresholdMinor: 2_000 },
      mandateActive: true,
      cardAvailable: true,
      hasUnsettledOverdraft: false,
    });
    expect(screen.getByText(NOTE_REMOVABLE)).toBeInTheDocument();
  });

  it('⚠ R2: with exposure the inline note names a channel instead of card removal — VERBATIM', async () => {
    renderSection({
      initialConfig: { mode: 'notify_only', reloadMinor: 10_000, thresholdMinor: 2_000 },
      mandateActive: true,
      cardAvailable: true,
      hasUnsettledOverdraft: true,
    });
    expect(screen.getByText(NOTE_EXPOSURE)).toBeInTheDocument();
    expect(screen.queryByText(NOTE_REMOVABLE)).not.toBeInTheDocument();
  });

  it('R2: the inline note is absent with no card on file', async () => {
    renderSection({
      initialConfig: { mode: 'notify_only', reloadMinor: 10_000, thresholdMinor: 2_000 },
      mandateActive: false,
      cardAvailable: false,
      hasUnsettledOverdraft: true,
    });
    expect(screen.queryByText(/still settled to the card on file/i)).not.toBeInTheDocument();
  });

  it('R2: the inline note is absent when the mandate is not active', async () => {
    renderSection({
      initialConfig: { mode: 'notify_only', reloadMinor: 10_000, thresholdMinor: 2_000 },
      mandateActive: false,
      cardAvailable: true,
      hasUnsettledOverdraft: true,
    });
    expect(screen.queryByText(/still settled to the card on file/i)).not.toBeInTheDocument();
  });

  it('R2: the inline note is absent for a card-backed mode, even with an active mandate + unsettled exposure', async () => {
    renderSection({
      initialConfig: { mode: 'auto_topup', reloadMinor: 10_000, thresholdMinor: 2_000 },
      mandateActive: true,
      cardAvailable: true,
      hasUnsettledOverdraft: true,
    });
    expect(screen.queryByText(/still settled to the card on file/i)).not.toBeInTheDocument();
  });

  it('R2: the note tracks a LIVE mode switch (draft, not baseline) before Save is even pressed', async () => {
    renderSection({
      initialConfig: { mode: 'auto_topup', reloadMinor: 10_000, thresholdMinor: 2_000 },
      mandateActive: true,
      cardAvailable: true,
      hasUnsettledOverdraft: false,
    });
    expect(screen.queryByText(NOTE_REMOVABLE)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /Just notify me/i }));
    expect(screen.getByText(NOTE_REMOVABLE)).toBeInTheDocument();
  });

  it('arm failure shows the inline warning + Retry, and Retry mints a NEW uuid', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    mockArmSavedCardMandateAction.mockResolvedValueOnce({ ok: false, error: 'failed' });
    renderSection({ mandateActive: false, cardAvailable: true });

    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save low-balance settings' }));

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
