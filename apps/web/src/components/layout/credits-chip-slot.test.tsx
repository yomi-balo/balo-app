import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

// Stub the client leaf so the slot test asserts only the data it hands down.
vi.mock('./credits-chip', () => ({
  CreditsChip: ({ balanceMinor, canTopUp }: { balanceMinor: number; canTopUp: boolean }) => (
    <div data-testid="chip">
      {balanceMinor}:{String(canTopUp)}
    </div>
  ),
}));

const mockLoad = vi.fn();
vi.mock('@/lib/credit/wallet-read', () => ({
  loadTopBarWalletData: (...a: unknown[]) => mockLoad(...a),
}));

import { log } from '@/lib/logging';
import { CreditsChipSlot } from './credits-chip-slot';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CreditsChipSlot', () => {
  it('resolves the read and renders the chip with the resolved data', async () => {
    mockLoad.mockResolvedValue({ balanceMinor: 42_000, canTopUp: true });

    const element = await CreditsChipSlot({ actorId: 'u-1', companyId: 'co-1' });
    if (element === null) throw new Error('expected a resolved chip element');
    render(element);

    expect(screen.getByTestId('chip')).toHaveTextContent('42000:true');
    expect(mockLoad).toHaveBeenCalledWith('u-1', 'co-1');
  });

  it('logs at the catch boundary and hides the chip (returns null) when the read throws', async () => {
    mockLoad.mockRejectedValue(new Error('boom'));

    const element = await CreditsChipSlot({ actorId: 'u-1', companyId: 'co-1' });

    expect(element).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      'Top-bar credits chip read failed',
      expect.objectContaining({ userId: 'u-1', companyId: 'co-1', error: 'boom' })
    );
  });
});
