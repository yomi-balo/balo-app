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
    await userEvent.click(button);

    expect(mockNudge).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/We let Sam know/i)).toBeInTheDocument();
  });

  it('frames a used-up balance as asking the admin to top up', () => {
    render(<MemberWalletNudge balanceMinor={0} adminLabel="Sam" fx={null} />);
    expect(screen.getByText(/team's balance is used up/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ask Sam to top up/i })).toBeInTheDocument();
  });
});
