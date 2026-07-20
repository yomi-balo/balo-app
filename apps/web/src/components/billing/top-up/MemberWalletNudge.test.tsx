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
    render(<MemberWalletNudge balanceMinor={134_700} adminLabel="Sam" fx={null} />);
    expect(screen.getByText('A$1,347.00')).toBeInTheDocument();
    expect(screen.getByText(/Sam manages top-ups/i)).toBeInTheDocument();
    expect(screen.getByText(/start a consultation anytime/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers a low-balance nudge and confirms after sending', async () => {
    mockNudge.mockResolvedValue({ ok: true });
    render(<MemberWalletNudge balanceMinor={1_820} adminLabel="Sam" fx={null} />);

    const button = screen.getByRole('button', { name: /Nudge Sam to top up/i });
    // ≥44px tap target (balo-ui) on the interactive element itself.
    expect(button).toHaveClass('min-h-11');
    await userEvent.click(button);

    expect(mockNudge).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/We let Sam know/i)).toBeInTheDocument();
  });

  it('frames a used-up balance as asking the admin to top up', () => {
    render(<MemberWalletNudge balanceMinor={0} adminLabel="Sam" fx={null} />);
    expect(screen.getByText(/team's balance is used up/i)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /Ask Sam to top up/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass('min-h-11');
  });

  it('invokes onNudgeClick with the resting state on press (low)', async () => {
    mockNudge.mockResolvedValue({ ok: true });
    const onNudgeClick = vi.fn();
    render(
      <MemberWalletNudge
        balanceMinor={1_820}
        adminLabel="Sam"
        fx={null}
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
      <MemberWalletNudge balanceMinor={0} adminLabel="Sam" fx={null} onNudgeClick={onNudgeClick} />
    );

    await userEvent.click(screen.getByRole('button', { name: /Ask Sam to top up/i }));

    expect(onNudgeClick).toHaveBeenCalledWith('zero');
  });
});
