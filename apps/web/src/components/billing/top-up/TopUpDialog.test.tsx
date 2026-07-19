import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WalletSnapshot } from './types';

// Control the responsive branch without matchMedia.
const mockUseIsMobile = vi.fn();
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mockUseIsMobile() }));

// Stub the heavy children so the launcher can be tested without Stripe / server actions.
vi.mock('./TopUpComposer', () => ({
  TopUpComposer: () => <div data-testid="composer">composer</div>,
}));
vi.mock('./MemberWalletNudge', () => ({
  MemberWalletNudge: () => <div data-testid="member-nudge">member nudge</div>,
}));

import { TopUpDialog } from './TopUpDialog';
import { TopUpLauncher } from './TopUpLauncher';

const WALLET: WalletSnapshot = {
  walletId: 'wallet-1',
  balanceMinor: 50_000,
  lowBalanceMode: 'keep_going',
  hasCard: false,
  topupReloadMinor: 30_000,
  topupThresholdMinor: 5_000,
};

describe('TopUpDialog / TopUpLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseIsMobile.mockReturnValue(false);
  });

  it('opens the composer in a Dialog on desktop', async () => {
    render(
      <TopUpDialog trigger={<button type="button">Top up</button>} wallet={WALLET} fx={null} />
    );
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Top up/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('composer')).toBeInTheDocument();
  });

  it('opens the composer in a Sheet on mobile', async () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <TopUpDialog trigger={<button type="button">Top up</button>} wallet={WALLET} fx={null} />
    );
    await userEvent.click(screen.getByRole('button', { name: /Top up/i }));
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
  });

  it('launches the composer for a MANAGE_BILLING holder', async () => {
    render(
      <TopUpLauncher
        trigger={<button type="button">Top up</button>}
        canManageBilling
        wallet={WALLET}
        fx={null}
        balanceMinor={50_000}
        adminLabel="Dana"
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /Top up/i }));
    expect(await screen.findByTestId('composer')).toBeInTheDocument();
    expect(screen.queryByTestId('member-nudge')).not.toBeInTheDocument();
  });

  it('launches the member nudge when the user lacks MANAGE_BILLING', async () => {
    render(
      <TopUpLauncher
        trigger={<button type="button">Balance</button>}
        canManageBilling={false}
        wallet={null}
        fx={null}
        balanceMinor={50_000}
        adminLabel="Dana"
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /Balance/i }));
    expect(await screen.findByTestId('member-nudge')).toBeInTheDocument();
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument();
  });
});
