import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockNudge = vi.fn();
vi.mock('@/lib/credit/actions', () => ({
  nudgeBillingAdminAction: (...a: unknown[]) => mockNudge(...a),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MemberWalletNudge } from './MemberWalletNudge';

describe('MemberWalletNudge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a healthy team balance with no nudge affordance', () => {
    render(
      <MemberWalletNudge balanceMinor={134_700} adminLabel="Sam" fx={null} hasEverHeldCredit />
    );
    expect(screen.getByText('A$1,347.00')).toBeInTheDocument();
    expect(screen.getByText(/Sam manages top-ups/i)).toBeInTheDocument();
    expect(screen.getByText(/start a consultation anytime/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers a low-balance nudge and confirms after sending', async () => {
    mockNudge.mockResolvedValue({ ok: true });
    render(<MemberWalletNudge balanceMinor={1_820} adminLabel="Sam" fx={null} hasEverHeldCredit />);

    const button = screen.getByRole('button', { name: /Nudge Sam to top up/i });
    // ≥44px tap target (balo-ui) on the interactive element itself.
    expect(button).toHaveClass('min-h-11');
    await userEvent.click(button);

    expect(mockNudge).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/We let Sam know/i)).toBeInTheDocument();
  });

  it('frames a used-up balance as asking the admin to top up', () => {
    render(<MemberWalletNudge balanceMinor={0} adminLabel="Sam" fx={null} hasEverHeldCredit />);
    expect(
      screen.getByText("Your team's balance is used up. Ask Sam to top up to start a consultation.")
    ).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /Ask Sam to top up/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass('min-h-11');
  });

  // ⚠ BAL-405 — a team whose wallet has never held credit had nothing to use up. The shipped copy
  // told every brand-new team its balance was "used up", which was simply untrue. The replacement
  // LEADS WITH THE ACTION, never with the absence (`balo-ui-skill`).
  it('frames a never-funded team by the action, not by the absence', () => {
    render(
      <MemberWalletNudge balanceMinor={0} adminLabel="Sam" fx={null} hasEverHeldCredit={false} />
    );
    expect(
      screen.getByText('Ask Sam to top up and your team can start a consultation.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/used up/i)).not.toBeInTheDocument();
    // The constructive action is identical on both arms — only the state sentence differs.
    expect(screen.getByRole('button', { name: /Ask Sam to top up/i })).toBeInTheDocument();
  });

  // BAL-405 item 3 — the holder widget and this nudge share ONE chrome constant, so the two
  // lenses read as one primitive in the dashboard / settings slot they alternate in.
  it('carries the shared wallet-card chrome (max-w-[380px]) on its root', () => {
    const { container } = render(
      <MemberWalletNudge balanceMinor={134_700} adminLabel="Sam" fx={null} hasEverHeldCredit />
    );
    expect(container.firstElementChild).toHaveClass('max-w-[380px]');
  });

  it('lets a passed className override the width cap', () => {
    const { container } = render(
      <MemberWalletNudge
        balanceMinor={134_700}
        adminLabel="Sam"
        fx={null}
        hasEverHeldCredit
        className="max-w-none"
      />
    );
    expect(container.firstElementChild).toHaveClass('max-w-none');
    expect(container.firstElementChild).not.toHaveClass('max-w-[380px]');
  });

  it.each([
    ['low', 1_820],
    ['zero', 0],
    ['healthy', 134_700],
  ])('renders the footer after the action on the %s state', (_state, balanceMinor) => {
    render(
      <MemberWalletNudge
        balanceMinor={balanceMinor}
        adminLabel="Sam"
        fx={null}
        hasEverHeldCredit
        footer={<a href="/redeem">Promo</a>}
      />
    );
    const footer = screen.getByRole('link', { name: 'Promo' });
    const action =
      screen.queryByRole('button') ?? screen.getByText(/start a consultation anytime/i);
    expect(action.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('invokes onNudgeClick with the resting state on press (low)', async () => {
    mockNudge.mockResolvedValue({ ok: true });
    const onNudgeClick = vi.fn();
    render(
      <MemberWalletNudge
        balanceMinor={1_820}
        adminLabel="Sam"
        fx={null}
        hasEverHeldCredit
        onNudgeClick={onNudgeClick}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /Nudge Sam to top up/i }));

    expect(onNudgeClick).toHaveBeenCalledWith('low');
    expect(mockNudge).toHaveBeenCalledTimes(1);
  });

  it('invokes onNudgeClick with "zero" on a used-up balance', async () => {
    mockNudge.mockResolvedValue({ ok: true });
    const onNudgeClick = vi.fn();
    render(
      <MemberWalletNudge
        balanceMinor={0}
        adminLabel="Sam"
        fx={null}
        hasEverHeldCredit
        onNudgeClick={onNudgeClick}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /Ask Sam to top up/i }));

    expect(onNudgeClick).toHaveBeenCalledWith('zero');
  });
});
