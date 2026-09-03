import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, SETTINGS_EVENTS } from '@/lib/analytics';
import type { WalletSnapshot } from '@/components/billing/top-up/types';

const mockPush = vi.fn();
const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh, back: vi.fn() }),
}));

const mockRemoveSavedCardAction = vi.fn();
const mockSaveLowBalanceConfigAction = vi.fn();
const mockArmSavedCardMandateAction = vi.fn();
const mockStartCardCaptureAction = vi.fn();
vi.mock('@/lib/credit/actions', () => ({
  removeSavedCardAction: (...a: unknown[]) => mockRemoveSavedCardAction(...a),
  saveLowBalanceConfigAction: (...a: unknown[]) => mockSaveLowBalanceConfigAction(...a),
  armSavedCardMandateAction: (...a: unknown[]) => mockArmSavedCardMandateAction(...a),
  startCardCaptureAction: (...a: unknown[]) => mockStartCardCaptureAction(...a),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/stripe-loader', () => ({ getStripe: vi.fn(() => Promise.resolve(null)) }));

const mockTrack = vi.mocked(track);

import { BillingSettingsSections } from './billing-settings-sections';

const WALLET: WalletSnapshot = {
  walletId: 'wallet-1',
  balanceMinor: 5_000,
  lowBalanceMode: 'auto_topup',
  savedCard: { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028, mandateActive: true },
  topupReloadMinor: 10_000,
  topupThresholdMinor: 2_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTrack.mockClear();
});

describe('BillingSettingsSections', () => {
  it('reconciled removal repaints the card to empty AND the picker to the response mode, sourced from the action response — never local optimism', async () => {
    mockRemoveSavedCardAction.mockResolvedValue({
      ok: true,
      lowBalanceMode: 'notify_only',
      modeReconciled: true,
    });

    render(<BillingSettingsSections wallet={WALLET} />);

    // Before removal: Auto top-up selected (the wallet's real mode), card present.
    expect(screen.getByRole('radio', { name: /Auto top-up/i })).toBeChecked();
    expect(screen.getByText('Visa •••• 4242')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove card & switch to Just notify me' })
    );

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Just notify me/i })).toBeChecked()
    );
    expect(screen.getByRole('radio', { name: /Auto top-up/i })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /add a card/i })).toBeInTheDocument();
    expect(screen.queryByText('Visa •••• 4242')).not.toBeInTheDocument();

    expect(toast.success).toHaveBeenCalledWith("Card removed — you're now on Just notify me.");
    expect(mockTrack).toHaveBeenCalledWith(SETTINGS_EVENTS.BILLING_CARD_REMOVED, {
      mode_reconciled: true,
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('repaints to the ACTUAL response mode, not a hardcoded notify_only — mutant-killing case (review IMPORTANT)', async () => {
    // `keep_going` + `modeReconciled: true` is not a realistic server outcome (a real
    // reconciliation always lands on `notify_only`) — it is chosen so ONLY reading the real
    // response value can produce this render. A hardcoded-`notify_only` implementation of
    // `handleRemoved` would still make every other test in this file pass; only this one fails.
    mockRemoveSavedCardAction.mockResolvedValue({
      ok: true,
      lowBalanceMode: 'keep_going',
      modeReconciled: true,
    });

    render(<BillingSettingsSections wallet={WALLET} />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove card & switch to Just notify me' })
    );

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Keep me going/i })).toBeChecked()
    );
    expect(screen.getByRole('radio', { name: /Just notify me/i })).not.toBeChecked();
  });

  it('after an in-session Save, the remove dialog states the CURRENT mode consequence — never the stale page-load mode (review CRITICAL / UX C1)', async () => {
    mockSaveLowBalanceConfigAction.mockResolvedValue({ ok: true });
    const wallet: WalletSnapshot = { ...WALLET, lowBalanceMode: 'notify_only' };

    render(<BillingSettingsSections wallet={wallet} />);

    expect(screen.getByRole('radio', { name: /Just notify me/i })).toBeChecked();

    await userEvent.click(screen.getByRole('radio', { name: /Auto top-up/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Low-balance settings updated.')
    );

    // Before this fix, the dialog read `wallet.lowBalanceMode` (still `notify_only` here) and
    // showed the NO-CONSEQUENCE branch + the plain "Remove card" button, right before the server
    // would silently reconcile the mode on confirm.
    await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
    expect(
      await screen.findByRole('button', { name: 'Remove card & switch to Just notify me' })
    ).toBeInTheDocument();
  });

  it('a card re-added after a removal renders once server truth catches up — cardRemoved resets, never stuck at null (UX C2)', async () => {
    mockRemoveSavedCardAction.mockResolvedValue({
      ok: true,
      lowBalanceMode: 'notify_only',
      modeReconciled: true,
    });

    const { rerender } = render(<BillingSettingsSections wallet={WALLET} />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove card & switch to Just notify me' })
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /add a card/i })).toBeInTheDocument()
    );

    // Removal's OWN `router.refresh()` lands first — always resolving to `savedCard: null`,
    // since the detach already committed server-side before `handleRemoved` ever ran. This must
    // NOT be mistaken for "nothing changed, stay stuck": it's the removal settling, not a re-add.
    const walletAfterRemoval: WalletSnapshot = {
      ...WALLET,
      lowBalanceMode: 'notify_only',
      savedCard: null,
    };
    rerender(<BillingSettingsSections wallet={walletAfterRemoval} />);
    expect(screen.getByRole('button', { name: /add a card/i })).toBeInTheDocument();

    // A LATER Add flow completes — even a card that happens to share the exact same brand/last4
    // as the one just removed must still render (value comparison alone cannot tell these apart).
    const walletWithNewCard: WalletSnapshot = {
      ...WALLET,
      lowBalanceMode: 'notify_only',
      savedCard: {
        brand: 'mastercard',
        last4: '1111',
        expMonth: 3,
        expYear: 2030,
        mandateActive: false,
      },
    };
    rerender(<BillingSettingsSections wallet={walletWithNewCard} />);

    expect(await screen.findByText('Mastercard •••• 1111')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add a card/i })).not.toBeInTheDocument();
  });

  it('a non-reconciled removal (already notify_only) shows the plain toast and never touches the mode', async () => {
    mockRemoveSavedCardAction.mockResolvedValue({
      ok: true,
      lowBalanceMode: 'notify_only',
      modeReconciled: false,
    });
    const wallet: WalletSnapshot = { ...WALLET, lowBalanceMode: 'notify_only' };

    render(<BillingSettingsSections wallet={wallet} />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove card' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Card removed.'));
    expect(mockTrack).toHaveBeenCalledWith(SETTINGS_EVENTS.BILLING_CARD_REMOVED, {
      mode_reconciled: false,
    });
    expect(screen.getByRole('radio', { name: /Just notify me/i })).toBeChecked();
    expect(screen.getByRole('button', { name: /add a card/i })).toBeInTheDocument();
  });

  it('a removal failure leaves both sections untouched — nothing local changes', async () => {
    mockRemoveSavedCardAction.mockResolvedValue({ ok: false, error: 'error' });

    render(<BillingSettingsSections wallet={WALLET} />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove card & switch to Just notify me' })
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("We couldn't remove that card — please try again.")
    );
    expect(mockTrack).not.toHaveBeenCalledWith(
      SETTINGS_EVENTS.BILLING_CARD_REMOVED,
      expect.anything()
    );
    // The confirm dialog stays open on failure (design: "nothing local changes") — Radix marks
    // the rest of the page `aria-hidden` while it's open, so the background radiogroup needs
    // `hidden: true` to be queryable at all here; that aria-hidden-ness is itself proof the
    // dialog never closed.
    expect(screen.getByText('Visa •••• 4242')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Auto top-up/i, hidden: true })).toBeChecked();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('does NOT reset cardRemoved on the FIRST wallet update after a removal even if that update still carries a non-null card — pins skipNextWalletUpdateRef over a naive value check (fix round 2 G4)', async () => {
    // See the coordinator's docblock: the ref unconditionally eats exactly ONE wallet update
    // after a removal, regardless of what it carries, because that update is attributed to the
    // removal's OWN refresh (guaranteed server-side to be `savedCard: null` in practice). A
    // naive `cardRemoved && wallet.savedCard !== null` check — with no ref at all — cannot make
    // that distinction and would wrongly un-hide the card the instant a non-null snapshot
    // arrives. This test pins the ref's actual (unconditional-skip) behaviour so that
    // simplification cannot silently regress removal's local optimism.
    mockRemoveSavedCardAction.mockResolvedValue({
      ok: true,
      lowBalanceMode: 'notify_only',
      modeReconciled: true,
    });

    const { rerender } = render(<BillingSettingsSections wallet={WALLET} />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove card & switch to Just notify me' })
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /add a card/i })).toBeInTheDocument()
    );

    // The FIRST post-removal refresh — attributed to removal's own `router.refresh()` — still
    // names the OLD card (an edge case: e.g. a stale read). The ref must skip it regardless.
    const staleFirstRefresh: WalletSnapshot = { ...WALLET, lowBalanceMode: 'notify_only' };
    rerender(<BillingSettingsSections wallet={staleFirstRefresh} />);
    expect(screen.getByRole('button', { name: /add a card/i })).toBeInTheDocument();
    expect(screen.queryByText('Visa •••• 4242')).not.toBeInTheDocument();

    // A SECOND update (any content) is no longer skipped — a genuinely re-added card renders.
    const genuinelyNewCard: WalletSnapshot = {
      ...WALLET,
      lowBalanceMode: 'notify_only',
      savedCard: {
        brand: 'mastercard',
        last4: '1111',
        expMonth: 3,
        expYear: 2030,
        mandateActive: false,
      },
    };
    rerender(<BillingSettingsSections wallet={genuinelyNewCard} />);
    expect(await screen.findByText('Mastercard •••• 1111')).toBeInTheDocument();
  });

  it('remounts when keyed to the owning company, so a workspace switch never leaks a stale mode into the remove dialog — pins the page.tsx `key={user.companyId}` fix (review NEW-1, fix round 2 G1)', async () => {
    // `settings/billing/page.tsx` renders `<BillingSettingsSections key={user.companyId} .../>`.
    // The workspace switcher is a bare `router.refresh()` on the SAME route — no full reload —
    // so ONLY the `key` forces a remount across a switch. This wrapper mimics that call site
    // exactly (key derived from the owning party, changed the same way a switch would change
    // it) to prove the coordinator's `savedConfig`/`currentMode` never survive into a different
    // company's wallet. Proven during authorship: dropping the `key` prop below reproduces
    // review's exact failure — the confirm button still reads Company A's mode after the
    // Company B rerender.
    function Wrapper({
      companyId,
      wallet,
    }: Readonly<{ companyId: string; wallet: WalletSnapshot }>): React.JSX.Element {
      return <BillingSettingsSections key={companyId} wallet={wallet} />;
    }

    const companyAWallet: WalletSnapshot = {
      walletId: 'wallet-a',
      balanceMinor: 5_000,
      lowBalanceMode: 'notify_only',
      savedCard: { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028, mandateActive: true },
      topupReloadMinor: 10_000,
      topupThresholdMinor: 2_000,
    };
    const companyBWallet: WalletSnapshot = {
      walletId: 'wallet-b',
      balanceMinor: 9_000,
      lowBalanceMode: 'auto_topup',
      savedCard: {
        brand: 'mastercard',
        last4: '1111',
        expMonth: 3,
        expYear: 2030,
        mandateActive: true,
      },
      topupReloadMinor: 10_000,
      topupThresholdMinor: 2_000,
    };

    const { rerender } = render(<Wrapper companyId="company-a" wallet={companyAWallet} />);
    expect(screen.getByRole('radio', { name: /Just notify me/i })).toBeChecked();

    rerender(<Wrapper companyId="company-b" wallet={companyBWallet} />);

    // Company B is card-backed (`auto_topup`) — the dialog must state THAT consequence, never
    // Company A's stale `notify_only` no-consequence copy.
    await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
    expect(
      await screen.findByRole('button', { name: 'Remove card & switch to Just notify me' })
    ).toBeInTheDocument();
  });
});
