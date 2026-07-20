import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

// Stub the client leaf so the slot test asserts only the data it hands down (kind).
vi.mock('./dashboard-wallet-card', () => ({
  DashboardWalletCard: ({ data }: { data: { kind: string } }) => (
    <div data-testid="wallet-card">{data.kind}</div>
  ),
}));

const mockLoad = vi.fn();
vi.mock('@/lib/credit/wallet-read', () => ({
  loadDashboardWalletData: (...a: unknown[]) => mockLoad(...a),
}));

import { log } from '@/lib/logging';
import { DashboardWalletSlot } from './dashboard-wallet-slot';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DashboardWalletSlot', () => {
  it('resolves the read and renders the card with the resolved data', async () => {
    mockLoad.mockResolvedValue({ kind: 'holder', balanceMinor: 100, fx: null });

    const element = await DashboardWalletSlot({ actor: { id: 'u-1' }, companyId: 'co-1' });
    render(element);

    expect(screen.getByTestId('wallet-card')).toHaveTextContent('holder');
    expect(mockLoad).toHaveBeenCalledWith({ id: 'u-1' }, 'co-1');
  });

  it('logs at the catch boundary and renders the error card when the read throws', async () => {
    mockLoad.mockRejectedValue(new Error('boom'));

    const element = await DashboardWalletSlot({ actor: { id: 'u-1' }, companyId: 'co-1' });
    render(element);

    expect(screen.getByTestId('wallet-card')).toHaveTextContent('error');
    expect(log.error).toHaveBeenCalledWith(
      'Dashboard wallet read failed',
      expect.objectContaining({ userId: 'u-1', companyId: 'co-1', error: 'boom' })
    );
  });
});
