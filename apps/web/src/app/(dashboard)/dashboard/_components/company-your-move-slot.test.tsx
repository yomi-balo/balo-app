import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('./your-move', () => ({
  YourMove: ({
    data,
    workspaceType,
  }: {
    data: { kind: string; cards: unknown[] };
    workspaceType: string;
  }) => <div data-testid="your-move">{`${workspaceType}:${data.kind}:${data.cards.length}`}</div>,
}));

const mockLoad = vi.fn();
vi.mock('../_lib/load-client-your-move', () => ({
  loadClientYourMove: (...args: unknown[]) => mockLoad(...args),
}));

vi.mock('@/lib/logging', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { CompanyYourMoveSlot } from './company-your-move-slot';
import { log } from '@/lib/logging';
import type { SessionUser } from '@/lib/auth/session';

const USER = { id: 'u-1' } as SessionUser;
const PROPS = { user: USER, companyId: 'co-1', companyName: 'Northwind' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CompanyYourMoveSlot', () => {
  it('loads for the company and renders the company rail with the cards', async () => {
    mockLoad.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    render(await CompanyYourMoveSlot(PROPS));
    expect(mockLoad).toHaveBeenCalledWith({
      user: USER,
      companyId: 'co-1',
      companyName: 'Northwind',
    });
    expect(screen.getByTestId('your-move')).toHaveTextContent('company:ready:2');
  });

  it('renders the error state with no cards, and logs, when the read throws', async () => {
    mockLoad.mockRejectedValue(new Error('boom'));
    render(await CompanyYourMoveSlot(PROPS));
    expect(screen.getByTestId('your-move')).toHaveTextContent('company:error:0');
    expect(log.error).toHaveBeenCalledWith(
      'Dashboard your move read failed',
      expect.objectContaining({ userId: 'u-1', companyId: 'co-1', error: 'boom' })
    );
  });
});
